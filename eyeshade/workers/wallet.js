const BigNumber = require('bignumber.js')
const bson = require('bson')
const underscore = require('underscore')
const uuidV5 = require('uuid/v5')
const errors = require('../lib/errors')
const { votesId } = require('../lib/queries')
const { insertTransaction } = require('../lib/transaction')
const {
  BAT_FEE_ACCOUNT
} = process.env

exports.name = 'wallet'
exports.initialize = async (debug, runtime) => {
  await runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: {
        paymentId: '',
        address: '',
        provider: '',
        balances: {},
        keychains: {},
        paymentStamp: 0,

        // v2 and later
        altcurrency: '',

        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { paymentId: 1 } ],
      others: [ { provider: 1 }, { address: 1 }, { altcurrency: 1 }, { paymentStamp: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.database.get('contributions', debug),
      name: 'contributions',
      property: 'viewingId',
      empty: {
        viewingId: '',
        paymentId: '',
        address: '',
        paymentStamp: 0,
        surveyorId: '',
        // v1 only
        // satoshis: 0,

        // v2 and later
        altcurrency: '',
        probi: bson.Decimal128.POSITIVE_ZERO,
        mature: false,

        fee: bson.Decimal128.POSITIVE_ZERO,
        votes: 0,
        hash: '',
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { viewingId: 1 } ],
      others: [ { paymentId: 1 }, { address: 1 }, { paymentStamp: 1 }, { surveyorId: 1 }, { altcurrency: 1 }, { probi: 1 },
        { fee: 1 }, { votes: 1 }, { hash: 1 }, { timestamp: 1 }, { altcurrency: 1, probi: 1, votes: 1 },
        { mature: 1 } ]
    },
    {
      category: runtime.database.get('grants', debug),
      name: 'grants',
      property: 'grantId',
      empty: {
        grantId: '',

        promotionId: '',
        altcurrency: '',
        probi: '0',

        paymentId: '',

        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { grantId: 1 } ],
      others: [ { promotionId: 1 }, { altcurrency: 1 }, { probi: 1 },
        { paymentId: '' },
        { timestamp: 1 } ]
    }
  ])
}

