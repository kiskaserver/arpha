import type { ActiveAlert, AlertLocationType, AlertsState, OfficialThreat } from '@arpha/shared'
import { z } from 'zod'
import type { Logger } from '../logger'

/** https://devs.alerts.in.ua — one request returns every active alert in Ukraine. */
export const ALERTS_API = 'https://api.alerts.in.ua/v1/alerts/active.json'
export const OBLAST_TITLE = 'Запорізька область'
export const OBLAST_UID = '12'

const idLike = z.union([z.string(), z.number()])

const threatSchema = z.object({
  threat_type: z.string(),
  level: z.string().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  source_message: z.string().nullish(),
})

const alertSchema = z.object({
  id: z.number(),
  location_title: z.string(),
  location_type: z.string(),
  location_uid: idLike.transform(String),
  location_oblast: z.string().nullish(),
  location_oblast_uid: idLike.nullish().transform((v) => (v == null ? null : String(v))),
  alert_type: z.string(),
  alert_level: z.string().nullish(),
  started_at: z.string(),
  finished_at: z.string().nullish(),
  threats: z.array(z.unknown()).nullish(),
})

const responseSchema = z.object({ alerts: z.array(z.unknown()) })

const LOCATION_TYPES: AlertLocationType[] = ['oblast', 'raion', 'hromada', 'city']

function parseThreats(raw: unknown[] | null | undefined): OfficialThreat[] {
  const out: OfficialThreat[] = []
  for (const t of raw ?? []) {
    const parsed = threatSchema.safeParse(t)
    if (!parsed.success || parsed.data.finished_at) continue
    const d = parsed.data
    out.push({
      type: d.threat_type,
      level: d.level ?? null,
      startedAt: d.started_at ? Date.parse(d.started_at) : 0,
      message: d.source_message ?? null,
    })
  }
  return out
}

/** Keep only alerts in Zaporizhzhia oblast (every alert type); skip malformed items. */
export function parseAlerts(
  body: unknown,
  match: (a: Pick<ActiveAlert, 'locationTitle' | 'locationType'>) => string[] = () => [],
): ActiveAlert[] {
  const { alerts } = responseSchema.parse(body)
  const out: ActiveAlert[] = []
  for (const raw of alerts) {
    const parsed = alertSchema.safeParse(raw)
    if (!parsed.success) continue
    const a = parsed.data
    if (a.finished_at) continue
    const inOblast = a.location_oblast === OBLAST_TITLE || a.location_oblast_uid === OBLAST_UID
    if (!inOblast) continue
    if (!LOCATION_TYPES.includes(a.location_type as AlertLocationType)) continue
    const locationType = a.location_type as AlertLocationType
    out.push({
      id: a.id,
      locationTitle: a.location_title,
      locationType,
      locationUid: a.location_uid,
      alertType: a.alert_type,
      level: a.alert_level ?? null,
      threats: parseThreats(a.threats),
      startedAt: Date.parse(a.started_at),
      featureIds: match({ locationTitle: a.location_title, locationType }),
    })
  }
  return out.sort((x, y) => x.id - y.id)
}

export interface AlertsDiff {
  started: ActiveAlert[]
  ended: ActiveAlert[]
  /** New official threat types on alerts that were already active (e.g. ballistic added). */
  threatsAdded: { alert: ActiveAlert; threat: OfficialThreat }[]
}

export const NO_DIFF: AlertsDiff = { started: [], ended: [], threatsAdded: [] }

export function diffAlerts(prev: ActiveAlert[], next: ActiveAlert[]): AlertsDiff {
  const prevById = new Map(prev.map((a) => [a.id, a]))
  const nextIds = new Set(next.map((a) => a.id))
  const threatsAdded: AlertsDiff['threatsAdded'] = []
  for (const a of next) {
    const before = prevById.get(a.id)
    if (!before) continue
    const known = new Set(before.threats.map((t) => t.type))
    for (const t of a.threats) if (!known.has(t.type)) threatsAdded.push({ alert: a, threat: t })
  }
  return {
    started: next.filter((a) => !prevById.has(a.id)),
    ended: prev.filter((a) => !nextIds.has(a.id)),
    threatsAdded,
  }
}

const signature = (alerts: ActiveAlert[]) =>
  alerts
    .map((a) => `${a.id}:${a.level}:${a.threats.map((t) => `${t.type}/${t.level}`).join(',')}`)
    .join('|')

