import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtractedEvent, RawMessage } from '../src/extract/types'
import type { ResolvedEvent } from '../src/fusion/tracker'
import { Gazetteer, type PlaceRecord } from '../src/geo/gazetteer'

export const T0 = Date.UTC(2026, 10, 25, 0, 0, 0)
export const min = (n: number) => T0 + n * 60_000

let gz: Gazetteer | null = null
export function gazetteer(): Gazetteer {
  gz ??= new Gazetteer(
    JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../data/gazetteer.json'), 'utf8'),
    ) as PlaceRecord[],
  )
  return gz
}

export function message(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    channel: 'test_channel',
    channelTitle: 'Тест',
    id: 1,
    date: T0,
    editDate: null,
    text: 'шахед',
    replyToId: null,
    ...overrides,
  }
}

export function event(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    type: 'shahed',
    model: null,
    count: null,
    action: 'new',
    location: null,
    precision: null,
    from: null,
    toward: null,
    heading: null,
    track_id: null,
    altitude_m: null,
    confidence: 0.8,
    ...overrides,
  }
}

/** Resolve names against the real gazetteer, like the pipeline does. */
export function resolved(overrides: Partial<ExtractedEvent> = {}): ResolvedEvent {
  const ev = event(overrides)
  const g = gazetteer()
  return {
    ...ev,
    locationPlace: ev.location ? g.lookup(ev.location) : null,
    fromPlace: ev.from ? g.lookup(ev.from) : null,
    towardPlace: ev.toward ? g.lookup(ev.toward) : null,
  }
}
