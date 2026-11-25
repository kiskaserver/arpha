import { type ActiveAlert, destination, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Notifier, type Sinks } from '../src/lib/notify'
import { DEFAULT_SETTINGS, type Settings } from '../src/lib/settings'

const NOW = 1_800_000_000_000
const HOME = { id: 'h', name: 'Дім', ...ZAPORIZHZHIA }

function sinks() {
  return {
    sound: vi.fn(),
    vibrate: vi.fn(),
    flash: vi.fn(),
    speak: vi.fn(),
    show: vi.fn(),
  } satisfies Sinks
}

const settings = (o: Partial<Settings> = {}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  points: [HOME],
  ...o,
})

const alert = (o: Partial<ActiveAlert> = {}): ActiveAlert => ({
  id: 1,
  locationTitle: 'м. Запоріжжя',
  locationType: 'city',
  locationUid: '1',
  alertType: 'air_raid',
  level: 'red',
  threats: [],
  startedAt: NOW,
  featureIds: ['r1'],
  ...o,
})

const track = (o: Partial<Track> = {}): Track => ({
  id: 't1',
  type: 'shahed',
  count: 1,
  status: 'active',
  position: destination(ZAPORIZHZHIA, 180, 20),
  speedKmh: 180,
  headingDeg: 0,
  stateAt: NOW,
  uncertaintyKm: 2,
  placeName: null,
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

describe('Notifier', () => {
  it('alerts covering my area: sound, vibration, banner; repeats are suppressed', () => {
    const s = sinks()
    const n = new Notifier(s)
    n.alerts([], [alert()], ['r1'], settings(), NOW)
    n.alerts([], [alert()], ['r1'], settings(), NOW + 1000)
    expect(s.show).toHaveBeenCalledOnce()
    expect(s.show.mock.calls[0]![0]).toMatchObject({
      category: 'alert',
      title: 'Повітряна тривога: м. Запоріжжя',
    })
    expect(s.sound).toHaveBeenCalledWith('alert')
    expect(s.vibrate).toHaveBeenCalled()
    expect(s.flash).not.toHaveBeenCalled()
    expect(s.speak).not.toHaveBeenCalled()
  })

  it('ignores alerts elsewhere; oblast-wide counts when no points are set', () => {
    const s = sinks()
    const n = new Notifier(s)
    n.alerts([], [alert({ featureIds: ['r9'] })], ['r1'], settings(), NOW)
    expect(s.show).not.toHaveBeenCalled()
    n.alerts([], [alert({ id: 2, locationType: 'oblast' })], [], settings({ points: [] }), NOW)
    expect(s.show).toHaveBeenCalledOnce()
  })

  it('a missile threat added to an active alert is a ballistic alert with flash and voice', () => {
    const s = sinks()
    const n = new Notifier(s)
    const before = alert()
    const after = alert({
      threats: [{ type: 'ballistic_missiles', level: 'red', startedAt: NOW, message: null }],
    })
    n.alerts([before], [after], ['r1'], settings({ flash: true, speak: true }), NOW)
    expect(s.show.mock.calls[0]![0]).toMatchObject({ category: 'ballistic' })
    expect(s.flash).toHaveBeenCalledWith('ballistic')
    expect(s.speak.mock.calls[0]![0]).toContain('Балістика')
    // Not if the user disabled missile notifications.
    const s2 = sinks()
    new Notifier(s2).alerts([before], [after], ['r1'], settings({ classes: ['kab'] }), NOW)
    expect(s2.show).not.toHaveBeenCalled()
  })

  it('threat heading for one of my points within 15 min', () => {
    const s = sinks()
    const n = new Notifier(s)
    n.track(
      track(),
      [HOME],
      settings({ sounds: { alert: 'off', ballistic: 'off', threat: 'off' } }),
      NOW,
    )
    expect(s.show.mock.calls[0]![0].title).toMatch(/^Шахед → Дім, через \d+ хв$/)
    expect(s.sound).not.toHaveBeenCalled()
  })

  it('no alert for far, receding, inactive or filtered threats, or without points', () => {
    const s = sinks()
    const n = new Notifier(s)
    n.track(track({ position: destination(ZAPORIZHZHIA, 180, 200) }), [HOME], settings(), NOW)
    n.track(track({ id: 't2', headingDeg: 180 }), [HOME], settings(), NOW)
    n.track(track({ id: 't3', status: 'lost' }), [HOME], settings(), NOW)
    n.track(track({ id: 't4' }), [HOME], settings({ classes: ['kab'] }), NOW)
    n.track(track({ id: 't5' }), [], settings(), NOW)
    expect(s.show).not.toHaveBeenCalled()
  })

  it('ballistic warning near my point, with the direction', () => {
    const s = sinks()
    const n = new Notifier(s)
    n.track(
      track({
        type: 'ballistic',
        position: null,
        target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
        origin: { name: 'Крим', lat: 45, lon: 34 },
      }),
      [HOME],
      settings(),
      NOW,
    )
    expect(s.show.mock.calls[0]![0]).toMatchObject({
      category: 'ballistic',
      title: 'Загроза балістики, з боку Крим',
    })
    n.track(
      track({ id: 'x', type: 'ballistic', position: null, target: null }),
      [HOME],
      settings(),
      NOW,
    )
    n.track(
      track({
        id: 'y',
        type: 'ballistic',
        position: null,
        target: { name: 'Бердянськ', lat: 46.75, lon: 36.78 },
      }),
      [HOME],
      settings(),
      NOW,
    )
    expect(s.show).toHaveBeenCalledOnce()
  })
})
