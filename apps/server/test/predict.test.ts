import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  bearingDeg,
  destination,
  haversineKm,
  reachCone,
  type Track,
  trackCone,
  ZAPORIZHZHIA,
} from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../src/db'
import type { PlaceRecord } from '../src/geo/gazetteer'
import { FeedBuffer, InfraService } from '../src/infra/service'
import { Predictor } from '../src/predict/predictor'
import { gazetteer, message, min } from './helpers'

const places = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../data/gazetteer.json'), 'utf8'),
) as PlaceRecord[]
const NOW = min(0)

const track = (o: Partial<Track> = {}): Track => ({
  id: 't1',
  type: 'shahed',
  count: 1,
  status: 'active',
  position: gazetteer().lookup('Балабине')!,
  speedKmh: 180,
  headingDeg: bearingDeg(gazetteer().lookup('Балабине')!, ZAPORIZHZHIA),
  stateAt: NOW,
  uncertaintyKm: 2,
  placeName: 'Балабине',
  target: null,
  origin: null,
  prediction: null,
  model: null,
  confidence: 0.8,
  sources: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...o,
})

describe('reach cone', () => {
  it('fans out around the course and is shorter at the edges', () => {
    const ring = reachCone(ZAPORIZHZHIA, 0, 180, 10, 30, 12)
    expect(ring[0]).toEqual(ring.at(-1))
    const tip = ring[7]! // middle of the arc = straight ahead
    const edge = ring[1]!
    const d = (p: number[]) => haversineKm(ZAPORIZHZHIA, { lon: p[0]!, lat: p[1]! })
    expect(d(tip)).toBeCloseTo(30, 0)
    expect(d(edge)).toBeLessThan(d(tip))
  })

  it('only for predictably moving tracks', () => {
    expect(trackCone(track(), NOW)).not.toBeNull()
    expect(trackCone(track({ type: 'kab', speedKmh: null, headingDeg: null }), NOW)).toBeNull()
    expect(trackCone(track({ headingDeg: null }), NOW)).toBeNull()
  })
})

describe('Predictor', () => {
  const predictor = new Predictor(places)

  it('ranks places ahead on the course; probabilities sum to 1', () => {
    const p = predictor.predict(track(), NOW)!
    expect(p.targets.length).toBeGreaterThan(0)
    expect(p.targets.length).toBeLessThanOrEqual(3)
    const sum = p.targets.reduce((s, t) => s + t.p, 0)
    expect(sum).toBeCloseTo(1, 1)
    // Everything predicted lies roughly ahead (north) of Balabyne.
    for (const t of p.targets) {
      const off = Math.abs(
        ((bearingDeg(track().position!, t) - track().headingDeg! + 540) % 360) - 180,
      )
      expect(off).toBeLessThan(50)
    }
    expect(p.targets[0]!.etaMin).not.toBeNull()
  })

  it('a named destination is boosted, and kept even beyond the horizon', () => {
    const far = { ...gazetteer().lookup('Вільнянськ')!, name: 'Вільнянськ' }
    const p = predictor.predict(track({ target: far }), NOW)!
    expect(p.targets.map((t) => t.name)).toContain('Вільнянськ')
  })

  it('historical prior shifts the ranking toward frequently hit places', () => {
    const base = predictor.predict(track(), NOW)!
    const second = base.targets[1]
    if (!second) return
    const biased = new Predictor(places)
    biased.setPrior(new Map([[second.name, 500]]))
    expect(biased.predict(track(), NOW)!.targets[0]!.name).toBe(second.name)
  })

  it('learned routes steer the forecast even against the reported course', () => {
    const learned = new Predictor(places)
    // History: from Балабине drones usually turned west to Кушугум.
    learned.setTransitions(
      new Map([
        [
          'drones|Балабине',
          new Map([
            ['Кушугум', 9],
            ['Запоріжжя', 1],
          ]),
        ],
      ]),
    )
    // Кушугум lies 206° from Балабине, 34° off this course: history decides…
    const course = track({ headingDeg: 240 })
    expect(new Predictor(places).predict(course, NOW)!.targets[0]!.name).not.toBe('Кушугум')
    expect(learned.predict(course, NOW)!.targets[0]!.name).toBe('Кушугум')
    // …but a place behind the object is never where it is going, whatever history says.
    const behind = learned.predict(track({ headingDeg: 30 }), NOW)!
    expect(behind.targets.map((t) => t.name)).not.toContain('Кушугум')
  })

  it('KAB and ballistic: impact zone at the target/reported spot', () => {
    const kab = predictor.predict(
      track({ type: 'kab', speedKmh: null, headingDeg: null, placeName: 'Оріхів' }),
      NOW,
    )!
    expect(kab.impact?.radiusKm).toBe(3)
    const bal = predictor.predict(
      track({
        type: 'ballistic',
        position: null,
        speedKmh: null,
        headingDeg: null,
        target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
      }),
      NOW,
    )!
    expect(bal.targets[0]).toMatchObject({ name: 'Запоріжжя', p: 1 })
    expect(bal.impact).toMatchObject({ radiusKm: 6 })
  })

  it('nothing for finished tracks or those with nothing to say', () => {
    expect(predictor.predict(track({ status: 'destroyed' }), NOW)).toBeNull()
    expect(
      predictor.predict(track({ type: 'aircraft', speedKmh: null, headingDeg: null }), NOW),
    ).toBeNull()
    // A drone heading out over empty steppe beyond the region.
    const out = predictor.predict(
      track({ position: destination(ZAPORIZHZHIA, 90, 300), headingDeg: 90 }),
      NOW,
    )!
    expect(out.targets).toEqual([])
  })
})

