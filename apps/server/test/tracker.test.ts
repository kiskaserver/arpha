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

  it('expires silent tracks after their TTL, keeps them revivable, then drops them', () => {
    const { tracker, onRemove } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.tick(min(10))
    expect(tracker.get(a!)!.status).toBe('active')
    tracker.tick(min(16)) // shahed: 15 min of silence
    expect(tracker.get(a!)!.status).toBe('lost')
    // Clients see it for a while, then it is dormant but still known.
    expect(tracker.visible(min(20)).map((t) => t.id)).toContain(a)
    expect(tracker.visible(min(40)).map((t) => t.id)).not.toContain(a)
    tracker.tick(min(60))
    expect(tracker.get(a!)).toBeDefined()
    tracker.tick(min(16 + 121))
    expect(tracker.get(a!)).toBeUndefined()
    expect(onRemove).toHaveBeenCalledWith(a, expect.anything())
  })

  it('a lost object that reappears in its reply thread an hour later comes back with its history', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів', heading: 'N' })], ctx(0))
    tracker.tick(min(20))
    expect(tracker.get(a!)!.status).toBe('lost')
    const [b] = tracker.apply(
      [resolved({ action: 'update', location: 'Балабине' })],
      ctx(80, { parentTrackIds: [a!] }),
    )
    expect(b).toBe(a)
    const t = tracker.get(a!)!
    expect(t.status).toBe('active')
    expect(t.trail!.map((p) => p.name)).toEqual(['Оріхів', 'Балабине'])
  })

  it('without a link, only an object lost minutes ago is revived by proximity', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.tick(min(16))
    // 4 minutes later, right there: the same one.
    const [b] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(20))
    expect(b).toBe(a)
    tracker.tick(min(36))
    // Half an hour after it was lost: a new object.
    const [c] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(70))
    expect(c).not.toBe(a)
  })

  it('a destroyed object is never revived', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    tracker.apply([resolved({ action: 'destroyed' })], ctx(1, { parentTrackIds: [a!] }))
    const [b] = tracker.apply(
      [resolved({ action: 'update', location: 'Оріхів' })],
      ctx(2, { parentTrackIds: [a!] }),
    )
    expect(b).not.toBe(a)
  })

  it('an object last seen outside the oblast is dropped after two quiet minutes', () => {
    const tracker = new Tracker({ outside: (p) => p.lat > 47.95 })
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Вільнянськ', heading: 'N' })],
      ctx(0),
    )
    tracker.tick(min(1))
    expect(tracker.get(a!)!.status).toBe('active')
    tracker.tick(min(3))
    expect(tracker.get(a!)!.status).toBe('lost')
  })

  it('all-clear marks everything lost', () => {
    const { tracker } = setup()
    tracker.apply([resolved({ location: 'Оріхів' }), resolved({ location: 'Гуляйполе' })], ctx(0))
    tracker.allClear(min(1))
    expect(tracker.active()).toHaveLength(0)
    expect(tracker.tracks().every((t) => t.status === 'lost')).toBe(true)
  })

  it('ignores one impossible report, but believes two that agree with each other', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ location: 'Оріхів' })], ctx(0))
    const far = () =>
      resolved({ location: 'Бердянськ', track_id: a!, action: 'update', precision: 'exact' })
    // 150 km in a minute for a shahed: a misread place, not a flight.
    tracker.apply([far()], ctx(1))
    expect(tracker.get(a!)!.placeName).toBe('Оріхів')
    // A second report there: the track was what was wrong.
    tracker.apply([far()], ctx(2))
    const t = tracker.get(a!)!
    expect(t.placeName).toBe('Бердянськ')
    expect(haversineKm(t.position!, gazetteer().lookup('Бердянськ')!)).toBeLessThan(5)
  })

  it('a report puts the object there instead of blending it with the forecast', () => {
    const { tracker } = setup()
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Вільнянськ', heading: 'S' })],
      ctx(0),
    )
    // A minute later the channel names a place several km off where the forecast had it.
    tracker.apply(
      [
        resolved({
          type: 'jet_drone',
          action: 'update',
          location: 'Аеропорт Запоріжжя',
          precision: 'near',
        }),
      ],
      ctx(1, { parentTrackIds: [a!] }),
    )
    const t = tracker.get(a!)!
    expect(haversineKm(t.position!, gazetteer().lookup('Аеропорт Запоріжжя')!)).toBeLessThan(1.6)
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

  it('merges duplicates that converge between reports, on the clock', () => {
    const onMerge = vi.fn()
    const tracker = new Tracker({ onMerge })
    const on = (channel: string, id: number, at: number, parentTrackIds: string[] = []) => ({
      message: message({ id, channel, date: min(at) }),
      parentTrackIds,
      observedAt: min(at),
    })
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Вільнянськ', toward: 'Аеропорт Запоріжжя' })],
      on('a', 1, 0),
    )
    // Channel b: its own thread, first without a position, then 7 km from a's object
    // (too far to merge on the update) — both flying to the airport (a unique name).
    const [b] = tracker.apply(
      [resolved({ type: 'jet_drone', action: 'new', toward: 'Аеропорт Запоріжжя' })],
      on('b', 1, 0),
    )
    tracker.apply(
      [
        resolved({
          type: 'jet_drone',
          action: 'update',
          location: 'Новософіївка',
          toward: 'Аеропорт Запоріжжя',
        }),
      ],
      on('b', 2, 0.1, [b!]),
    )
    expect(tracker.active()).toHaveLength(2)
    // Dead reckoning parks both at the airport; the clock notices they are one object.
    tracker.tick(min(3))
    expect(onMerge).toHaveBeenCalledWith(b, a)
    expect(tracker.active()).toHaveLength(1)
  })

  it('after a jump it keeps flying the way it evidently went', () => {
    const { tracker } = setup()
    const [id] = tracker.apply([resolved({ type: 'shahed', location: 'Оріхів' })], ctx(0))
    // 60+ km north after a 12-minute silence: reachable, but far off the forecast, so the
    // filter is re-seeded…
    tracker.apply(
      [resolved({ type: 'shahed', action: 'update', location: 'Запоріжжя' })],
      ctx(12, { parentTrackIds: [id!] }),
    )
    const t = tracker.get(id!)!
    expect(t.placeName).toBe('Запоріжжя')
    // …with the Оріхів → Запоріжжя direction (roughly north), not standing still.
    expect(t.headingDeg).not.toBeNull()
    expect(Math.abs(((t.headingDeg! - 340 + 540) % 360) - 180)).toBeLessThan(40)
  })

  it('an oblast-sized origin is a direction, not a position', () => {
    const { tracker } = setup()
    const [id] = tracker.apply(
      [resolved({ type: 'jet_drone', from: 'Дніпропетровська область', toward: 'Вільнянськ' })],
      ctx(0),
    )
    const t = tracker.get(id!)!
    expect(t.position).toBeNull()
    expect(t.origin?.name).toBe('Дніпропетровська область')
    expect(t.trail ?? []).toEqual([])
  })

  it('separate blasts are separate points; the same spot minutes later is the same one', () => {
    const { tracker } = setup()
    const [a] = tracker.apply([resolved({ type: 'explosion', location: 'Космічний' })], ctx(0))
    const [b] = tracker.apply([resolved({ type: 'explosion', location: "Кар'єри" })], ctx(1))
    const [c] = tracker.apply([resolved({ type: 'explosion', location: 'Космічний' })], ctx(3))
    expect(b).not.toBe(a)
    expect(c).toBe(a)
    expect(tracker.get(a!)!.trail!.map((p) => p.name)).toEqual(['Космічний'])
  })

  it('in a reply thread: a far unattached update is a misread place, a near one a real extra object', () => {
    const { tracker } = setup()
    const [a] = tracker.apply(
      [resolved({ type: 'jet_drone', location: 'Запоріжжя-Ліве', heading: 'W' })],
      ctx(0),
    )
    const reply = ctx(1, { parentTrackIds: [a!] })
    // "Запоріжжя Ліве/ДД" split by the model, ДД misread as a town 60 km away.
    const far = tracker.apply(
      [
        resolved({ type: 'jet_drone', action: 'update', location: 'Запоріжжя-Ліве' }),
        resolved({ type: 'jet_drone', action: 'update', location: 'Дніпрорудне' }),
      ],
      reply,
    )
    expect(far[1]).toBeNull()
    // "1 Заводи ⏎ 1 Аеропорт": the second line is another jet nearby.
    const near = tracker.apply(
      [
        resolved({ type: 'jet_drone', action: 'update', location: 'Заводський район' }),
        resolved({ type: 'jet_drone', action: 'update', location: 'Аеропорт Запоріжжя' }),
      ],
      ctx(2, { parentTrackIds: [a!] }),
    )
    expect(near[1]).not.toBeNull()
    expect(near[1]).not.toBe(a)
  })

  it('one post cannot wipe out threats outside its reply thread', () => {
    const { tracker } = setup()
    const [mine] = tracker.apply([resolved({ location: 'Хортиця' })], ctx(0))
    const others = ['Оріхів', 'Гуляйполе', 'Пологи'].map(
      (place, i) =>
        tracker.apply(
          [resolved({ location: place })],
          ctx(1, { message: message({ id: 100 + i, channel: `other${i}`, date: min(1) }) }),
        )[0]!,
    )
    // "Всі до Хортицького/ВХ" in reply to `mine`, misread as an update plus a "lost" per threat.
    tracker.apply(
      [
        resolved({ action: 'update', toward: 'Хортиця' }),
        ...others.map((id) => resolved({ action: 'lost', track_id: id })),
      ],
      ctx(2, { parentTrackIds: [mine!] }),
    )
    expect(others.map((id) => tracker.get(id)!.status)).toEqual(['active', 'active', 'active'])
    // Outside a thread, a post ends at most one object on the model's link alone.
    tracker.apply(
      others.map((id) => resolved({ action: 'destroyed', track_id: id })),
      ctx(3),
    )
    expect(others.filter((id) => tracker.get(id)!.status === 'destroyed')).toHaveLength(1)
  })

  it('"Впали" typed as an explosion still ends the KAB it replies to', () => {
    const { tracker } = setup()
    const [k] = tracker.apply([resolved({ type: 'kab', location: 'Новотаврійське' })], ctx(0))
    tracker.apply(
      [resolved({ type: 'explosion', action: 'lost' })],
      ctx(1, { parentTrackIds: [k!] }),
    )
    expect(tracker.get(k!)!.status).toBe('lost')
  })

  it('a channel\'s "ще …" object is never merged back into its own earlier one', () => {
    const { tracker } = setup()
    const [a] = tracker.apply(
      [resolved({ type: 'shahed', location: 'Смоляне', toward: 'Долинське' })],
      ctx(0),
    )
    // Same channel, a minute later, right there: "Ще БпЛА повз Смоляне на Долинське".
    const [b] = tracker.apply(
      [resolved({ type: 'shahed', action: 'new', location: 'Смоляне', toward: 'Долинське' })],
      ctx(1),
    )
    expect(b).not.toBe(a)
    tracker.tick(min(2))
    expect(tracker.active().filter((t) => t.type === 'shahed')).toHaveLength(2)
  })
})