export interface AlertsServiceOptions {
  token?: string | undefined
  pollMs: number
  logger: Logger
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
  /** Maps an alert location to boundary polygon ids. */
  match?: (a: Pick<ActiveAlert, 'locationTitle' | 'locationType'>) => string[]
  onChange?(state: AlertsState, diff: AlertsDiff): void
}

/** After 401/403 the token is wrong or blocked; hammering would only make it worse. */
const AUTH_PAUSE_MS = 15 * 60_000
/** On 429 without Retry-After. */
const RATE_LIMIT_PAUSE_MS = 2 * 60_000

/**
 * Polls alerts.in.ua politely: the token may be shared with another project and
 * the API blocks abusers (soft limit 8–10 req/min per IP). We use one request
 * per ~30 s with ±15 % jitter, conditional requests (If-Modified-Since → 304),
 * honour Retry-After on 429, pause on auth errors and back off exponentially.
 */
export class AlertsService {
  readonly #o: AlertsServiceOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #random: () => number
  #state: AlertsState
  #lastModified: string | null = null
  #timer: NodeJS.Timeout | null = null
  #running = false
  #failures = 0
  /** Earliest time the next request may be sent. */
  #pauseUntil = 0

  constructor(opts: AlertsServiceOptions) {
    this.#o = opts
    this.#fetch = opts.fetch ?? fetch
    this.#now = opts.now ?? Date.now
    this.#random = opts.random ?? Math.random
    this.#state = { alerts: [], updatedAt: 0, stale: true }
  }

  get state(): AlertsState {
    return this.#state
  }

  get enabled(): boolean {
    return Boolean(this.#o.token)
  }

  /** Replace the state directly (demo mode / tests). */
  set(alerts: ActiveAlert[]): void {
    this.#apply(alerts)
  }

  /** Delay before the next poll, ms. */
  nextDelay(): number {
    const jitter = 1 + (this.#random() * 2 - 1) * 0.15
    const backoff = Math.min(2 ** this.#failures, 8)
    const base = this.#o.pollMs * backoff * jitter
    return Math.max(base, this.#pauseUntil - this.#now())
  }

  async poll(): Promise<void> {
    const token = this.#o.token
    if (!token || this.#now() < this.#pauseUntil) return
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (this.#lastModified) headers['If-Modified-Since'] = this.#lastModified
      const res = await this.#fetch(ALERTS_API, { headers, signal: AbortSignal.timeout(10_000) })
      if (res.status === 304) {
        this.#failures = 0
        if (this.#state.stale) this.#publish({ ...this.#state, stale: false }, NO_DIFF)
        return
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'))
        this.#pauseUntil = this.#now() + (retry > 0 ? retry * 1000 : RATE_LIMIT_PAUSE_MS)
        throw new Error('alerts.in.ua rate limit (429)')
      }
      if (res.status === 401 || res.status === 403) {
        this.#pauseUntil = this.#now() + AUTH_PAUSE_MS
        throw new Error(`alerts.in.ua rejected the token (${res.status})`)
      }
      if (!res.ok) throw new Error(`alerts.in.ua HTTP ${res.status}`)
      this.#lastModified = res.headers.get('last-modified')
      this.#apply(parseAlerts(await res.json(), this.#o.match))
      this.#failures = 0
    } catch (err) {
      this.#failures++
      this.#o.logger.warn({ err, failures: this.#failures }, 'alerts poll failed')
      if (this.#failures >= 3 && !this.#state.stale) {
        this.#publish({ ...this.#state, stale: true }, NO_DIFF)
      }
    }
  }

  start(): void {
    if (!this.#o.token || this.#running) return
    this.#running = true
    const loop = async () => {
      await this.poll()
      if (!this.#running) return
      this.#timer = setTimeout(loop, this.nextDelay())
    }
    void loop()
  }

  stop(): void {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #apply(alerts: ActiveAlert[]): void {
    const changed = this.#state.stale || signature(alerts) !== signature(this.#state.alerts)
    if (!changed) {
      this.#state = { ...this.#state, updatedAt: this.#now() }
      return
    }
    const diff = diffAlerts(this.#state.alerts, alerts)
    this.#publish({ alerts, updatedAt: this.#now(), stale: false }, diff)
  }

  #publish(state: AlertsState, diff: AlertsDiff): void {
    this.#state = state
    this.#o.onChange?.(state, diff)
  }
}
