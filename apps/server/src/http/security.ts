import type { Context, MiddlewareHandler } from 'hono'

/**
 * The real visitor IP. Traffic arrives Browser → Cloudflare → Railway edge →
 * app, so the socket peer is a proxy. Cloudflare sets CF-Connecting-IP to the
 * visitor; otherwise the first X-Forwarded-For hop is the client.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip')?.trim()
  if (cf) return cf
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff
  return c.req.header('x-real-ip')?.trim() || 'unknown'
}

/** Fixed-window counter per key; tiny and dependency-free. */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>()
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit
    this.#windowMs = windowMs
    this.#now = now
  }

  /** Records a hit; returns seconds to wait, or 0 when allowed. */
  hit(key: string): number {
    const now = this.#now()
    const entry = this.#hits.get(key)
    if (!entry || now >= entry.resetAt) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs })
      if (this.#hits.size > 50_000) this.#sweep(now)
      return 0
    }
    entry.count++
    return entry.count > this.#limit ? Math.ceil((entry.resetAt - now) / 1000) : 0
  }

  #sweep(now: number): void {
    for (const [k, v] of this.#hits) if (now >= v.resetAt) this.#hits.delete(k)
  }
}

export function rateLimit(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const wait = limiter.hit(clientIp(c))
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json({ error: 'too many requests' }, 429)
    }
    return next()
  }
}

/**
 * CSRF protection for state-changing requests. A cross-site page can make the
 * browser send a "simple" POST (text/plain, form) without preflight, so we
 * require JSON and an Origin that is ours (the request's own host or one of
 * the configured public origins). Browsers always send Origin on POST.
 */
export function sameOriginJson(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase()))
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS')
      return next()
    const type = c.req.header('content-type') ?? ''
    if (!/^application\/json\b/i.test(type)) {
      return c.json({ error: 'content-type must be application/json' }, 415)
    }
    const origin = c.req.header('origin')?.toLowerCase()
    const host = c.req.header('host')?.toLowerCase()
    const sameHost = Boolean(origin && host && hostOf(origin) === host)
    if (!origin || (!sameHost && !allowed.has(origin))) {
      return c.json({ error: 'cross-origin request rejected' }, 403)
    }
    const site = c.req.header('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none' && !allowed.has(origin)) {
      return c.json({ error: 'cross-site request rejected' }, 403)
    }
    return next()
  }
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host
  } catch {
    return null // "null" origin from sandboxed frames etc.
  }
}
