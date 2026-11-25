import { pino } from 'pino'

export type Logger = pino.Logger

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: undefined,
    redact: ['*.session', '*.token', '*.apiKey', 'config.TG_SESSION', 'config.ANTHROPIC_API_KEY'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  })
}

export const silentLogger: Logger = pino({ level: 'silent' })
