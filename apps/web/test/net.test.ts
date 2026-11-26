import { afterEach, describe, expect, it, vi } from 'vitest'
import { uk } from '../src/lib/i18n'
import { disablePush, enablePush, type PushEnv, pushSupported } from '../src/lib/push'
import { LiveStream } from '../src/lib/stream'

class FakeES {
  static last: FakeES
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((m: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeES.last = this
  }
  close() {
    this.closed = true
  }
  emit(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>)
  }
}

describe('LiveStream', () => {
  afterEach(() => vi.useRealTimers())

  it('reports status and forwards valid events only', () => {
    const onEvent = vi.fn()
    const onStatus = vi.fn()
    const s = new LiveStream({ onEvent, onStatus, EventSourceImpl: FakeES as never })
    s.start()
    expect(FakeES.last.url).toBe('/api/stream')
    FakeES.last.onopen!()
    expect(s.status).toBe('online')
    FakeES.last.emit('{"type":"track_removed","id":"x"}')
    FakeES.last.emit('not json')
    FakeES.last.emit('{"type":"weird"}')
    expect(onEvent).toHaveBeenCalledTimes(1)
    FakeES.last.onerror!()
    expect(onStatus).toHaveBeenLastCalledWith('offline')
    s.stop()
    expect(FakeES.last.closed).toBe(true)
  })

  it('reconnects when the server closes the stream', () => {
    vi.useFakeTimers()
    const s = new LiveStream({
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      EventSourceImpl: FakeES as never,
    })
    s.start()
    const first = FakeES.last
    first.readyState = 2
    first.onerror!()
    vi.advanceTimersByTime(5000)
    expect(FakeES.last).not.toBe(first)
    s.stop()
  })

  it('watchdog replaces a silent connection', () => {
    vi.useFakeTimers()
    const s = new LiveStream({
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      EventSourceImpl: FakeES as never,
      staleMs: 1000,
    })
    s.start()
    const first = FakeES.last
    vi.advanceTimersByTime(2100)
    expect(FakeES.last).not.toBe(first)
    expect(first.closed).toBe(true)
    s.stop()
  })
})

