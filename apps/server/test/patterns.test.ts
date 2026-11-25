import { describe, expect, it } from 'vitest'
import type { RouteRecord } from '../src/db'
import { Store } from '../src/db'
import { buildTransitions, nextProbabilities, summarizePatterns } from '../src/predict/patterns'

const at = (h: number) => Date.UTC(2026, 10, 25, h - 2, 0) // Kyiv = UTC+2 in November
const route = (id: string, places: string[], o: Partial<RouteRecord> = {}): RouteRecord => ({
  id,
  type: 'shahed',
  model: null,
  startedAt: at(23),
  endedAt: at(23) + 600_000,
  outcome: 'destroyed',
  path: places.map((place, i) => ({
    place,
    lat: 47 + i / 10,
    lon: 35 + i / 10,
    at: at(23) + i * 60_000,
  })),
  ...o,
})

describe('patterns', () => {
  const routes = [
    route('a', ['Василівка', 'Балабине', 'Кушугум']),
    route('b', ['Василівка', 'Балабине', 'Балабине', 'Запоріжжя']),
    route('c', ['Василівка', 'Степногірськ'], { outcome: 'lost' }),
    route('k', ['Оріхів', 'Мала Токмачка'], { type: 'kab', startedAt: at(14) }),
  ]

  it('learns P(next | place) per class', () => {
    const t = buildTransitions(routes)
    const p = nextProbabilities(t, 'drones', 'Василівка')
    expect(p.get('Балабине')).toBeCloseTo(2 / 3)
    expect(p.get('Степногірськ')).toBeCloseTo(1 / 3)
    expect(nextProbabilities(t, 'kab', 'Василівка').size).toBe(0)
    expect(nextProbabilities(t, 'kab', 'Оріхів').get('Мала Токмачка')).toBe(1)
  })

  it('summarises corridors, hours, entries and endings', () => {
    const s = summarizePatterns(routes, 30)
    expect(s.routes).toBe(4)
    expect(s.byClass).toEqual({ drones: 3, kab: 1 })
    expect(s.corridors[0]).toMatchObject({
      from: 'Василівка',
      to: 'Балабине',
      count: 2,
      cls: 'drones',
    })
    expect(s.hours.drones![23]).toBe(3)
    expect(s.hours.kab![14]).toBe(1)
    expect(s.entries[0]).toMatchObject({ place: 'Василівка', count: 3 })
    expect(s.endings.map((e) => e.outcome)).toContain('lost')
  })

  it('routes round-trip through the store', () => {
    const store = new Store(':memory:')
    for (const r of routes) store.saveRoute(r)
    store.saveRoute({ ...routes[0]!, outcome: 'expired' })
    const back = store.routes(0)
    expect(back).toHaveLength(4)
    expect(back.find((r) => r.id === 'a')!.outcome).toBe('expired')
    expect(store.routes(at(15)).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})
