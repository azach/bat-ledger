const client = require('prom-client')
const BigNumber = require('bignumber.js')
const _ = require('underscore')
const listenerPrefix = `listeners:prometheus:`
const listenerChannel = `${listenerPrefix}${process.env.SERVICE}`

module.exports = Prometheus

const settlementBalanceKey = 'settlement:balance'
const settlementBalanceCounterKey = `${settlementBalanceKey}:counter`

module.exports = Prometheus

function Prometheus (config, runtime) {
  if (!(this instanceof Prometheus)) {
    return new Prometheus(config, runtime)
  }

  const { prometheus } = config
  if (!prometheus) return

  const { label: dyno } = prometheus
  this.config = prometheus
  this.register = new client.Registry()
  this.client = client
  this.runtime = runtime
  this.metrics = {}
  this.shared = {}
  this.listenerId = `${listenerPrefix}${dyno}`

  this.register.setDefaultLabels({ dyno })

  const timeout = 10000
  this.timeout = timeout
  setInterval(() => this.maintenance(), timeout)
  process.on('exit', () => {
    try {
      this.quit()
    } catch (e) {
      this.runtime.captureException(e)
    }
  })
  this.registerMetrics()
  this.registerMetrics = _.noop
}

Prometheus.prototype.cache = function () {
  const { runtime } = this
  const { cache, queue } = runtime
  return cache ? cache.cache : queue.config.client
}

Prometheus.prototype.maintenance = async function () {
  const { interval, timeout, client, register } = this
  this.interval = interval || client.collectDefaultMetrics({
    timeout,
    register
  })
  await this.merge()
}

Prometheus.prototype.duration = function (start) {
  const diff = process.hrtime(start)
  return Math.round((diff[0] * 1e9 + diff[1]) / 1000000)
}

Prometheus.prototype.quit = function () {
  clearInterval(this.interval)
}

Prometheus.prototype.allMetrics = async function () {
  const { client } = this
  const cache = this.cache()
  const keys = await cache.keysAsync(`${listenerChannel}.*`)
  const all = await cache.mgetAsync(keys)
  const metrics = all.map(JSON.parse)
  return client.AggregatorRegistry.aggregate(metrics)
}

Prometheus.prototype.registerMetrics = function () {
  const { client, register } = this
  const log2Buckets = client.exponentialBuckets(2, 2, 15)

  new client.Summary({ // eslint-disable-line
    registers: [register],
    name: 'http_request_duration_milliseconds',
    help: 'request duration in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status']
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'http_request_buckets_milliseconds',
    help: 'request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'uphold_request_buckets_milliseconds',
    help: 'uphold request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeVerify_request_buckets_milliseconds',
    help: 'anonize verify duration buckets in milliseconds',
    labelNames: ['erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeRegister_request_buckets_milliseconds',
    help: 'anonize register buckets in milliseconds',
    labelNames: ['erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'viewRefresh_request_buckets_milliseconds',
    help: 'postgres view refresh buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status', 'erred'],
    buckets: log2Buckets
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'settlement_balance_counter',
    help: 'a count up of the number of bat removed from the settlement wallet'
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'votes_issued_counter',
    help: 'ballots that were issued to the browser',
    labelNames: ['cohort']
  })
}

