import { THREAT_CLASS, type ThreatClass, type ThreatType } from '@arpha/shared'
import type { RouteRecord } from '../db'

/**
 * Learning from history. Every finished track leaves a route (ordered places).
 * From many routes we derive:
 *  - transitions P(next place | current place, class) — a first-order Markov
 *    model of how drones/KABs move through the oblast, used by the predictor;
 *  - corridors — the most travelled place→place legs (drawn on the map);
 *  - when attacks happen (hour of day, Kyiv time) and where they enter.
 */
export type TransitionTable = Map<string, Map<string, number>>

const classOf = (type: string): ThreatClass => THREAT_CLASS[type as ThreatType] ?? 'drones'

export const transitionKey = (cls: ThreatClass, place: string) => `${cls}|${place}`

function legs(r: RouteRecord): [RouteRecord['path'][number], RouteRecord['path'][number]][] {
  const out: [RouteRecord['path'][number], RouteRecord['path'][number]][] = []
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1]!
    const b = r.path[i]!
    if (a.place !== b.place) out.push([a, b])
  }
  return out
}

export function buildTransitions(routes: RouteRecord[]): TransitionTable {
  const table: TransitionTable = new Map()
  for (const r of routes) {
    const cls = classOf(r.type)
    for (const [a, b] of legs(r)) {
      const key = transitionKey(cls, a.place)
      const row = table.get(key) ?? new Map<string, number>()
      row.set(b.place, (row.get(b.place) ?? 0) + 1)
      table.set(key, row)
    }
  }
  return table
}

/** P(next | place) for a class, or an empty map. */
export function nextProbabilities(
  table: TransitionTable,
  cls: ThreatClass,
  place: string,
): Map<string, number> {
  const row = table.get(transitionKey(cls, place))
  if (!row) return new Map()
  const total = [...row.values()].reduce((s, n) => s + n, 0)
  return new Map([...row].map(([k, n]) => [k, n / total]))
}

export interface Corridor {
  from: string
  to: string
  fromLat: number
  fromLon: number
  toLat: number
  toLon: number
  count: number
  cls: ThreatClass
}

export interface Patterns {
  days: number
  routes: number
  byClass: Partial<Record<ThreatClass, number>>
  /** Routes started per hour of day (Kyiv time), per class. */
  hours: Partial<Record<ThreatClass, number[]>>
  corridors: Corridor[]
  entries: { place: string; lat: number; lon: number; count: number }[]
  /** Places where tracks most often ended (shot down, fell, lost). */
  endings: { place: string; lat: number; lon: number; count: number; outcome: string }[]
}

const kyivHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv',
  hour: 'numeric',
  hourCycle: 'h23',
})

export function summarizePatterns(routes: RouteRecord[], days: number, limit = 40): Patterns {
  const byClass: Patterns['byClass'] = {}
  const hours: Patterns['hours'] = {}
  const corridorMap = new Map<string, Corridor>()
  const entryMap = new Map<string, Patterns['entries'][number]>()
  const endMap = new Map<string, Patterns['endings'][number]>()

  for (const r of routes) {
    const cls = classOf(r.type)
    byClass[cls] = (byClass[cls] ?? 0) + 1
    const h = Number(kyivHour.format(new Date(r.startedAt)))
    const hist = hours[cls] ?? new Array<number>(24).fill(0)
    hist[h] = (hist[h] ?? 0) + 1
    hours[cls] = hist

    const first = r.path[0]
    if (first) {
      const e = entryMap.get(first.place) ?? {
        place: first.place,
        lat: first.lat,
        lon: first.lon,
        count: 0,
      }
      e.count++
      entryMap.set(first.place, e)
    }
    const last = r.path.at(-1)
    if (last && r.path.length > 1) {
      const key = `${last.place}|${r.outcome}`
      const e = endMap.get(key) ?? {
        place: last.place,
        lat: last.lat,
        lon: last.lon,
        count: 0,
        outcome: r.outcome,
      }
      e.count++
      endMap.set(key, e)
    }
    for (const [a, b] of legs(r)) {
      const key = `${cls}|${a.place}|${b.place}`
      const c = corridorMap.get(key) ?? {
        from: a.place,
        to: b.place,
        fromLat: a.lat,
        fromLon: a.lon,
        toLat: b.lat,
        toLon: b.lon,
        count: 0,
        cls,
      }
      c.count++
      corridorMap.set(key, c)
    }
  }
  const top = <T extends { count: number }>(m: Map<string, T>) =>
    [...m.values()].sort((a, b) => b.count - a.count).slice(0, limit)
  return {
    days,
    routes: routes.length,
    byClass,
    hours,
    corridors: top(corridorMap),
    entries: top(entryMap).slice(0, 10),
    endings: top(endMap).slice(0, 10),
  }
}