describe('InfraService and feed', () => {
  it('geocodes closures, persists, reopens and expires', () => {
    const store = new Store(':memory:')
    const onChange = vi.fn()
    const infra = new InfraService(store, gazetteer(), onChange)
    infra.apply(
      [
        { object: 'мости', status: 'closed' },
        { object: 'ГЕС', status: 'closed' },
        { object: 'Неіснуючий міст', status: 'closed' },
      ],
      message({ date: min(0), channelTitle: 'ЗП' }),
    )
    expect(
      infra
        .list()
        .map((i) => i.name)
        .sort(),
    ).toEqual(['ДніпроГЕС', 'Мости Преображенського'])
    expect(onChange).toHaveBeenCalledOnce()
    // Same status again: no event. Reopened: event.
    infra.apply([{ object: 'мости', status: 'closed' }], message({ date: min(0) }))
    expect(onChange).toHaveBeenCalledOnce()
    infra.apply([{ object: 'мости', status: 'open' }], message({ date: min(1) }))
    expect(onChange).toHaveBeenCalledTimes(2)
    // Restored from the store after a restart.
    expect(new InfraService(store, gazetteer(), vi.fn()).list()).toHaveLength(2)
    infra.tick(min(40)) // "open" shown for 30 min
    expect(infra.list().map((i) => i.name)).toEqual(['ДніпроГЕС'])
    infra.tick(min(7 * 60)) // "closed" assumed lifted after 6 h
    expect(infra.list()).toEqual([])
    infra.tick(min(8 * 60))
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('feed keeps the newest N unique items', () => {
    const feed = new FeedBuffer(2)
    const item = (key: string, at: number) => ({
      key,
      channel: 'c',
      channelTitle: 'C',
      messageId: 1,
      text: 't',
      at,
      types: [],
      trackIds: [],
    })
    feed.add(item('a', 1))
    feed.add(item('b', 3))
    feed.add(item('b', 3))
    feed.add(item('c', 2))
    expect(feed.list().map((i) => i.key)).toEqual(['b', 'c'])
    // Persisted across restarts when given a store.
    const store = new Store(':memory:')
    new FeedBuffer(5, store).add(item('x', 9))
    expect(new FeedBuffer(5, store).list().map((i) => i.key)).toEqual(['x'])
  })

  it('store: hotspots aggregate observations', () => {
    const store = new Store(':memory:')
    for (const [at, place] of [
      [1, 'Кушугум'],
      [2, 'Кушугум'],
      [3, 'Балабине'],
    ] as const) {
      store.addObservation({ at, place, lat: 47.7, lon: 35.2, type: at === 3 ? 'kab' : 'shahed' })
    }
    expect(store.hotspots(0)).toEqual([
      expect.objectContaining({ name: 'Кушугум', count: 2 }),
      expect.objectContaining({ name: 'Балабине', count: 1 }),
    ])
    expect(store.hotspots(0, 10, ['kab']).map((h) => h.name)).toEqual(['Балабине'])
    store.pruneObservations(2)
    expect(store.hotspots(0).map((h) => h.count)).toEqual([1, 1])
    store.setJson('k', { a: 1 })
    expect(store.getJson('k')).toEqual({ a: 1 })
    expect(store.getJson('missing')).toBeNull()
  })

  it('folds candidates that are one spot on the map into the likelier name', () => {
    const p = new Predictor(places).predict(track(), NOW)!
    for (let i = 0; i < p.targets.length; i++)
      for (let j = i + 1; j < p.targets.length; j++)
        expect(haversineKm(p.targets[i]!, p.targets[j]!)).toBeGreaterThanOrEqual(3)
  })
})
