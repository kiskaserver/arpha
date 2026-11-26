import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bearingDeg, haversineKm, predictPosition } from '@arpha/shared'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db'
import { type Extraction, extractionSchema, type RawMessage } from '../src/extract/types'
import { Tracker } from '../src/fusion/tracker'
import { Pipeline } from '../src/ingest/pipeline'
import { silentLogger } from '../src/logger'
import { gazetteer } from './helpers'

/**
 * A real night (2026-11-26, 02:03–02:17 Kyiv): one jet drone over the north of the
 * oblast, narrated by three channels with their own reply chains. The extractions are
 * what the model actually returned. Before the fixes this produced two tracks, an origin
 * in the village Північне 100 km south ("з півночі"), a course that ignored
 * "Довернув на …", and an icon that flew on past its target at 488 km/h.
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
  readFileSync(join(import.meta.dirname, 'fixtures/jet-drone-night.json'), 'utf8'),
) as Post[]

async function replay() {
  const byKey = new Map(posts.map((p) => [`${p.channel}#${p.id}`, p]))
  const tracker = new Tracker()
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
  for (const p of posts) {
    now = p.date + 5_000
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
  return { tracker, end: now }
}

describe('replay: one jet drone, three channels', () => {
  it('ends as a single track, not one per channel', async () => {
    const { tracker } = await replay()
    const jets = tracker.active().filter((t) => t.type === 'jet_drone')
    expect(jets).toHaveLength(1)
    expect(new Set(jets[0]!.sources.map((s) => s.channel)).size).toBeGreaterThanOrEqual(2)
  })

  it('never takes a compass word for a village', async () => {
    const { tracker } = await replay()
    for (const t of tracker.tracks()) expect(t.origin?.name).not.toBe('Північне')
  })

  it('heads for the named target and stops there instead of flying past', async () => {
    const { tracker, end } = await replay()
    const t = tracker.active().find((x) => x.type === 'jet_drone')!
    expect(t.target).not.toBeNull()
    expect(t.speedKmh!).toBeLessThanOrEqual(450) // Geran-3 cruise 370 × 1.2
    const toTarget = bearingDeg(t.position!, t.target!)
    expect(Math.abs(((t.headingDeg! - toTarget + 540) % 360) - 180)).toBeLessThan(45)
    const later = predictPosition(t, end + 10 * 60_000)!
    expect(haversineKm(later, t.target!)).toBeLessThan(3)
  })

  it('keeps the villages it flew over for the map', async () => {
    const { tracker } = await replay()
    const t = tracker.active().find((x) => x.type === 'jet_drone')!
    const names = (t.trail ?? []).map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['Таврійське', 'Комишуваха', 'Вільнянськ']))
    expect(names.at(-1)).toBe(t.placeName)
  })
})
