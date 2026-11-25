import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1')

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined))

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATA_DIR: z.string().default('./data/runtime'),
  WEB_DIST: z.string().default('./apps/web/dist'),
  DEMO_MODE: bool,

  TG_API_ID: z.coerce.number().int().positive().optional(),
  TG_API_HASH: optionalString,
  TG_SESSION: optionalString,
  /** Comma/newline separated usernames (with or without @), t.me links or numeric ids. */
  TG_CHANNELS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(/[\s,]+/)
        .map((c) =>
          c
            .trim()
            .replace(/^https?:\/\/t\.me\//, '')
            .replace(/^@/, ''),
        )
        .filter(Boolean),
    ),
  TG_BACKFILL_MIN: z.coerce.number().int().min(0).max(180).default(30),
  /** One-time import of this many hours of channel history to learn routes (costs LLM tokens). */
  HISTORY_IMPORT_HOURS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(0),

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  ALERTS_IN_UA_TOKEN: optionalString,
  ALERTS_POLL_MS: z.coerce.number().int().min(20_000).default(30_000),

  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
})

export type Config = z.infer<typeof envSchema> & {
  telegramEnabled: boolean
  pushEnabled: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const c = parsed.data
  const telegramEnabled = Boolean(
    c.TG_API_ID && c.TG_API_HASH && c.TG_SESSION && c.TG_CHANNELS.length,
  )
  if (telegramEnabled && !c.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required when Telegram ingestion is configured')
  }
  return {
    ...c,
    telegramEnabled,
    pushEnabled: Boolean(c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY),
  }
}
