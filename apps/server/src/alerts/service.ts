import type { ActiveAlert, AlertLocationType, AlertsState } from '@arpha/shared'
import { z } from 'zod'
import type { Logger } from '../logger'

export const ALERTS_API = 'https://api.alerts.in.ua/v1/alerts/active.json'
export const OBLAST_TITLE = 'Запорізька область'
export const OBLAST_UID = '12'

const alertSchema = z.object({
  id: z.number(),
  location_title: z.string(),
  location_type: z.string(),
  location_uid: z.union([z.string(), z.number()]).transform(String),
  location_oblast: z.string().nullish(),
  location_oblast_uid: z
    .union([z.string(), z.number()])
    .nullish()
    .transform((v) => (v == null ? null : String(v))),
  alert_type: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullish(),
})

const responseSchema = z.object({ alerts: z.array(z.unknown()) })

const LOCATION_TYPES: AlertLocationType[] = ['oblast', 'raion', 'hromada', 'city']

/** Keep only alerts in Zaporizhzhia oblast; skip malformed items instead of failing the batch. */
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
      startedAt: Date.parse(a.started_at),
      featureIds: match({ locationTitle: a.location_title, locationType }),
    })
  }
  return out.sort((x, y) => x.id - y.id)
}

export interface AlertsDiff {
  started: ActiveAlert[]
  ended: ActiveAlert[]
}

export function diffAlerts(prev: ActiveAlert[], next: ActiveAlert[]): AlertsDiff {
  const prevIds = new Set(prev.map((a) => a.id))
  const nextIds = new Set(next.map((a) => a.id))
  return {
    started: next.filter((a) => !prevIds.has(a.id)),
    ended: prev.filter((a) => !nextIds.has(a.id)),
  }
}

export interface AlertsServiceOptions {
  token?: string
  pollMs: number
  logger: Logger
  fetch?: typeof fetch
  now?: () => number
  /** Maps an alert location to boundary polygon ids. */
  match?: (a: Pick<ActiveAlert, 'locationTitle' | 'locationType'>) => string[]
  onChange?(state: AlertsState, diff: AlertsDiff): void
}

/**
 * Polls alerts.in.ua. Respects Last-Modified (the API supports conditional
 * requests, which don't count much toward the rate limit) and backs off on errors.
 */
export class AlertsService {
  readonly #o: AlertsServiceOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  #state: AlertsState
  #lastModified: string | null = null
  #timer: NodeJS.Timeout | null = null
  #running = false
  #failures = 0

  constructor(opts: AlertsServiceOptions) {
    this.#o = opts
    this.#fetch = opts.fetch ?? fetch
    this.#now = opts.now ?? Date.now
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

  async poll(): Promise<void> {
    if (!this.#o.token) return
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.#o.token}` }
      if (this.#lastModified) headers['If-Modified-Since'] = this.#lastModified
      const res = await this.#fetch(ALERTS_API, { headers, signal: AbortSignal.timeout(10_000) })
      if (res.status === 304) {
        this.#failures = 0
        if (this.#state.stale)
          this.#publish({ ...this.#state, stale: false }, { started: [], ended: [] })
        return
      }
      if (!res.ok) throw new Error(`alerts.in.ua HTTP ${res.status}`)
      this.#lastModified = res.headers.get('last-modified')
      this.#apply(parseAlerts(await res.json(), this.#o.match))
      this.#failures = 0
    } catch (err) {
      this.#failures++
      this.#o.logger.warn({ err, failures: this.#failures }, 'alerts poll failed')
      if (this.#failures >= 3 && !this.#state.stale) {
        this.#publish({ ...this.#state, stale: true }, { started: [], ended: [] })
      }
    }
  }

  start(): void {
    if (!this.#o.token || this.#running) return
    this.#running = true
    const loop = async () => {
      await this.poll()
      if (!this.#running) return
      const backoff = Math.min(2 ** this.#failures, 8)
      this.#timer = setTimeout(loop, this.#o.pollMs * backoff)
    }
    void loop()
  }

  stop(): void {
    this.#running = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #apply(alerts: ActiveAlert[]): void {
    const diff = diffAlerts(this.#state.alerts, alerts)
    const changed = diff.started.length > 0 || diff.ended.length > 0 || this.#state.stale
    if (!changed) {
      this.#state = { ...this.#state, updatedAt: this.#now() }
      return
    }
    this.#publish({ alerts, updatedAt: this.#now(), stale: false }, diff)
  }

  #publish(state: AlertsState, diff: AlertsDiff): void {
    this.#state = state
    this.#o.onChange?.(state, diff)
  }
}
