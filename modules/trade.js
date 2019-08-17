'use strict';

const moment = require('moment');
const crypto = require('crypto');
const os = require('os');
const PositionStateChangeEvent = require('../event/position_state_change_event')

module.exports = class Trade {
    constructor(
        eventEmitter,
        instances,
        notify,
        logger,
        createOrderListener,
        tickListener,
        tickers,
        tickerDatabaseListener,
        exchangeOrderWatchdogListener,
        orderExecutor,
        pairStateExecution,
        systemUtil,
        logsRepository,
        tickerLogRepository,
        exchangePositionWatcher
    ) {
        this.eventEmitter = eventEmitter
        this.instances = instances
        this.notify = notify
        this.logger = logger
        this.createOrderListener = createOrderListener
        this.tickListener = tickListener
        this.tickers = tickers
        this.tickerDatabaseListener = tickerDatabaseListener
        this.exchangeOrderWatchdogListener = exchangeOrderWatchdogListener
        this.orderExecutor = orderExecutor
        this.pairStateExecution = pairStateExecution
        this.systemUtil = systemUtil
        this.logsRepository = logsRepository
        this.tickerLogRepository = tickerLogRepository
        this.exchangePositionWatcher = exchangePositionWatcher
    }

    start() {
        this.logger.debug('Trade module started')

        process.on('SIGINT', async () => {
            // force exit in any case
            setTimeout(() => {
                process.exit()
            }, 7500);

            await this.pairStateExecution.onTerminate()

            process.exit()
        });

        const instanceId = crypto.randomBytes(4).toString('hex');

        let notifyActivePairs = this.instances.symbols.filter((symbol) => {
            return symbol['state'] === 'watch';
        }).map((symbol) => {
            return symbol.exchange + '.' + symbol.symbol
        })

        let message = 'Start: ' + instanceId + ' - ' + os.hostname() + ' - ' + os.platform() + ' - ' + moment().format() + ' - ' + notifyActivePairs.join(', ');

        this.notify.send(message)

        let me = this
        let eventEmitter = this.eventEmitter

        // let the system bootup; eg let the candle be filled by exchanges
        setTimeout(() => {
            console.log('Trade module: warmup done; starting ticks')
            this.logger.info('Trade module: warmup done; starting ticks')

            setInterval(() => {
                eventEmitter.emit('tick', {})
            }, this.systemUtil.getConfig('tick.default', 20100))

            // order create tick
            setInterval(() => {
                eventEmitter.emit('signal_tick', {})
            }, this.systemUtil.getConfig('tick.signal', 10600))

            setInterval(() => {
                eventEmitter.emit('watchdog', {})
            }, this.systemUtil.getConfig('tick.watchdog', 30800))

            setInterval(() => {
                eventEmitter.emit('tick_ordering', {})
            }, this.systemUtil.getConfig('tick.ordering', 10800))
        }, this.systemUtil.getConfig('tick.warmup', 30000));

        // cronjob like tasks
        setInterval(async () => {
            await me.logsRepository.cleanOldLogEntries()
            await me.tickerLogRepository.cleanOldLogEntries()

            me.logger.debug('Logs: Cleanup old entries')
        }, 86455000)

        let tickers = this.tickers

        eventEmitter.on('ticker', async function(tickerEvent) {
            tickers.set(tickerEvent.ticker)
            me.tickerDatabaseListener.onTicker(tickerEvent)
        });

        eventEmitter.on('orderbook', function(orderbookEvent) {
            //console.log(orderbookEvent.orderbook)
        });

        eventEmitter.on('order', async (event) => me.createOrderListener.onCreateOrder(event))

        eventEmitter.on('tick', async () => {
            me.tickListener.onTick()
        })

        eventEmitter.on('watchdog', async () => {
            me.exchangeOrderWatchdogListener.onTick()
            await me.exchangePositionWatcher.onPositionStateChangeTick()
        })

        eventEmitter.on(PositionStateChangeEvent.EVENT_NAME, async event => {
            await me.exchangeOrderWatchdogListener.onPositionChanged(event)
        })

        let running = undefined
        eventEmitter.on('tick_ordering', async () => {
            if (typeof running === 'undefined' || running < moment().subtract(20, 'seconds')) {
                running = new Date()
                await me.pairStateExecution.onPairStateExecutionTick()
                await me.orderExecutor.adjustOpenOrdersPrice()
                running = undefined
            } else {
                me.logger.debug('tick_ordering still running')
            }
        })
    }
};