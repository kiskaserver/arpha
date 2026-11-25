import { existsSync } from 'node:fs'
import type { AlertsState, FeedItem, Hotspot, InfraStatus, StreamEvent, Track } from '@arpha/shared'
import { pushSubscriptionSchema } from '@arpha/shared/schemas'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { compress } from 'hono/compress'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { EventBus } from '../bus'
import type { Logger } from '../logger'
import type { PushService } from '../push/service'
import { clientIp, RateLimiter, rateLimit, sameOriginJson } from './security'

export interface AppDeps {
  tracks: () => Track[]
  alerts: () => AlertsState
  infra?: () => InfraStatus[]
  feed?: () => FeedItem[]
  hotspots?: (days: number) => Hotspot[]
  patterns?: (days: number) => unknown
  bus: EventBus
  logger: Logger
  demo: boolean
  health: () => Record<string, unknown>
  push?: { service: PushService; publicKey: string } | undefined
  webDist?: string | undefined
  /** SSE heartbeat; proxies (Railway, Cloudflare) drop idle streams. */
  heartbeatMs?: number
  maxStreams?: number
  /** Concurrent SSE streams allowed from one visitor IP. */
  maxStreamsPerIp?: number
  /** Public origins allowed to POST (besides the request's own host). */
  allowedOrigins?: string[]
  now?: () => number
}

const TILE_HOSTS = 'https://tiles.openfreemap.org'

export function createApp(d: AppDeps): Hono {
  const app = new Hono()
  const now = d.now ?? Date.now
  let streams = 0
  const streamsByIp = new Map<string, number>()
  const apiLimit = new RateLimiter(240, 60_000, now)
  const pushLimit = new RateLimiter(20, 60_000, now)

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', TILE_HOSTS],
        connectSrc: ["'self'", TILE_HOSTS],
        fontSrc: ["'self'", TILE_HOSTS],
        workerSrc: ["'self'", 'blob:'],
        childSrc: ['blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
      permissionsPolicy: { geolocation: ['self'], camera: [], microphone: [] },
    }),
  )

  // Never compress the event stream: buffering would delay updates.
  app.use('*', async (c, next) => {
    if (c.req.path === '/api/stream') return next()
    return compress()(c, next)
  })

  app.use('/api/*', rateLimit(apiLimit))
  // State-changing endpoints: JSON from our own origin only (CSRF), tighter limit.
  app.use('/api/push/subscribe', sameOriginJson(d.allowedOrigins ?? []), rateLimit(pushLimit))
  app.use('/api/push/unsubscribe', sameOriginJson(d.allowedOrigins ?? []), rateLimit(pushLimit))

  /** What the server sees as the visitor's address (diagnostics for the CDN setup). */
  app.get('/api/ip', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ ip: clientIp(c), viaCloudflare: Boolean(c.req.header('cf-ray')) })
  })

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      demo: d.demo,
      streams,
      uptimeS: Math.round(process.uptime()),
      ...d.health(),
    }),
  )

  app.get('/api/state', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(snapshot())
  })

  const snapshot = (): StreamEvent => ({
    type: 'snapshot',
    tracks: d.tracks(),
    alerts: d.alerts(),
    infra: d.infra?.() ?? [],
    feed: d.feed?.() ?? [],
    serverTime: now(),
    demo: d.demo,
  })

  app.get('/api/stream', (c) => {
    if (streams >= (d.maxStreams ?? 5000)) return c.text('Too many connections', 503)
    const ip = clientIp(c)
    const mine = streamsByIp.get(ip) ?? 0
    if (mine >= (d.maxStreamsPerIp ?? 8))
      return c.text('Too many connections from your address', 429)
    streamsByIp.set(ip, mine + 1)
    c.header('Cache-Control', 'no-cache, no-transform')
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      streams++
      const queue: StreamEvent[] = []
      let wake: (() => void) | null = null
      const unsubscribe = d.bus.subscribe((ev) => {
        queue.push(ev)
        wake?.()
      })
      const heartbeat = setInterval(() => {
        void stream.write(': ping\n\n')
      }, d.heartbeatMs ?? 25_000)
      let closed = false
      stream.onAbort(() => {
        closed = true
        wake?.()
      })
      try {
        await stream.writeSSE({ data: JSON.stringify(snapshot()), retry: 3000 })
        while (!closed) {
          const ev = queue.shift()
          if (ev) {
            await stream.writeSSE({ data: JSON.stringify(ev) })
            continue
          }
          await new Promise<void>((r) => {
            wake = r
          })
          wake = null
        }
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
        streams--
        const left = (streamsByIp.get(ip) ?? 1) - 1
        if (left > 0) streamsByIp.set(ip, left)
        else streamsByIp.delete(ip)
      }
    })
  })

  let hotspotCache: { at: number; days: number; data: Hotspot[] } | null = null
  app.get('/api/hotspots', (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 30))
    if (!hotspotCache || hotspotCache.days !== days || now() - hotspotCache.at > 5 * 60_000) {
      hotspotCache = { at: now(), days, data: d.hotspots?.(days) ?? [] }
    }
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(hotspotCache.data)
  })

  let patternCache: { at: number; days: number; data: unknown } | null = null
  app.get('/api/patterns', (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 30))
    if (!patternCache || patternCache.days !== days || now() - patternCache.at > 5 * 60_000) {
      patternCache = { at: now(), days, data: d.patterns?.(days) ?? null }
    }
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(patternCache.data)
  })

  app.get('/api/push/key', (c) =>
    d.push ? c.json({ publicKey: d.push.publicKey }) : c.json({ error: 'push disabled' }, 404),
  )

  app.post('/api/push/subscribe', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    if (!d.push) return c.json({ error: 'push disabled' }, 404)
    const parsed = pushSubscriptionSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid subscription' }, 400)
    const sub = d.push.service.subscribe(parsed.data)
    return c.json(
      { ok: true, points: sub.points.map((p) => ({ name: p.name, featureIds: p.featureIds })) },
      201,
    )
  })

  app.post('/api/push/unsubscribe', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    if (!d.push) return c.json({ error: 'push disabled' }, 404)
    const parsed = z.object({ endpoint: z.url() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid endpoint' }, 400)
    d.push.service.unsubscribe(parsed.data.endpoint)
    return c.json({ ok: true })
  })

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  if (d.webDist && existsSync(d.webDist)) {
    const root = d.webDist
    // Hashed build assets never change; the shell, manifest and SW must always revalidate.
    app.use('*', async (c, next) => {
      await next()
      if (c.req.path.startsWith('/api/') || !c.res.ok) return
      c.res.headers.set(
        'Cache-Control',
        c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
    })
    app.use('*', serveStatic({ root }))
    // SPA fallback for navigations only: a missing asset must 404, never become an
    // index.html that the browser then caches as an immutable script.
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(c.req.path)) {
        return c.text('Not found', 404)
      }
      return serveStatic({ root, rewriteRequestPath: () => '/index.html' })(c, next)
    })
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    d.logger.error({ err, path: c.req.path }, 'request failed')
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
