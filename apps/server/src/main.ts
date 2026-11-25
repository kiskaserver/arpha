import { serve } from '@hono/node-server'
import { loadConfig } from './config'
import { createLogger } from './logger'
import { buildRuntime, type Ingest } from './runtime'

const config = loadConfig()
const logger = createLogger(
  config.LOG_LEVEL,
  config.NODE_ENV === 'development' && process.stdout.isTTY,
)

let ingest: Ingest | undefined
if (config.telegramEnabled && !config.DEMO_MODE) {
  const { TelegramIngest } = await import('./telegram/gramjs')
  ingest = new TelegramIngest({
    apiId: config.TG_API_ID!,
    apiHash: config.TG_API_HASH!,
    session: config.TG_SESSION!,
    channels: config.TG_CHANNELS,
    backfillMin: config.TG_BACKFILL_MIN,
    logger: logger.child({ mod: 'telegram' }),
  })
} else if (!config.DEMO_MODE) {
  logger.warn(
    'Telegram is not configured (TG_API_ID/TG_API_HASH/TG_SESSION/TG_CHANNELS) — ingestion disabled',
  )
}

const runtime = buildRuntime(config, logger, ingest ? { ingest } : {})
const server = serve(
  { fetch: runtime.app.fetch, port: config.PORT, hostname: config.HOST },
  (info) => {
    logger.info({ port: info.port, demo: config.DEMO_MODE }, 'arpha listening')
  },
)

// Third-party clients (GramJS) occasionally reject promises nobody awaits; log, don't die.
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))

runtime.start().catch((err) => {
  logger.error({ err }, 'startup failed')
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'shutting down')
    server.close()
    runtime
      .stop()
      .catch((err) => logger.error({ err }, 'shutdown error'))
      .finally(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  })
}
