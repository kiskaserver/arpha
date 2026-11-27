/**
 * Runs the real LLM extractor against the labelled golden set and reports
 * accuracy. Exits non-zero below the threshold, so it can gate prompt changes.
 *
 *   ANTHROPIC_API_KEY=… pnpm eval [--threshold=0.9]
 *
 * Golden cases live in data/golden/*.json (see data/golden/README.md).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnthropicExtractor } from '../apps/server/src/extract/anthropic'
import type { ExtractionInput } from '../apps/server/src/extract/types'
import { Gazetteer, type PlaceRecord } from '../apps/server/src/geo/gazetteer'
import { createLogger } from '../apps/server/src/logger'

process.loadEnvFile?.('.env')

interface Expected {
  relevant: boolean
  all_clear?: boolean
  closures?: { object: string; status: 'closed' | 'open' }[]
  /** `place` accepts either location or toward ("на X" is genuinely ambiguous). */
  /** A field set to null must come back null ("Довернув на X" has no location). */
  events?: {
    type?: string
    action?: string
    location?: string | null
    toward?: string | null
    place?: string
    from?: string | null
    count?: number
    altitude_m?: number
  }[]
}
interface Case {
  name: string
  text: string
  parents?: string[]
  expected: Expected
}

const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, 'data/golden')
const threshold = Number(
  process.argv.find((a) => a.startsWith('--threshold='))?.split('=')[1] ?? 0.9,
)
const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Case[])

const gz = new Gazetteer(
  JSON.parse(readFileSync(resolve(root, 'data/gazetteer.json'), 'utf8')) as PlaceRecord[],
)
const extractor = new AnthropicExtractor({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
  logger: createLogger('warn'),
})

const samePlace = (a?: string | null, b?: string) =>
  !b || (a != null && gz.lookup(a)?.name === gz.lookup(b)?.name)

let score = 0
let total = 0
for (const c of cases) {
  const now = Date.now()
  const input: ExtractionInput = {
    message: {
      channel: 'golden',
      channelTitle: 'Golden',
      id: 1,
      date: now,
      editDate: null,
      text: c.text,
      replyToId: c.parents ? 0 : null,
    },
    parents: (c.parents ?? []).map((text) => ({ text, date: now - 120_000, trackIds: [] })),
    activeTracks: [],
    now,
  }
  const got = await extractor.extract(input)
  const checks: boolean[] = [got.relevant === c.expected.relevant]
  if (c.expected.all_clear !== undefined) checks.push(got.all_clear === c.expected.all_clear)
  for (const want of c.expected.closures ?? []) {
    checks.push(
      got.closures.some((x) => x.status === want.status && samePlace(x.object, want.object)),
    )
  }
  for (const [i, e] of (c.expected.events ?? []).entries()) {
    const g = got.events[i]
    if (e.type) checks.push(g?.type === e.type)
    else checks.push(Boolean(g))
    if (e.action) checks.push(g?.action === e.action)
    if (e.location) checks.push(samePlace(g?.location, e.location))
    if (e.location === null) checks.push(g?.location == null)
    if (e.from === null) checks.push(g?.from == null)
    if (e.toward === null) checks.push(g?.toward == null)
    if (e.altitude_m) checks.push(g?.altitude_m === e.altitude_m)
    if (e.toward) checks.push(samePlace(g?.toward, e.toward))
    if (e.place) checks.push(samePlace(g?.location, e.place) || samePlace(g?.toward, e.place))
    if (e.from) checks.push(samePlace(g?.from, e.from))
    if (e.count) checks.push(g?.count === e.count)
  }
  const ok = checks.filter(Boolean).length
  score += ok
  total += checks.length
  const mark = ok === checks.length ? '✅' : '❌'
  console.log(
    `${mark} ${c.name} (${ok}/${checks.length})${ok === checks.length ? '' : ` → ${JSON.stringify(got)}`}`,
  )
}

const acc = total ? score / total : 0
console.log(
  `\nAccuracy: ${(acc * 100).toFixed(1)}% over ${cases.length} cases (threshold ${threshold * 100}%)`,
)
process.exit(acc >= threshold ? 0 : 1)
