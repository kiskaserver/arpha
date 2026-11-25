import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent, Track } from '@arpha/shared'
import { describe, expect, it, vi } from 'vitest'
import { Boundaries } from '../src/alerts/boundaries'
import { EventBus } from '../src/bus'
import { Store } from '../src/db'
import { type AppDeps, createApp } from '../src/http/app'
import { silentLogger } from '../src/logger'
import { PushService } from '../src/push/service'

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    tracks: () => [],
    alerts: () => ({ alerts: [], updatedAt: 1, stale: false }),
    bus: new EventBus(),
    logger: silentLogger,
    demo: false,
    health: () => ({ tracks: 0 }),
    now: () => 1000,
    ...overrides,
  }
}

/** Read SSE frames from a streaming response until `count` data events arrive. */
async function readEvents(res: Response, count: number): Promise<StreamEvent[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const out: StreamEvent[] = []
  while (out.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx = buf.indexOf('\n\n')
    while (idx !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n')
      if (data) out.push(JSON.parse(data) as StreamEvent)
      idx = buf.indexOf('\n\n')
    }
  }
  await reader.cancel()
  return out
}

describe('HTTP API', () => {
  it('health and state', async () => {
    const app = createApp(deps({ demo: true }))
    const health = await (await app.request('/api/health')).json()
    expect(health).toMatchObject({ ok: true, demo: true, tracks: 0, streams: 0 })
    const res = await app.request('/api/state')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ type: 'snapshot', serverTime: 1000, demo: true })
  })

  it('sets a strict CSP and security headers', async () => {
    const res = await createApp(deps()).request('/api/health')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('https://tiles.openfreemap.org')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('streams a snapshot then live events over SSE', async () => {
    const bus = new EventBus()
    const app = createApp(deps({ bus }))
    const res = await app.request('/api/stream')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('content-encoding')).toBeNull()
    const track = { id: 'x' } as Track
    setTimeout(() => {
      bus.publish({ type: 'track', track })
      bus.publish({ type: 'track_removed', id: 'x' })
    }, 20)
    const events = await readEvents(res, 3)
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'track', 'track_removed'])
    await new Promise((r) => setTimeout(r, 20))
    expect(bus.listenerCount).toBe(0)
  })

  it('sends heartbeats', async () => {
    const app = createApp(deps({ heartbeatMs: 10 }))
    const res = await app.request('/api/stream')
    const reader = res.body!.getReader()
    let text = ''
    while (!text.includes(': ping')) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
  })

  it('caps concurrent streams', async () => {
    const app = createApp(deps({ maxStreams: 1 }))
    const first = await app.request('/api/stream')
    await new Promise((r) => setTimeout(r, 10))
    const second = await app.request('/api/stream')
    expect(second.status).toBe(503)
    await first.body!.cancel()
  })

  it('push endpoints are 404 when disabled', async () => {
    const app = createApp(deps())
    expect((await app.request('/api/push/key')).status).toBe(404)
    expect((await app.request('/api/push/subscribe', { method: 'POST', body: '{}' })).status).toBe(
      404,
    )
    expect(
      (await app.request('/api/push/unsubscribe', { method: 'POST', body: '{}' })).status,
    ).toBe(404)
  })

  it('push subscribe/unsubscribe validate input', async () => {
    const service = new PushService({
      store: new Store(':memory:'),
      boundaries: Boundaries.empty(),
      send: vi.fn(),
      logger: silentLogger,
    })
    const app = createApp(deps({ push: { service, publicKey: 'PUB' } }))
    expect(await (await app.request('/api/push/key')).json()).toEqual({ publicKey: 'PUB' })

    const bad = await app.request('/api/push/subscribe', { method: 'POST', body: 'nope' })
    expect(bad.status).toBe(400)

    const body = JSON.stringify({
      subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
      point: { lat: 47.8, lon: 35.1 },
    })
    const ok = await app.request('/api/push/subscribe', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    })
    expect(ok.status).toBe(201)
    expect(service.size).toBe(1)

    const tooBig = await app.request('/api/push/subscribe', {
      method: 'POST',
      body: 'x'.repeat(10_000),
      headers: { 'content-type': 'application/json' },
    })
    expect(tooBig.status).toBe(413)

    expect(
      (await app.request('/api/push/unsubscribe', { method: 'POST', body: '{"endpoint":1}' }))
        .status,
    ).toBe(400)
    const un = await app.request('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'https://push.example/1' }),
    })
    expect(un.status).toBe(200)
    expect(service.size).toBe(0)
  })

  it('unknown API routes are JSON 404', async () => {
    const res = await createApp(deps()).request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('serves the PWA with correct caching and SPA fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arpha-web-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Арфа</title>')
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
    writeFileSync(join(dir, 'sw.js'), 'self')
    const app = createApp(deps({ webDist: dir }))

    const asset = await app.request('/assets/app-abc123.js')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const sw = await app.request('/sw.js')
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    const deep = await app.request('/some/route')
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('Арфа')
    expect(deep.headers.get('cache-control')).toBe('no-cache')

    // Regression: a stale hashed asset must 404, not be served index.html with an immutable cache.
    const missing = await app.request('/assets/old-hash.js')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBeNull()
    expect((await app.request('/nope.png')).status).toBe(404)
  })

  it('maps thrown errors to 500 JSON', async () => {
    const app = createApp(
      deps({
        health: () => {
          throw new Error('boom')
        },
      }),
    )
    const res = await app.request('/api/health')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal error' })
  })
})
