import { bearingDeg, haversineKm, predictPosition, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Tracker } from '../src/fusion/tracker'
import { gazetteer, message, min, resolved, T0 } from './helpers'

function setup() {
  const onChange = vi.fn<(t: Track) => void>()
  const onRemove = vi.fn<(id: string) => void>()
  const tracker = new Tracker({ onChange, onRemove })
  return { tracker, onChange, onRemove }
}

const ctx = (n: number, overrides: Partial<Parameters<Tracker['apply']>[1]> = {}) => ({
  message: message({ id: n, date: min(n) }),
  parentTrackIds: [],
  observedAt: min(n),
  ...overrides,
})

describe('Tracker', () => {
  it('creates a track at the reported place with course toward the target', () => {
    const { tracker, onChange } = setup()
    const [id] = tracker.apply(
      [resolved({ location: 'Василівка', toward: 'Запоріжжя', count: 3 })],
      ctx(0),
    )
    const t = tracker.get(id!)!
    expect(t.count).toBe(3)
    expect(t.placeName).toBe('Василівка')
    expect(t.target?.name).toBe('Запоріжжя')
    expect(t.speedKmh).toBeGreaterThan(100)
    // Vasylivka → Zaporizhzhia is roughly north.
    expect(t.headingDeg! > 330 || t.headingDeg! < 30).toBe(true)
    expect(onChange).toHaveBeenCalledOnce()
    expect(t.sources).toHaveLength(1)
  })

  it('associates a follow-up report by proximity and learns the real velocity', () => {
    const { tracker } = setup()
    const [id] = tracker.apply([resolved({ location: 'Василівка', heading: 'N' })], ctx(0))
    const [id2] = tracker.apply([resolved({ location: 'Балабине', action: 'update' })], ctx(12))
    expect(id2).toBe(id)
    const t = tracker.get(id!)!
    expect(t.placeName).toBe('Балабине')
    expect(t.speedKmh).toBeGreaterThan(80)
    expect(t.speedKmh).toBeLessThanOrEqual(250)
    expect(tracker.active()).toHaveLength(1)
  })

  it('does not jump: the predicted icon position changes smoothly between reports', () => {
    const { tracker } = setup()
    const [id] = tracker.apply([resolved({ location: 'Василівка', heading: 'N' })], ctx(0))
    const before = predictPosition(tracker.get(id!)!, min(10))!
    tracker.apply([resolved({ location: 'Балабине', action: 'update' })], ctx(10))
    const after = predictPosition(tracker.get(id!)!, min(10))!
    // Filtered correction is bounded by the measurement noise, not the raw report offset.
    expect(haversineKm(before, after)).toBeLessThan(15)
  })

  it('keeps separate groups apart when they are far from each other', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Василівка' })], ctx(0))
    const [b] = tracker.apply([resolved({ location: 'Гуляйполе' })], ctx(1))
    expect(a).not.toBe(b)
    expect(tracker.active()).toHaveLength(2)
  })

  it('follows an explicit track id from the model', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Василівка' })], ctx(0))
    const [b] = tracker.apply(
      [resolved({ location: 'Гуляйполе', track_id: a!, action: 'update' })],
      ctx(5),
    )
    expect(b).toBe(a)
  })

  it('links replies to the parent message tracks', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    const [b] = tracker.apply(
      [resolved({ action: 'update', toward: 'Запоріжжя' })],
      ctx(3, { parentTrackIds: [a!] }),
    )
    expect(b).toBe(a)
    expect(tracker.get(a!)!.target?.name).toBe('Запоріжжя')
  })

  it('"мінус" in a reply destroys the linked track, then it is purged', () => {
    const { tracker, onRemove } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.apply([resolved({ action: 'destroyed' })], ctx(2, { parentTrackIds: [a!] }))
    expect(tracker.get(a!)!.status).toBe('destroyed')
    expect(tracker.get(a!)!.speedKmh).toBeNull()
    tracker.tick(min(2) + 30_000)
    expect(tracker.get(a!)).toBeDefined()
    tracker.tick(min(4))
    expect(tracker.get(a!)).toBeUndefined()
    expect(onRemove).toHaveBeenCalledWith(a, expect.objectContaining({ path: expect.any(Array) }))
  })

  it('"впали каби" marks an impact where they fell', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'kab', location: 'Космічний' })], ctx(0))
    tracker.apply([resolved({ type: 'kab', action: 'lost' })], ctx(1, { parentTrackIds: [a!] }))
    const boom = tracker.active().find((t) => t.type === 'explosion')!
    expect(boom).toMatchObject({ placeName: 'Космічний' })
    expect(tracker.get(a!)!.status).toBe('lost')
    // With an explicit place and no tracked KAB.
    tracker.apply([resolved({ type: 'kab', action: 'lost', location: 'Балабине' })], ctx(2))
    expect(
      tracker
        .active()
        .filter((t) => t.type === 'explosion')
        .map((t) => t.placeName),
    ).toEqual(['Космічний', 'Балабине'])
    // A lost shahed is not an impact.
    const [s] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(3))
    tracker.apply([resolved({ action: 'lost' })], ctx(4, { parentTrackIds: [s!] }))
    expect(tracker.active().filter((t) => t.type === 'explosion')).toHaveLength(2)
  })

  it('a named model seeds its published speed (Герань-3 ≈ 370 km/h)', () => {
    const { tracker } = setup()
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', model: 'geran_3', location: 'Оріхів', heading: 'N' })],
      ctx(0),
    )
    const t = tracker.get(a!)!
    expect(t.model).toBe('geran_3')
    expect(t.speedKmh).toBeGreaterThan(300)
    expect(t.speedKmh).toBeLessThan(450)
  })

  it('records the route and hands it over when the track ends', () => {
    const onRemove = vi.fn()
    const tracker = new Tracker({ onRemove })
    const [a] = tracker.apply([resolved({ location: 'Василівка' })], ctx(0))
    tracker.apply([resolved({ location: 'Василівка', action: 'update' })], ctx(1))
    tracker.apply([resolved({ location: 'Балабине', action: 'update' })], ctx(10))
    tracker.apply([resolved({ action: 'destroyed' })], ctx(11, { parentTrackIds: [a!] }))
    tracker.tick(min(20))
    const [id, state] = onRemove.mock.calls[0]!
    expect(id).toBe(a)
    expect(state.path.map((p: { place: string }) => p.place)).toEqual(['Василівка', 'Балабине'])
  })

  it('partial destruction decrements the count', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів', count: 5 })], ctx(0))
    tracker.apply([resolved({ action: 'destroyed', count: 2 })], ctx(1, { parentTrackIds: [a!] }))
    expect(tracker.get(a!)).toMatchObject({ status: 'active', count: 3 })
  })

  it('ignores destroyed/lost reports it cannot attribute', () => {
    const { tracker } = setup()
    expect(tracker.apply([resolved({ action: 'destroyed' })], ctx(0))).toEqual([null])
    expect(tracker.tracks()).toHaveLength(0)
  })

  it('drops events with neither a place nor a target', () => {
    const { tracker } = setup()
    expect(tracker.apply([resolved({})], ctx(0))).toEqual([null])
  })

  it('target-only threats (ballistic) have no position and merge by target', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'ballistic', toward: 'Запоріжжя' })], ctx(0))
    const t = tracker.get(a!)!
    expect(t.position).toBeNull()
    expect(t.target?.name).toBe('Запоріжжя')
    const [b] = tracker.apply([resolved({ type: 'ballistic', toward: 'Запоріжжя' })], ctx(1))
    expect(b).toBe(a)
  })

  it('a ballistic warning "for a place" becomes a target, not a position', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'ballistic', location: 'Запоріжжя' })], ctx(0))
    expect(tracker.get(a!)).toMatchObject({ position: null, target: { name: 'Запоріжжя' } })
  })

  it('stationary types sit on the latest report', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'kab', location: 'Оріхів' })], ctx(0))
    tracker.apply([resolved({ type: 'kab', location: 'Мала Токмачка', action: 'update' })], ctx(1))
    const t = tracker.get(a!)!
    expect(t.placeName).toBe('Мала Токмачка')
    expect(t.speedKmh).toBeNull()
    expect(haversineKm(t.position!, gazetteer().lookup('Мала Токмачка')!)).toBeLessThan(0.01)
  })

  it('upgrades unknown type to a specific one, never the reverse', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'unknown', location: 'Оріхів' })], ctx(0))
    tracker.apply([resolved({ type: 'shahed', location: 'Оріхів', action: 'update' })], ctx(1))
    expect(tracker.get(a!)!.type).toBe('shahed')
    tracker.apply([resolved({ type: 'unknown', location: 'Оріхів', action: 'update' })], ctx(2))
    expect(tracker.get(a!)!.type).toBe('shahed')
  })

  it('corroboration from other channels raises confidence', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів', confidence: 0.6 })], ctx(0))
    tracker.apply([resolved({ location: 'Оріхів', confidence: 0.6, action: 'update' })], {
      ...ctx(1),
      message: message({ channel: 'other', id: 9, date: min(1) }),
    })
    expect(tracker.get(a!)!.confidence).toBeCloseTo(0.7)
    expect(tracker.get(a!)!.sources.map((s) => s.channel)).toEqual(['other', 'test_channel'])
  })

  it('expires silent tracks after their TTL', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.tick(min(20))
    expect(tracker.get(a!)!.status).toBe('active')
    tracker.tick(min(26))
    expect(tracker.get(a!)!.status).toBe('lost')
    tracker.tick(min(28))
    expect(tracker.get(a!)).toBeUndefined()
  })

  it('all-clear marks everything lost', () => {
    const { tracker } = setup()
    tracker.apply([resolved({ location: 'Оріхів' }), resolved({ location: 'Гуляйполе' })], ctx(0))
    tracker.allClear(min(1))
    expect(tracker.active()).toHaveLength(0)
    expect(tracker.tracks().every((t) => t.status === 'lost')).toBe(true)
  })

  it('re-seeds on a wildly inconsistent report linked by id', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.apply(
      [resolved({ location: 'Бердянськ', track_id: a!, action: 'update', precision: 'exact' })],
      ctx(1),
    )
    const t = tracker.get(a!)!
    expect(haversineKm(t.position!, gazetteer().lookup('Бердянськ')!)).toBeLessThan(5)
  })

  it('two events in one message never collapse onto the same track', () => {
    const { tracker } = setup()
    const ids = tracker.apply(
      [resolved({ location: 'Оріхів' }), resolved({ location: 'Оріхів' })],
      ctx(0),
    )
    expect(new Set(ids).size).toBe(2)
  })

  it('briefs summarise active tracks for the model', () => {
    const { tracker } = setup()
    tracker.apply([resolved({ location: 'Оріхів', toward: 'Запоріжжя' })], ctx(0))
    const [b] = tracker.briefs(min(3))
    expect(b).toMatchObject({
      type: 'shahed',
      placeName: 'Оріхів',
      targetName: 'Запоріжжя',
      minutesAgo: 3,
    })
  })

  it('restores from a snapshot (including ones saved before routes existed)', () => {
    const { tracker } = setup()
    tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    const old = tracker.snapshot().map((s) => {
      const { path: _p, ...rest } = s
      return { ...rest, track: { ...s.track, model: undefined as unknown as null } } as typeof s
    })
    const restored = new Tracker({}, old)
    expect(restored.snapshot()[0]!.path).toEqual([])
    expect(restored.active()).toHaveLength(1)
  })

  it('a stream of reports along a real route produces a stable north-bound track', () => {
    const { tracker } = setup()
    const route = ['Михайлівка', 'Василівка', 'Балабине', 'Кушугум']
    let id: string | null | undefined = null
    route.forEach((place, i) => {
      ;[id] = tracker.apply(
        [resolved({ location: place, action: i ? 'update' : 'new', toward: 'Запоріжжя' })],
        ctx(i * 8),
      )
    })
    expect(tracker.active()).toHaveLength(1)
    const t = tracker.get(id!)!
    expect(t.headingDeg! > 300 || t.headingDeg! < 60).toBe(true)
    expect(haversineKm(predictPosition(t, min(24))!, ZAPORIZHZHIA)).toBeLessThan(30)
    expect(t.createdAt).toBe(T0)
  })

  it('"Довернув на X" without a position turns the course toward X', () => {
    const { tracker } = setup()
    const [id] = tracker.apply([resolved({ location: 'Василівка', heading: 'N' })], ctx(0))
    expect(tracker.get(id!)!.headingDeg! < 30 || tracker.get(id!)!.headingDeg! > 330).toBe(true)
    // Turn west, toward Дніпрорудне.
    tracker.apply(
      [resolved({ action: 'update', toward: 'Дніпрорудне' })],
      ctx(1, { parentTrackIds: [id!] }),
    )
    const t = tracker.get(id!)!
    expect(t.target?.name).toBe('Дніпрорудне')
    const off = ((bearingDeg(t.position!, t.target!) - t.headingDeg! + 540) % 360) - 180
    expect(Math.abs(off)).toBeLessThan(30)
    expect(t.stateAt).toBe(min(1))
  })

  it('caps speeds that lagging reports imply', () => {
    const { tracker } = setup()
    const [id] = tracker.apply(
      [resolved({ type: 'shahed', location: 'Василівка', heading: 'N' })],
      ctx(0),
    )
    // 40 km in one minute would be 2400 km/h for a shahed.
    tracker.apply(
      [resolved({ type: 'shahed', action: 'update', location: 'Балабине' })],
      ctx(1, { parentTrackIds: [id!] }),
    )
    expect(tracker.get(id!)!.speedKmh!).toBeLessThanOrEqual(180 * 1.2)
  })

  it("merges two channels' tracks of one object and resolves replies to the old id", () => {
    const onMerge = vi.fn()
    const tracker = new Tracker({ onMerge })
    const on = (channel: string, id: number, at: number, parentTrackIds: string[] = []) => ({
      message: message({ id, channel, date: min(at) }),
      parentTrackIds,
      observedAt: min(at),
    })
    // Channel a: a jet over Вільнянськ heading south.
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Вільнянськ', heading: 'S' })],
      on('a', 1, 0),
    )
    // Channel b opens its own thread without a position ("з півночі до Новомиколаївки")…
    const [b] = tracker.apply(
      [resolved({ type: 'jet_drone', heading: 'S', toward: 'Новомиколаївка' })],
      on('b', 1, 0.2),
    )
    expect(b).not.toBe(a)
    // …then its next post puts it exactly where a's object now is.
    const [c] = tracker.apply(
      [
        resolved({
          type: 'jet_drone',
          action: 'update',
          location: 'Новософіївка',
          heading: 'S',
          altitude_m: 700,
        }),
      ],
      on('b', 2, 1, [b!]),
    )
    expect(c).toBe(a)
    expect(onMerge).toHaveBeenCalledWith(b, a)
    expect(tracker.active()).toHaveLength(1)
    expect(tracker.get(b!)!.id).toBe(a) // replies to b's posts still find the object
    const t = tracker.get(a!)!
    expect(new Set(t.sources.map((s) => s.channel))).toEqual(new Set(['a', 'b']))
    expect(t.altitudeM).toBe(700)
    expect(t.trail!.map((p) => p.name)).toEqual(['Вільнянськ', 'Новософіївка'])
  })

  it('an update with only a target joins the one object already heading there', () => {
    const { tracker } = setup()
    const [id] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Вільнянськ', toward: 'Матвіївка' })],
      ctx(0),
    )
    const other = {
      message: message({ id: 9, channel: 'other', date: min(1) }),
      parentTrackIds: [],
      observedAt: min(1),
    }
    const [same] = tracker.apply(
      [resolved({ type: 'jet_drone', action: 'update', toward: 'Матвіївка' })],
      other,
    )
    expect(same).toBe(id)
    expect(tracker.active()).toHaveLength(1)
  })

  it('publishes the trail of reported places', () => {
    const { tracker } = setup()
    const [id] = tracker.apply([resolved({ location: 'Василівка', heading: 'N' })], ctx(0))
    tracker.apply(
      [resolved({ action: 'update', location: 'Балабине' })],
      ctx(20, { parentTrackIds: [id!] }),
    )
    expect(tracker.get(id!)!.trail!.map((p) => p.name)).toEqual(['Василівка', 'Балабине'])
  })
})
