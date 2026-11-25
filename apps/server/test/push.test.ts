import { resolve } from 'node:path'
import { destination, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Boundaries } from '../src/alerts/boundaries'
import { parseAlerts } from '../src/alerts/service'
import { Store } from '../src/db'
import { silentLogger } from '../src/logger'
import { PushGoneError, type PushSender, PushService } from '../src/push/service'
import { min } from './helpers'

const boundaries = Boundaries.load(
  resolve(import.meta.dirname, '../../web/public/boundaries.geojson'),
)

function setup(send: PushSender = vi.fn(async () => {})) {
  const store = new Store(':memory:')
  let now = min(0)
  const svc = new PushService({ store, boundaries, send, logger: silentLogger, now: () => now })
  return { svc, store, send: send as ReturnType<typeof vi.fn>, setNow: (n: number) => (now = n) }
}

const sub = (endpoint: string, point: { lat: number; lon: number } | null = ZAPORIZHZHIA) => ({
  subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
  point,
  radiusKm: 10,
  alerts: true,
  threats: true,
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
  confidence: 0.8,
  sources: [],
  createdAt: min(0),
  updatedAt: min(0),
  ...overrides,
})

const alert = (id: number, type: string, title: string) =>
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
        },
      ],
    },
    (a) => boundaries.match(a),
  )[0]!

describe('PushService', () => {
  it('rounds the point and resolves its polygons; persists and reloads', () => {
    const { svc, store } = setup()
    const s = svc.subscribe(sub('https://push/1', { lat: 47.83881234, lon: 35.13961234 }))
    expect(s.point).toEqual({ lat: 47.84, lon: 35.14 })
    expect(s.featureIds.length).toBe(3)
    const reloaded = new PushService({ store, boundaries, send: vi.fn(), logger: silentLogger })
    expect(reloaded.size).toBe(1)
    reloaded.unsubscribe('https://push/1')
    expect(reloaded.size).toBe(0)
  })

  it('notifies about alerts covering the subscriber only', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/city'))
    svc.subscribe(sub('https://push/far', { lat: 46.75, lon: 36.78 })) // Berdiansk
    await svc.onAlerts({
      started: [alert(1, 'city', 'м. Запоріжжя та Запорізька територіальна громада')],
      ended: [],
    })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0].endpoint).toBe('https://push/city')
    expect(send.mock.calls[0]![1].title).toContain('Повітряна тривога')

    await svc.onAlerts({
      started: [],
      ended: [alert(1, 'city', 'м. Запоріжжя та Запорізька територіальна громада')],
    })
    expect(send.mock.calls[1]![1].title).toContain('Відбій')
  })

  it('without a point only oblast-wide alerts are sent', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/x', null))
    await svc.onAlerts({ started: [alert(2, 'raion', 'Пологівський район')], ended: [] })
    expect(send).not.toHaveBeenCalled()
    await svc.onAlerts({ started: [alert(3, 'oblast', 'Запорізька область')], ended: [] })
    expect(send).toHaveBeenCalledOnce()
  })

  it('warns about an incoming threat once per 10 min', async () => {
    const { svc, send, setNow } = setup()
    svc.subscribe(sub('https://push/1'))
    await svc.onTrack(incoming())
    await svc.onTrack(incoming())
    expect(send).toHaveBeenCalledOnce()
    const payload = send.mock.calls[0]![1]
    expect(payload.title).toBe('⚠️ Шахеди ×2 у ваш бік')
    expect(payload.body).toMatch(/^~10 хв, 40 км · біля Балабине$/)
    expect(payload.url).toBe('/?track=t1')
    setNow(min(11))
    await svc.onTrack(incoming({ stateAt: min(11), position: destination(ZAPORIZHZHIA, 180, 40) }))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('skips receding, inactive, far-future and opted-out cases', async () => {
    const { svc, send } = setup()
    svc.subscribe(sub('https://push/1'))
    svc.subscribe({ ...sub('https://push/2'), threats: false })
    svc.subscribe(sub('https://push/3', null))
    await svc.onTrack(incoming({ headingDeg: 180 }))
    await svc.onTrack(incoming({ status: 'destroyed' }))
    await svc.onTrack(incoming({ id: 't2', position: destination(ZAPORIZHZHIA, 180, 400) }))
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
    await svc.onAlerts({ started: [alert(3, 'oblast', 'Запорізька область')], ended: [] })
    expect(svc.size).toBe(0)
    svc.subscribe(sub('https://push/flaky'))
    await expect(
      svc.onAlerts({ started: [alert(4, 'oblast', 'Запорізька область')], ended: [] }),
    ).resolves.toBeUndefined()
    expect(svc.size).toBe(1)
  })

  it('ignores subscribers who opted out of alerts', async () => {
    const { svc, send } = setup()
    svc.subscribe({ ...sub('https://push/1'), alerts: false })
    await svc.onAlerts({ started: [alert(3, 'oblast', 'Запорізька область')], ended: [] })
    expect(send).not.toHaveBeenCalled()
  })
})