Prometheus.prototype.plugin = function () {
  const plugin = {
    register: (server, o, done) => {
      server.route({
        method: 'GET',
        path: '/metrics',
        handler: async (req, reply) => {
          await setMetrics(this)
          const registry = await this.allMetrics()
          const metrics = registry.metrics()
          reply(metrics).type('text/plain')
        }
      })

      server.ext('onRequest', (request, reply) => {
        request.prometheus = { start: process.hrtime() }
        reply.continue()
      })

      server.on('response', (response) => {
        const analysis = response._route._analysis
        const statusCode = response.response.statusCode
        let cardinality, method, params, path

        const duration = this.duration(response.prometheus.start)

        method = response.method.toLowerCase()
        params = _.clone(analysis.params)
        cardinality = params.length ? 'many' : 'one'
        path = analysis.fingerprint.split('/')
        for (let i = 0; i < path.length; i++) { if (path[i] === '?') path[i] = '{' + (params.shift() || '?') + '}' }
        path = path.join('/')

        const observables = {
          method,
          path,
          cardinality,
          status: statusCode || 0
        }
        this.getMetric('http_request_duration_milliseconds')
          .observe(observables, duration)

        this.getMetric('http_request_buckets_milliseconds')
          .observe(observables, duration)
      })

      this.maintenance()
      return done()
    }
  }

  plugin.register.attributes = {
    name: 'runtime-prometheus',
    version: '1.0.0'
  }

  return plugin
}

Prometheus.prototype.getMetric = function (name) {
  return this.register.getSingleMetric(name)
}

Prometheus.prototype.timedRequest = function (name, knownObs = {}) {
  const metric = this.getMetric(name)
  const start = process.hrtime()
  return (moreObs = {}) => {
    const duration = this.duration(start)
    const labels = Object.assign({}, knownObs, moreObs)
    metric.observe(labels, duration)
  }
}

Prometheus.prototype.publish = async function () {
  const { register, timeout, listenerId } = this
  // x2 for buffer
  const timeoutSeconds = (timeout / 1000) * 2
  const data = register.getMetricsAsJSON()
  const json = JSON.stringify(data)
  await this.cache().setAsync(listenerId, json, 'EX', timeoutSeconds)
}

Prometheus.prototype.merge = async function () {
  await this.publish()
  if (this.config.label.includes('.worker.')) {
    return
  }
  await this.ifFirstWebRun(() => autoUpdateMetrics(this.runtime))
}

Prometheus.prototype.ifFirstWebRun = async function (fn) {
  if (this.config.label === 'ledger.web.1') {
    // only write from one dyno
    await fn()
  }
}

async function autoUpdateMetrics (runtime) {
  await updateSettlementWalletMetrics(runtime)
}

async function setMetrics (context) {
  await context.ifFirstWebRun(() => setSettlementWalletMetrics(context.runtime))
}

async function setSettlementWalletMetrics (runtime) {
  const { prometheus } = runtime
  const metric = prometheus.getMetric('settlement_balance_counter')
  let counter = await prometheus.cache().getAsync(settlementBalanceCounterKey)
  if (counter === null) {
    return // hasn't been set yet
  }
  metric.reset()
  metric.inc(+counter)
}

async function updateSettlementWalletMetrics (runtime) {
  if (!runtime.wallet) {
    return // can't do anything without wallet
  }
  await pullSettlementWalletBalanceMetrics(runtime)
}

async function pullSettlementWalletBalanceMetrics (runtime) {
  const { prometheus } = runtime
  let current = null
  let last = await prometheus.cache().getAsync(settlementBalanceKey)
  if (!last) {
    // on start, restart, or cache expiration
    last = await getSettlementBalance(runtime)
    await setSettlementBalance(runtime, settlementBalanceKey, last.toString())
  } else {
    current = await getSettlementBalance(runtime)
    last = new BigNumber(last)
  }
  // if the settlement wallet is refilled,
  // current is not set (start or restart)
  // or the value expires in redis
  // then we reset this metric and set the value in redis again
  if (!current || current.greaterThan(last)) {
    current = last
  }
  const value = last.minus(current)
  await setSettlementBalance(runtime, settlementBalanceCounterKey, value.toString())
}

async function setSettlementBalance (runtime, key, value) {
  await runtime.prometheus.cache().setAsync([key, value, 'EX', 60 * 60])
}

async function getSettlementBalance (runtime) {
  const { wallet } = runtime
  const settlement = await wallet.getSettlementWallet()
  return new BigNumber(settlement.balance)
}
