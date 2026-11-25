import { resolve } from 'node:path'
import { destination, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { pushSubscriptionSchema } from '@arpha/shared/schemas'
import { describe, expect, it, vi } from 'vitest'
import { Boundaries } from '../src/alerts/boundaries'
import { NO_DIFF, parseAlerts } from '../src/alerts/service'
import { Store } from '../src/db'
import { silentLogger } from '../src/logger'
import { PushGoneError, type PushSender, PushService } from '../src/push/service'
import { min } from './helpers'

const boundaries = Boundaries.load(
  resolve(import.meta.dirname, '../../web/public/boundaries.geojson'),
)
const BERDIANSK = { lat: 46.75, lon: 36.78 }

function setup(send: PushSender = vi.fn(async () => {})) {
  const store = new Store(':memory:')
  let now = min(0)
  const svc = new PushService({ store, boundaries, send, logger: silentLogger, now: () => now })
  return { svc, store, send: send as ReturnType<typeof vi.fn>, setNow: (n: number) => (now = n) }
}

const sub = (endpoint: string, extra: Record<string, unknown> = {}) =>
  pushSubscriptionSchema.parse({
    subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
    points: [{ name: 'Дім', ...ZAPORIZHZHIA }],
    radiusKm: 10,
    ...extra,
  })

const incoming = (overrides: Partial<Track> = {}): Track => ({
  id: 't1',
  type: 'shahed',
  count: 2,
  status: 'active',
  position: destination(ZAPORIZHZHIA, 180, 40),
  speedKmh: 180,
  headingDeg: 0,
  stateAt: min(0),
  uncertaintyKm: 2,
  placeName: 'Балабине',
  target: null,
  origin: null,
  prediction: null,
  confidence: 0.8,
  sources: [],
  createdAt: min(0),
  updatedAt: min(0),
  ...overrides,
})

const alert = (id: number, type: string, title: string, threats: unknown[] = []) =>
  parseAlerts(
    {
      alerts: [
        {
          id,
          location_title: title,
          location_type: type,
          location_uid: String(id),
          location_oblast: 'Запорізька область',
          alert_type: 'air_raid',
          started_at: '2026-11-25T00:00:00Z',
          threats,
        },
      ],
    },
    (a) => boundaries.match(a),
  )[0]!

describe('PushService', () => {
  it('rounds points, resolves their polygons; persists, reloads and migrates', () => {
    const { svc, store } = setup()
    const s = svc.subscribe(
      sub('https://push/1', { points: [{ name: 'Дім', lat: 47.83881234, lon: 35.13961234 }] }),
    )
    expect(s.points[0]).toMatchObject({ name: 'Дім', lat: 47.84, lon: 35.14 })
    expect(s.points[0]!.featureIds).toHaveLength(3)
    // A subscription stored by the previous version (single point).
    store.saveSubscription('https://push/old', {
      subscription: { endpoint: 'https://push/old', keys: { p256dh: 'p', auth: 'a' } },
      point: ZAPORIZHZHIA,
      featureIds: ['r71980'],
      radiusKm: 10,
      alerts: true,
      threats: true,
    })
    const reloaded = new PushService({ store, boundaries, send: vi.fn(), logger: silentLogger })
    expect(reloaded.size).toBe(2)
    reloaded.unsubscribe('https://push/1')
    expect(reloaded.size).toBe(1)
  })

  it('legacy single `point` input becomes a named point', () => {
    const parsed = pushSubscriptionSchema.parse({
      subscription: { endpoint: 'https://x/1', keys: { p256dh: 'p', auth: 'a' } },
      point: ZAPORIZHZHIA,
    })
    expect(parsed.points).toEqual([{ ...ZAPORIZHZHIA, name: 'Моя точка' }])
    expect(parsed.classes).toContain('kab')
  })

  it('notifies about alerts covering one of the points, naming it and the official threats', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/city'))
    svc.subscribe(sub('https://push/far', { points: [{ name: 'Дача', ...BERDIANSK }] }))
    const a = alert(1, 'city', 'м. Запоріжжя', [
      { threat_type: 'guided_aerial_bombs', level: 'red', started_at: '2026-11-25T00:00:00Z' },
    ])
    await svc.onAlerts({ ...NO_DIFF, started: [a] })
    expect(send).toHaveBeenCalledOnce()
    const [target, payload] = send.mock.calls[0]!
    expect(target.endpoint).toBe('https://push/city')
    expect(payload).toMatchObject({ title: '🚨 Повітряна тривога · Дім', kind: 'alert' })
    expect(payload.body).toContain('КАБи')

    await svc.onAlerts({ ...NO_DIFF, ended: [a] })
    expect(send.mock.calls[1]![1]).toMatchObject({ title: '✅ Відбій тривоги', kind: 'clear' })
  })

  it('a new official threat on an active alert (ballistic) is pushed if its class is enabled', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1'))
    svc.subscribe(sub('https://push/2', { classes: ['drones'] }))
    const a = alert(1, 'oblast', 'Запорізька область')
    await svc.onAlerts({
      ...NO_DIFF,
      threatsAdded: [
        {
          alert: a,
          threat: {
            type: 'ballistic_missiles',
            level: 'red',
            startedAt: 0,
            message: 'Загроза балістики',
          },
        },
      ],
    })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![1]).toMatchObject({ title: '🚀 Балістика', kind: 'ballistic' })
  })

  it('without points only oblast-wide alerts are sent', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/x', { points: [] }))
    await svc.onAlerts({ ...NO_DIFF, started: [alert(2, 'raion', 'Пологівський район')] })
    expect(send).not.toHaveBeenCalled()
    await svc.onAlerts({ ...NO_DIFF, started: [alert(3, 'oblast', 'Запорізька область')] })
    expect(send).toHaveBeenCalledOnce()
  })

  it('warns about an incoming threat once per 10 min, naming the nearest point', async () => {
    const { svc, send, setNow } = setup()
    svc.subscribe(
      sub('https://push/1', {
        points: [
          { name: 'Робота', ...BERDIANSK },
          { name: 'Дім', ...ZAPORIZHZHIA },
        ],
      }),
    )
    await svc.onTrack(incoming())
    await svc.onTrack(incoming())
    expect(send).toHaveBeenCalledOnce()
    const payload = send.mock.calls[0]![1]
    expect(payload.title).toBe('⚠️ Шахеди ×2 → Дім')
    expect(payload.body).toMatch(/^~10 хв, 40 км · біля Балабине$/)
    expect(payload.url).toBe('/?track=t1')
    setNow(min(11))
    await svc.onTrack(incoming({ stateAt: min(11) }))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('respects per-class filters', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1', { classes: ['kab'] }))
    await svc.onTrack(incoming())
    expect(send).not.toHaveBeenCalled()
  })

  it('ballistic warning near a point includes the launch direction', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1'))
    await svc.onTrack(
      incoming({
        type: 'ballistic',
        position: null,
        speedKmh: null,
        headingDeg: null,
        target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
        origin: { name: 'Крим', lat: 45.6, lon: 34.3 },
      }),
    )
    const payload = send.mock.calls[0]![1]
    expect(payload).toMatchObject({ title: '🚀 Загроза балістики · Дім', kind: 'ballistic' })
    expect(payload.body).toContain('з боку Крим')
    // Far from the target: no warning.
    const far = setup()
    far.svc.subscribe(sub('https://push/2', { points: [{ name: 'Дача', ...BERDIANSK }] }))
    await far.svc.onTrack(
      incoming({
        type: 'ballistic',
        position: null,
        target: { name: 'Запоріжжя', ...ZAPORIZHZHIA },
      }),
    )
    expect(far.send).not.toHaveBeenCalled()
  })

  it('skips receding, inactive, far-future, explosion and opted-out cases', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1'))
    svc.subscribe(sub('https://push/2', { threats: false }))
    svc.subscribe(sub('https://push/3', { points: [] }))
    await svc.onTrack(incoming({ headingDeg: 180 }))
    await svc.onTrack(incoming({ status: 'destroyed' }))
    await svc.onTrack(incoming({ type: 'explosion' }))
    await svc.onTrack(incoming({ id: 't2', position: destination(ZAPORIZHZHIA, 180, 400) }))
    await svc.onTrack(incoming({ id: 't3', type: 'ballistic', position: null, target: null }))
    expect(send).not.toHaveBeenCalled()
  })

  it('"already near" wording inside the radius', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1'))
    await svc.onTrack(incoming({ position: destination(ZAPORIZHZHIA, 180, 3), placeName: null }))
    expect(send.mock.calls[0]![1].body).toBe('вже поруч, 3 км')
  })

  it('drops gone subscriptions and survives transient errors', async () => {
    const send = vi
      .fn<PushSender>()
      .mockRejectedValueOnce(new PushGoneError('410'))
      .mockRejectedValueOnce(new Error('network'))
    const { svc } = setup(send)
    svc.subscribe(sub('https://push/gone'))
    await svc.onAlerts({ ...NO_DIFF, started: [alert(3, 'oblast', 'Запорізька область')] })
    expect(svc.size).toBe(0)
    svc.subscribe(sub('https://push/flaky'))
    await expect(
      svc.onAlerts({ ...NO_DIFF, started: [alert(4, 'oblast', 'Запорізька область')] }),
    ).resolves.toBeUndefined()
    expect(svc.size).toBe(1)
  })

  it('ignores subscribers who opted out of alerts', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1', { alerts: false }))
    await svc.onAlerts({ ...NO_DIFF, started: [alert(3, 'oblast', 'Запорізька область')] })
    expect(send).not.toHaveBeenCalled()
  })
})
