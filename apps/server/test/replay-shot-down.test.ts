import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { haversineKm, ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db'
import { type Extraction, extractionSchema, type RawMessage } from '../src/extract/types'
import { Tracker, type TrackState } from '../src/fusion/tracker'
import { Pipeline } from '../src/ingest/pipeline'
import { silentLogger } from '../src/logger'
import { gazetteer } from './helpers'

/**
 * 2026-11-26, 07:48–08:24 Kyiv: a jet from Гуляйполе across the oblast into the city,
 * shot down over the Dnipro ("Над Островом, курс Хортицький" → "Мінус"). The model read
 * "ДД" as a made-up "Дніпроград" (→ Дніпрорудне, 60 km away) and "Острів" fell through to
 * Остриківка (65 km), so the map showed it shot down in the oblast, and every turn was
 * flown for minutes because reports were only blended into the forecast.
 */
interface Post {
  channel: string
  id: number
  date: number
  replyToId: number | null
  text: string
  extraction: Extraction
}

const posts = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/jet-shot-down-over-city.json'), 'utf8'),
) as Post[]

async function replay(until = Number.POSITIVE_INFINITY) {
  const byKey = new Map(posts.map((p) => [`${p.channel}#${p.id}`, p]))
  const ended: TrackState[] = []
  const tracker = new Tracker({ onRemove: (_id, s) => ended.push(s) })
  let now = posts[0]!.date
  const pipeline = new Pipeline({
    store: new Store(':memory:'),
    extractor: {
      extract: async ({ message }) =>
        extractionSchema.parse(byKey.get(`${message.channel}#${message.id}`)!.extraction),
    },
    gazetteer: gazetteer(),
    tracker,
    source: { getMessage: async () => null },
    logger: silentLogger,
    concurrency: 1,
    now: () => now,
  })
  for (const p of posts.filter((x) => x.date <= until)) {
    now = p.date + 3_000
    tracker.tick(now)
    const msg: RawMessage = {
      channel: p.channel,
      channelTitle: p.channel,
      id: p.id,
      date: p.date,
      editDate: null,
      text: p.text,
      replyToId: p.replyToId,
    }
    await pipeline.submit(msg)
  }
  return { tracker, ended, now }
}

/** The jet the eyes_everywhere_ua thread follows into the city. */
const jet = (tracker: Tracker) =>
  tracker
    .tracks()
    .filter((t) => t.type === 'jet_drone' && t.trail?.some((p) => p.name === 'Скворцова'))[0]!

describe('replay: jet shot down over the city', () => {
  it('never puts it — or a ghost of it — 60 km away on a misread name', async () => {
    const { tracker } = await replay()
    const names = tracker
      .tracks()
      .flatMap((t) => [t.placeName, ...(t.trail ?? []).map((p) => p.name)])
    expect(names).not.toContain('Дніпрорудне')
    expect(names).not.toContain('Остриківка')
    // One jet followed into the city, plus the second one announced from Гуляйполе.
    expect(tracker.tracks().filter((t) => t.type === 'jet_drone').length).toBeLessThanOrEqual(2)
  })

  it('is where the channel says right after a report, not kilometres behind', async () => {
    const at = posts.find((p) => p.text.startsWith('Запоріжжя Ліве/ДД'))!.date
    const { tracker } = await replay(at)
    const t = jet(tracker)
    const live = gazetteer().lookup('Запоріжжя-Ліве')!
    expect(t.placeName).toBe('Запоріжжя-Ліве')
    expect(haversineKm(t.position!, live)).toBeLessThan(1.6)
  })

  it('is shot down over the city, where the channel saw it', async () => {
    const { tracker } = await replay()
    const t = jet(tracker)
    expect(t.status).toBe('destroyed')
    expect(haversineKm(t.position!, ZAPORIZHZHIA)).toBeLessThan(15)
  })
})
