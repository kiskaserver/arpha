import { resolve } from 'node:path'
import { ZAPORIZHZHIA } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Boundaries } from '../src/alerts/boundaries'
import { AlertsService, diffAlerts, parseAlerts } from '../src/alerts/service'
import { silentLogger } from '../src/logger'

const boundaries = Boundaries.load(
  resolve(import.meta.dirname, '../../web/public/boundaries.geojson'),
)

const raw = (o: Record<string, unknown>) => ({
  id: 1,
  location_title: 'Запорізька область',
  location_type: 'oblast',
  location_uid: '12',
  location_oblast: 'Запорізька область',
  location_oblast_uid: 12,
  alert_type: 'air_raid',
  started_at: '2026-11-25T00:00:00.000Z',
  finished_at: null,
  ...o,
})

describe('parseAlerts', () => {
  it('keeps active oblast alerts only and skips malformed items', () => {
    const out = parseAlerts({
      alerts: [
        raw({
          id: 3,
          location_title: 'Вільнянська територіальна громада',
          location_type: 'hromada',
        }),
        raw({ id: 1 }),
        raw({ id: 2, location_oblast: 'Київська область', location_oblast_uid: 14 }),
        raw({ id: 4, finished_at: '2026-11-25T01:00:00.000Z' }),
        raw({ id: 5, location_type: 'country' }),
        { id: 'bad' },
      ],
    })
    expect(out.map((a) => a.id)).toEqual([1, 3])
    expect(out[0]).toMatchObject({
      locationType: 'oblast',
      startedAt: Date.parse('2026-11-25T00:00:00Z'),
    })
  })

  it('throws on a broken envelope', () => {
    expect(() => parseAlerts({ nope: 1 })).toThrow()
  })

  it('diffs started/ended', () => {
    const a = parseAlerts({ alerts: [raw({ id: 1 }), raw({ id: 2 })] })
    const b = parseAlerts({ alerts: [raw({ id: 2 }), raw({ id: 3 })] })
    const d = diffAlerts(a, b)
    expect(d.started.map((x) => x.id)).toEqual([3])
    expect(d.ended.map((x) => x.id)).toEqual([1])
  })
})

describe('Boundaries', () => {
  it('has the oblast, 5 raions and the hromadas', () => {
    const kinds = boundaries.features.map((f) => f.kind)
    expect(kinds.filter((k) => k === 'oblast')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'raion')).toHaveLength(5)
    expect(kinds.filter((k) => k === 'hromada').length).toBeGreaterThan(60)
  })

  it.each([
    ['oblast', 'Запорізька область', ['Запорізька область']],
    ['raion', 'Пологівський район', ['Пологівський район']],
    ['hromada', 'Вільнянська територіальна громада', ['Вільнянська міська громада']],
    ['city', 'м. Запоріжжя та Запорізька територіальна громада', ['Запорізька міська громада']],
    [
      'hromada',
      "Кам'янсько-Дніпровська територіальна громада",
      ["Кам'янсько-Дніпровська міська громада"],
    ],
  ] as const)('%s "%s" → polygon', (type, title, names) => {
    const ids = boundaries.match({ locationType: type, locationTitle: title })
    const matched = boundaries.features.filter((f) => ids.includes(f.id)).map((f) => f.name)
    expect(matched).toEqual(names)
  })

  it('finds the containing polygons for a point, most specific first', () => {
    const kinds = boundaries.containing(ZAPORIZHZHIA).map((f) => `${f.kind}:${f.name}`)
    expect(kinds).toEqual([
      'hromada:Запорізька міська громада',
      'raion:Запорізький район',
      'oblast:Запорізька область',
    ])
    expect(boundaries.containing({ lat: 50.45, lon: 30.52 })).toEqual([])
  })

  it('empty() is usable', () => {
    expect(Boundaries.empty().match({ locationType: 'oblast', locationTitle: 'x' })).toEqual([])
  })
})

describe('AlertsService', () => {
  const okResponse = (alerts: unknown[], lastModified = 'Wed, 25 Nov 2026 00:00:00 GMT') =>
    new Response(JSON.stringify({ alerts }), {
      status: 200,
      headers: { 'last-modified': lastModified, 'content-type': 'application/json' },
    })

  it('polls with the token, publishes changes, honours 304', async () => {
    const onChange = vi.fn()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse([raw({ id: 1 })]))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(okResponse([]))
    const svc = new AlertsService({
      token: 'tok',
      pollMs: 20_000,
      logger: silentLogger,
      fetch: fetchFn,
      match: (a) => boundaries.match(a),
      onChange,
      now: () => 42,
    })
    await svc.poll()
    expect(svc.state).toMatchObject({ stale: false, updatedAt: 42 })
    expect(svc.state.alerts[0]!.featureIds).toEqual(['r71980'])
    const init = fetchFn.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')

    await svc.poll()
    expect(
      (fetchFn.mock.calls[1]![1]!.headers as Record<string, string>)['If-Modified-Since'],
    ).toBeDefined()
    expect(onChange).toHaveBeenCalledTimes(1)

    await svc.poll()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[1]![1].ended).toHaveLength(1)
  })

  it('does not republish identical state', async () => {
    const onChange = vi.fn()
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse([raw({ id: 1 })]))
    const svc = new AlertsService({
      token: 't',
      pollMs: 1,
      logger: silentLogger,
      fetch: fetchFn,
      onChange,
    })
    await svc.poll()
    await svc.poll()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('marks the state stale after repeated failures', async () => {
    const onChange = vi.fn()
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValue(new Response('nope', { status: 500 }))
    const svc = new AlertsService({
      token: 't',
      pollMs: 1,
      logger: silentLogger,
      fetch: fetchFn,
      onChange,
    })
    await svc.poll()
    await svc.poll()
    await svc.poll()
    expect(svc.state.stale).toBe(false)
    await svc.poll()
    expect(svc.state.stale).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('304 after a stale period clears staleness', async () => {
    const onChange = vi.fn()
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }))
    const svc = new AlertsService({
      token: 't',
      pollMs: 1,
      logger: silentLogger,
      fetch: fetchFn,
      onChange,
    })
    await svc.poll()
    expect(svc.state.stale).toBe(false)
  })

  it('is inert without a token', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const svc = new AlertsService({ pollMs: 1, logger: silentLogger, fetch: fetchFn })
    expect(svc.enabled).toBe(false)
    await svc.poll()
    svc.start()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('start() loops with backoff and stop() halts it', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn<typeof fetch>(async () => okResponse([]))
      const svc = new AlertsService({
        token: 't',
        pollMs: 10_000,
        logger: silentLogger,
        fetch: fetchFn,
      })
      svc.start()
      svc.start() // idempotent
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      svc.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('set() publishes demo alerts', () => {
    const onChange = vi.fn()
    const svc = new AlertsService({ pollMs: 1, logger: silentLogger, onChange })
    svc.set(parseAlerts({ alerts: [raw({})] }))
    expect(onChange).toHaveBeenCalledOnce()
    expect(svc.state.alerts).toHaveLength(1)
  })
})