exports.workers = {
/* sent by eyeshade GET /v1/accounts/collect-fees

  { queue: 'fees-report'
  , message:
    { itemLimit: 100
    }
  }
  */
  'fees-report':
    async (debug, runtime, payload) => {
      const client = await runtime.postgres.connect()
      const {
        itemLimit = -1
      } = payload
      try {
        const latestFeeTransaction = await getLatestFeeTx(client)
        const list = await runtime.wallet.getFees(async (transaction, end, results) => {
          if ((itemLimit !== -1 && results.length === itemLimit) ||
              (new Date(transaction.createdAt) < latestFeeTransaction.createdAt)) {
            return end()
          }
          try {
            await insertUpholdTx(client, transaction)
          } catch (e) {
            if (!errors.isConflict(e)) {
              throw e
            }
          }
          return transaction
        })
        return list
      } catch (e) {
        debug(e)
        runtime.captureException(e)
        throw e
      } finally {
        client.release()
      }
    },

  /* sent by ledger POST /v1/registrar/persona/{personaId}

    { queue               : 'persona-report'
    , message             :
      { paymentId         : '...'
      , provider          : 'bitgo'
      , address           : '...'
      , keychains         :
        { user            : { xpub: '...', encryptedXprv: '...' }
        , backup          : { xpub: '...', encryptedXprv: '...' }
        }

      , addresses         : { BTC: '...', ... ]
      , altcurrency       : 'BAT'
      , httpSigningPubKey :
      }
    }
 */
  'persona-report':
    async (debug, runtime, payload) => {
      const paymentId = payload.paymentId
      const wallets = runtime.database.get('wallets', debug)
      let state

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.extend({ paymentStamp: 0 }, underscore.omit(payload, [ 'paymentId' ]))
      }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })
    },

  /* sent by ledger POST /v1/surveyor/contribution
           ledger PATCH /v1/surveyor/contribution/{surveyorId}
           daily()

    { queue            : 'surveyor-report'
    , message          :
      { surveyorId     : '...'
      , surveyorType   : '...'
      , altcurrency    : '...'
      , probi          : ...
      , votes          : ...
      }
    }
 */
  'surveyor-report':
    async (debug, runtime, payload) => {
      const BATtoProbi = runtime.currency.alt2scale(payload.altcurrency)
      const { surveyorId } = payload
      const { postgres } = runtime

      const probi = payload.probi && new BigNumber(payload.probi.toString())
      const price = probi.dividedBy(BATtoProbi).dividedBy(payload.votes)

      await postgres.query('insert into surveyor_groups (id, price) values ($1, $2)', [ surveyorId, price.toString() ])
    },

  /* sent by PUT /v1/wallet/{paymentId}

    { queue              : 'contribution-report'
    , message            :
      { viewingId        : '...'
      , paymentId        : '...'
      , address          : '...'
      , paymentStamp     : ...
      , surveyorId       : '...'
      , altcurrency      : '...'
      , probi            : ...
      , fee              : ...
      , votes            : ...
      , hash             : '...'
      , cohort           : '...'
      }
    }
 */
  'contribution-report':
    async (debug, runtime, payload) => {
      const cohort = payload.cohort
      const paymentId = payload.paymentId
      const viewingId = payload.viewingId
      const contributions = runtime.database.get('contributions', debug)
      const wallets = runtime.database.get('wallets', debug)
      let state

      if (cohort && runtime.config.testingCohorts.includes(cohort)) {
        payload.probi = bson.Decimal128.fromString('0')
      } else {
        payload.probi = bson.Decimal128.fromString(payload.probi.toString())
      }
      payload.fee = bson.Decimal128.fromString(payload.fee.toString())
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.omit(payload, [ 'viewingId' ])
      }
      await contributions.update({ viewingId: viewingId }, state, { upsert: true })

      state.$set = { paymentStamp: payload.paymentStamp }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })
    },

  /* sent by PUT /v1/surveyor/viewing/{surveyorId}

{ queue           : 'voting-report'
, message         :
  { surveyorId    : '...'
  , publisher     : '...'
  }
}
 */
  'voting-report':
    async (debug, runtime, payload) => {
      const { publisher, surveyorId } = payload
      const cohort = payload.cohort || 'control'
      const { postgres } = runtime

      if (!publisher) throw new Error('no publisher specified')

      const surveyorQ = await postgres.query('select frozen from surveyor_groups where id = $1 limit 1;', [surveyorId])
      if (surveyorQ.rowCount !== 1) {
        throw new Error('surveyor does not exist')
      }
      if (!surveyorQ.rows[0].frozen) {
        const update = `
        insert into votes (id, cohort, tally, excluded, channel, surveyor_id) values ($1, $2, 1, $3, $4, $5)
        on conflict (id) do update set updated_at = current_timestamp, tally = votes.tally + 1;
        `
        await postgres.query(update, [
          votesId(publisher, cohort, surveyorId),
          cohort,
          runtime.config.testingCohorts.includes(cohort),
          publisher,
          surveyorId
        ])
      }
    },

  /* sent when the wallet balance updates

    { queue            : 'wallet-report'
    , message          :
      { paymentId      : '...'
      , balances       : { ... }
      }
    }
 */
  'wallet-report':
    async (debug, runtime, payload) => {
      const paymentId = payload.paymentId
      const wallets = runtime.database.get('wallets', debug)
      let state

      underscore.keys(payload.balances).forEach((key) => {
        payload.balances[key] = bson.Decimal128.fromString(payload.balances[key])
      })
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: { balances: payload.balances }
      }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })
    },

  /* sent by PUT /v1/grants/{paymentId}

{ queue           : 'grant-report'
, message         :
  { grantId       : '...'
  , promotionId   : '...'
  , altcurrency   : '...'
  , probi         : ...
  , paymentId     : '...'
  }
}
 */
  'grant-report':
    async (debug, runtime, payload) => {
      const grantId = payload.grantId
      const grants = runtime.database.get('grants', debug)
      let state

      payload.probi = bson.Decimal128.fromString(payload.probi)
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.omit(payload, [ 'grantId' ])
      }
      await grants.update({ grantId: grantId }, state, { upsert: true })
    },

  /* sent by PUT /v1/wallet/{paymentId} (if one or more grants are redeemed)

{ queue           : 'redeem-report'
, message         :
  { grantIds      : '...'
  , redeemed      : { ... }
  }
}
 */
  'redeem-report':
    async (debug, runtime, payload) => {
      const grantIds = payload.grantIds
      const grants = runtime.database.get('grants', debug)
      let state

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.omit(payload, [ 'grantIds' ])
      }
      await grants.update({ grantId: { $in: grantIds } }, state, { upsert: true })
    }
}

async function getLatestFeeTx (client) {
  const { rows } = await client.query(`
SELECT
  max(created_at) as "createdAt"
FROM transactions
WHERE
    from_account = $1
OR  to_account = $1;
`, [BAT_FEE_ACCOUNT])
  return rows[0]
}

function insertFee (client, options) {
  return insertTransaction(client, Object.assign({
    description: 'settlement fees',
    transactionType: 'fees',
    toAccount: 'fees-account',
    toAccountType: 'internal'
  }, options))
}

function insertUpholdTx (client, transaction) {
  const {
    id,
    destination,
    origin,
    createdAt
  } = transaction
  const {
    CardId: originCardId
  } = origin
  const {
    CardId: destinationCardId
  } = destination
  const fromAccountType = originCardId === BAT_FEE_ACCOUNT ? 'uphold' : 'internal'
  const toAccountType = destinationCardId === BAT_FEE_ACCOUNT ? 'uphold' : 'internal'
  const { amount } = origin
  const documentId = uuidV5(id, BAT_FEE_ACCOUNT)
  return insertFee(client, {
    id,
    amount,
    documentId,
    settlementCurrency: 'BAT',
    settlementAmount: amount,
    createdAt: (+(new Date(createdAt))) / 1000,
    toAccount: destinationCardId,
    toAccountType,
    fromAccountType,
    fromAccount: originCardId
  })
}
