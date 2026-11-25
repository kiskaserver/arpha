/**
 * Replays exported posts (pnpm tg:dump) through the full live pipeline —
 * real LLM, gazetteer, tracker — on a simulated clock, and prints what each
 * message turned into. The fastest way to judge quality on real data.
 *
 *   pnpm replay [--hours=3] [--channel=name] [--json=out.json]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bearingToCompassUk, predictPosition, type Track } from '@arpha/shared'
import { Store } from '../apps/server/src/db'
import { AnthropicExtractor } from '../apps/server/src/extract/anthropic'
import type { Extraction, ExtractionInput, RawMessage } from '../apps/server/src/extract/types'
import { Tracker } from '../apps/server/src/fusion/tracker'
import { Gazetteer, type PlaceRecord } from '../apps/server/src/geo/gazetteer'
import { Pipeline } from '../apps/server/src/ingest/pipeline'
import { createLogger } from '../apps/server/src/logger'

process.loadEnvFile?.('.env')
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const hours = Number(arg('hours') ?? 3)
const only = arg('channel')
const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, 'data/samples')

const all: RawMessage[] = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl') && (!only || f.startsWith(only)))
  .flatMap((f) =>
    readFileSync(resolve(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RawMessage),
  )
  .sort((a, b) => a.date - b.date)
const end = all.at(-1)?.date ?? 0
const messages = all.filter((m) => m.date >= end - hours * 3_600_000)
const byKey = new Map(all.map((m) => [`${m.channel}:${m.id}`, m]))

let clock = messages[0]?.date ?? 0
const tracker = new Tracker()
const real = new AnthropicExtractor({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  logger: createLogger('warn'),
})
let last: Extraction | null = null
const pipeline = new Pipeline({
  store: new Store(':memory:'),
  extractor: {
    async extract(input: ExtractionInput) {
      last = await real.extract(input)
      return last
    },
  },
  gazetteer: new Gazetteer(
    JSON.parse(readFileSync(resolve(root, 'data/gazetteer.json'), 'utf8')) as PlaceRecord[],
  ),
  tracker,
  source: { getMessage: async (c, id) => byKey.get(`${c}:${id}`) ?? null },
  logger: createLogger('warn'),
  concurrency: 1,
  now: () => clock,
})

const fmtTrack = (t: Track) => {
  const p = predictPosition(t, clock)
  const course =
    t.headingDeg === null ? '' : ` ${bearingToCompassUk(t.headingDeg)} ${t.speedKmh}км/г`
  return `${t.id}:${t.type}${t.count ? `×${t.count}` : ''}@${t.placeName ?? t.target?.name ?? '?'}${
    p ? `(${p.lat.toFixed(3)},${p.lon.toFixed(3)})` : ''
  }${course}${t.status === 'active' ? '' : ` [${t.status}]`}`
}

const log: unknown[] = []
console.log(`Replaying ${messages.length} messages over ${hours} h…\n`)
for (const m of messages) {
  clock = m.date + 20_000
  tracker.tick(clock)
  last = null
  await pipeline.submit(m).catch((e) => console.error('  ! ', (e as Error).message))
  const ex = last as Extraction | null
  const time = new Date(m.date).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
  const text = m.text.replace(/\s+/g, ' ').slice(0, 90)
  if (!ex) {
    console.log(
      `${time} ${m.channel.slice(0, 10).padEnd(10)} ${m.replyToId ? '↪' : ' '} ${text}  (skipped)`,
    )
    continue
  }
  const events = ex.events
    .map(
      (e) =>
        `${e.action}:${e.type}${e.location ? ` @${e.location}` : ''}${e.toward ? ` →${e.toward}` : ''}`,
    )
    .join('; ')
  console.log(
    `${time} ${m.channel.slice(0, 10).padEnd(10)} ${m.replyToId ? '↪' : ' '} ${text}\n${' '.repeat(20)}${
      ex.relevant ? events || '(relevant, no events)' : '—'
    }${ex.all_clear ? ' ALL CLEAR' : ''}`,
  )
  log.push({ message: m, extraction: ex, tracks: tracker.active().map(fmtTrack) })
}

console.log('\nActive tracks at the end:')
for (const t of tracker.tracks()) console.log(' ', fmtTrack(t), `src=${t.sources.length}`)
console.log('\nPipeline:', pipeline.stats)
const out = arg('json')
if (out) writeFileSync(out, JSON.stringify(log, null, 1))