describe('push', () => {
  const sub = {
    endpoint: 'https://push.example/1',
    toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  }

  function env(overrides: Partial<PushEnv> = {}, existing: typeof sub | null = null) {
    const fetchFn = vi.fn(async (url: string) =>
      url === '/api/push/key'
        ? Response.json({ publicKey: 'BEl6-_xQ' })
        : new Response('{}', { status: 201 }),
    )
    const pushManager = {
      getSubscription: vi.fn(async () => existing),
      subscribe: vi.fn(async () => sub),
    }
    return {
      fetchFn,
      pushManager,
      env: {
        fetch: fetchFn as unknown as typeof fetch,
        serviceWorker: {
          ready: Promise.resolve({ pushManager }),
        } as unknown as ServiceWorkerContainer,
        Notification: { requestPermission: async () => 'granted' as NotificationPermission },
        hasPushManager: true,
        sleep: async () => {},
        ...overrides,
      },
    }
  }

  const prefs = {
    points: [],
    radiusKm: 10,
    alerts: true,
    threats: true,
    classes: ['drones' as const],
  }

  it('detects support', () => {
    expect(pushSupported(env().env)).toBe(true)
    expect(pushSupported(env({ hasPushManager: false }).env)).toBe(false)
  })

  it('subscribes with the VAPID key and registers preferences', async () => {
    const e = env()
    expect(await enablePush(prefs, e.env)).toEqual({ ok: true })
    const key = (
      e.pushManager.subscribe.mock.calls[0] as unknown as [{ applicationServerKey: Uint8Array }]
    )[0].applicationServerKey
    expect(key).toBeInstanceOf(Uint8Array)
    const body = JSON.parse(
      (e.fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    )
    expect(body).toMatchObject({
      radiusKm: 10,
      subscription: { endpoint: 'https://push.example/1' },
    })
  })

  it('reuses an existing subscription', async () => {
    const e = env({}, sub)
    await enablePush(prefs, e.env)
    expect(e.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('maps failures to reasons', async () => {
    expect(await enablePush(prefs, env({ hasPushManager: false }).env)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(
      await enablePush(
        prefs,
        env({ fetch: (async () => new Response('', { status: 404 })) as typeof fetch }).env,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' })
    expect(
      await enablePush(
        prefs,
        env({ Notification: { requestPermission: async () => 'denied' } }).env,
      ),
    ).toEqual({ ok: false, reason: 'denied' })
    expect(
      await enablePush(
        prefs,
        env({
          fetch: (async (url: string) =>
            url === '/api/push/key'
              ? Response.json({ publicKey: 'AA' })
              : new Response('', { status: 400 })) as typeof fetch,
        }).env,
      ),
    ).toEqual({ ok: false, reason: 'server', detail: '400' })
    expect(
      await enablePush(
        prefs,
        env({ fetch: (async () => Promise.reject(new TypeError('net'))) as typeof fetch }).env,
      ),
    ).toEqual({ ok: false, reason: 'failed', detail: 'TypeError' })
  })

  it('replaces a subscription made with another server key', async () => {
    const old = {
      ...sub,
      options: { applicationServerKey: new Uint8Array([9, 9]).buffer },
      unsubscribe: vi.fn(async () => true),
    }
    const e = env({}, old)
    expect(await enablePush(prefs, e.env)).toEqual({ ok: true })
    expect(old.unsubscribe).toHaveBeenCalled()
    expect(e.pushManager.subscribe).toHaveBeenCalledOnce()
  })

  it('a failing unsubscribe of the stale subscription does not block a new one', async () => {
    const old = {
      ...sub,
      options: { applicationServerKey: new Uint8Array([1]).buffer },
      unsubscribe: vi.fn(async () => Promise.reject(new Error('gone'))),
    }
    const e = env({}, old)
    e.pushManager.subscribe.mockRejectedValueOnce(new DOMException('stale', 'InvalidStateError'))
    expect(await enablePush(prefs, e.env)).toEqual({ ok: true })
    expect(e.pushManager.subscribe).toHaveBeenCalledTimes(2)
  })

  it('explains each failure in Ukrainian, with the error to report', () => {
    expect(uk.pushSubscribeFailed('AbortError')).toContain('(AbortError)')
    expect(uk.pushSubscribeFailed()).not.toContain('(')
    expect(uk.pushServerFailed('400')).toBe('Сервер не прийняв підписку (код 400)')
    expect(uk.pushServerFailed()).toBe('Сервер не прийняв підписку')
    expect(uk.pushFailed('TypeError')).toBe('Не вдалося увімкнути сповіщення (TypeError)')
    expect(uk.pushFailed()).toBe('Не вдалося увімкнути сповіщення')
    expect(uk.zoneDefault(15)).toBe('типово, 15 км')
    expect(uk.quiet(12)).toBe('немає даних 12 хв')
  })

  it('retries once after a push-service error, then reports it', async () => {
    const flaky = env()
    flaky.pushManager.subscribe.mockRejectedValueOnce(
      new DOMException('push service error', 'AbortError'),
    )
    expect(await enablePush(prefs, flaky.env)).toEqual({ ok: true })
    expect(flaky.pushManager.subscribe).toHaveBeenCalledTimes(2)

    const broken = env()
    broken.pushManager.subscribe.mockRejectedValue(
      new DOMException('Registration failed - push service not available', 'AbortError'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await enablePush(prefs, broken.env)).toEqual({
      ok: false,
      reason: 'subscribe',
      detail: 'AbortError',
      standalone: false,
    })
    // In the installed app the user also gets the Android-side checklist.
    const app = env({ standalone: true })
    app.pushManager.subscribe.mockRejectedValue(new DOMException('x', 'AbortError'))
    expect(await enablePush(prefs, app.env)).toMatchObject({
      reason: 'subscribe',
      standalone: true,
    })
    expect(uk.pushStandaloneHelp).toContain('Приватний DNS')
    warn.mockRestore()
  })

  it('unsubscribes on the server and locally', async () => {
    const e = env({}, sub)
    await disablePush(e.env)
    expect(e.fetchFn).toHaveBeenCalledWith('/api/push/unsubscribe', expect.anything())
    expect(sub.unsubscribe).toHaveBeenCalled()
    await disablePush(env().env) // no subscription: no-op
    await disablePush({ ...env().env, serviceWorker: undefined })
  })
})
