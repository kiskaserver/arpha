/**
 * Export recent posts of the configured channels to data/samples/*.jsonl
 * (git-ignored) — raw material for the extractor golden dataset.
 *
 *   pnpm tg:dump [limit=300]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Api, TelegramClient } from 'telegram'
import { LogLevel } from 'telegram/extensions/Logger'
import { StringSession } from 'telegram/sessions'
import { loadConfig } from '../apps/server/src/config'
import { channelKey, type GramMessageLike, toRawMessage } from '../apps/server/src/telegram/map'

process.loadEnvFile?.('.env')
const config = loadConfig()
if (!config.TG_API_ID || !config.TG_API_HASH || !config.TG_SESSION) {
  throw new Error('Set TG_API_ID, TG_API_HASH and TG_SESSION first (pnpm tg:login)')
}
const limit = Number(process.argv[2] ?? 300)
const out = resolve(import.meta.dirname, '../data/samples')
mkdirSync(out, { recursive: true })

const client = new TelegramClient(
  new StringSession(config.TG_SESSION),
  config.TG_API_ID,
  config.TG_API_HASH,
  {},
)
client.setLogLevel(LogLevel.ERROR)
await client.connect()

for (const ref of config.TG_CHANNELS) {
  const entity = await client.getEntity(ref)
  if (!(entity instanceof Api.Channel)) continue
  const info = { key: channelKey(entity.username ?? ref), title: entity.title }
  const lines: string[] = []
  for await (const m of client.iterMessages(entity, { limit })) {
    const raw = toRawMessage(m as unknown as GramMessageLike, info)
    if (raw.text.trim()) lines.push(JSON.stringify(raw))
  }
  writeFileSync(resolve(out, `${info.key}.jsonl`), `${lines.reverse().join('\n')}\n`)
  console.log(`${info.key}: ${lines.length} messages`)
}
await client.disconnect()
process.exit(0)
