import {
  computeApproach,
  formatMinutesUk,
  type LatLon,
  type Track,
  threatLabelUk,
} from '@arpha/shared'
import type { PushSubscriptionInput } from '@arpha/shared/schemas'
import type { Boundaries } from '../alerts/boundaries'
import type { AlertsDiff } from '../alerts/service'
import type { Store } from '../db'
import type { Logger } from '../logger'

export interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
}

export interface StoredSubscription {
  subscription: PushSubscriptionInput['subscription']
  /** Rounded to ~1 km — enough for alerts and ETA, not enough to identify a home. */
  point: LatLon | null
  radiusKm: number
  alerts: boolean
  threats: boolean
  featureIds: string[]
}

export class PushGoneError extends Error {}

export type PushSender = (
  sub: StoredSubscription['subscription'],
  payload: PushPayload,
) => Promise<void>

export interface PushServiceOptions {
  store: Store
  boundaries: Boundaries
  send: PushSender
  logger: Logger
  now?: () => number
  /** Notify when a threat is expected within this many minutes. */
  etaThresholdMin?: number
}

const THREAT_RENOTIFY_MS = 10 * 60_000
const round = (v: number) => Math.round(v * 100) / 100

export class PushService {
  readonly #o: PushServiceOptions
  readonly #now: () => number
  readonly #subs = new Map<string, StoredSubscription>()
  /** `${endpoint}|${trackId}` → last notified at. */
  readonly #notified = new Map<string, number>()

  constructor(opts: PushServiceOptions) {
    this.#o = opts
    this.#now = opts.now ?? Date.now
    for (const s of opts.store.listSubscriptions<StoredSubscription>()) {
      this.#subs.set(s.subscription.endpoint, s)
    }
  }

  get size(): number {
    return this.#subs.size
  }

  subscribe(input: PushSubscriptionInput): StoredSubscription {
    const point = input.point ? { lat: round(input.point.lat), lon: round(input.point.lon) } : null
    const sub: StoredSubscription = {
      subscription: input.subscription,
      point,
      radiusKm: input.radiusKm,
      alerts: input.alerts,
      threats: input.threats,
      featureIds: point ? this.#o.boundaries.containing(point).map((f) => f.id) : [],
    }
    this.#subs.set(sub.subscription.endpoint, sub)
    this.#o.store.saveSubscription(sub.subscription.endpoint, sub)
    return sub
  }

  unsubscribe(endpoint: string): void {
    this.#subs.delete(endpoint)
    this.#o.store.deleteSubscription(endpoint)
  }

  async onAlerts(diff: AlertsDiff): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const sub of this.#subs.values()) {
      if (!sub.alerts) continue
      const relevant = (featureIds: string[], type: string) =>
        sub.featureIds.length
          ? featureIds.some((id) => sub.featureIds.includes(id))
          : type === 'oblast'
      const started = diff.started.filter((a) => relevant(a.featureIds, a.locationType))
      const ended = diff.ended.filter((a) => relevant(a.featureIds, a.locationType))
      if (started.length) {
        jobs.push(
          this.#send(sub, {
            title: '🚨 Повітряна тривога',
            body: started.map((a) => a.locationTitle).join(', '),
            tag: 'alert',
            url: '/',
          }),
        )
      } else if (ended.length) {
        jobs.push(
          this.#send(sub, {
            title: '✅ Відбій тривоги',
            body: ended.map((a) => a.locationTitle).join(', '),
            tag: 'alert',
            url: '/',
          }),
        )
      }
    }
    await Promise.all(jobs)
  }

  async onTrack(track: Track): Promise<void> {
    if (track.status !== 'active') return
    const now = this.#now()
    const threshold = this.#o.etaThresholdMin ?? 30
    const jobs: Promise<void>[] = []
    for (const sub of this.#subs.values()) {
      if (!sub.threats || !sub.point) continue
      const approach = computeApproach(track, sub.point, now, sub.radiusKm)
      if (!approach || approach.etaMin === null || approach.etaMin > threshold) continue
      const key = `${sub.subscription.endpoint}|${track.id}`
      const last = this.#notified.get(key)
      if (last !== undefined && now - last < THREAT_RENOTIFY_MS) continue
      this.#notified.set(key, now)
      const eta = approach.etaMin === 0 ? 'вже поруч' : `~${formatMinutesUk(approach.etaMin)}`
      jobs.push(
        this.#send(sub, {
          title: `⚠️ ${threatLabelUk(track.type, track.count)} у ваш бік`,
          body: `${eta}, ${Math.round(approach.distanceKm)} км${track.placeName ? ` · біля ${track.placeName}` : ''}`,
          tag: `track-${track.id}`,
          url: `/?track=${track.id}`,
        }),
      )
    }
    await Promise.all(jobs)
    this.#gc(now)
  }

  async #send(sub: StoredSubscription, payload: PushPayload): Promise<void> {
    try {
      await this.#o.send(sub.subscription, payload)
    } catch (err) {
      if (err instanceof PushGoneError) {
        this.unsubscribe(sub.subscription.endpoint)
        return
      }
      this.#o.logger.warn({ err }, 'push send failed')
    }
  }

  #gc(now: number): void {
    for (const [k, at] of this.#notified)
      if (now - at > THREAT_RENOTIFY_MS * 3) this.#notified.delete(k)
  }
}
