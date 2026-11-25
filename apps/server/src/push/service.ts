import {
  type ActiveAlert,
  ALERT_TYPE_LABELS_UK,
  alertCovers,
  computeApproach,
  flightMinutes,
  formatMinutesUk,
  haversineKm,
  type LatLon,
  OFFICIAL_THREAT_LABELS_UK,
  THREAT_CLASS,
  THREAT_CLASSES,
  type ThreatClass,
  type Track,
  threatLabelUk,
  weaponSpec,
} from '@arpha/shared'
import type { PushSubscriptionInput } from '@arpha/shared/schemas'
import type { Boundaries } from '../alerts/boundaries'
import type { AlertsDiff } from '../alerts/service'
import type { Store } from '../db'
import type { Logger } from '../logger'

export type PushKind = 'alert' | 'clear' | 'ballistic' | 'threat'

export interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
  /** Lets the service worker pick a vibration pattern. */
  kind: PushKind
}

export interface WatchedPoint extends LatLon {
  name: string
  featureIds: string[]
}

export interface StoredSubscription {
  subscription: PushSubscriptionInput['subscription']
  /** Rounded to ~1 km — enough for alerts and ETA, not enough to identify a home. */
  points: WatchedPoint[]
  radiusKm: number
  alerts: boolean
  threats: boolean
  classes: ThreatClass[]
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
/** A ballistic warning concerns points within this distance of its target. */
const BALLISTIC_RADIUS_KM = 25
const round = (v: number) => Math.round(v * 100) / 100

/** alerts.in.ua threat_type → our notification class. */
export const OFFICIAL_CLASS: Record<string, ThreatClass> = {
  ballistic_missiles: 'missiles',
  cruise_missiles: 'missiles',
  unspecified_missiles: 'missiles',
  mig31k_departure: 'missiles',
  drones: 'drones',
  guided_aerial_bombs: 'kab',
  tactic_aircraft_activity: 'aviation',
  strategic_aircraft_activity: 'aviation',
}

/** Migrate subscriptions stored before multi-point support. */
function upgrade(
  s: StoredSubscription & { point?: LatLon | null; featureIds?: string[] },
): StoredSubscription {
  const { point, featureIds, ...rest } = s
  return {
    ...rest,
    points:
      rest.points ?? (point ? [{ ...point, name: 'Моя точка', featureIds: featureIds ?? [] }] : []),
    classes: rest.classes ?? [...THREAT_CLASSES],
  }
}

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
      this.#subs.set(s.subscription.endpoint, upgrade(s))
    }
  }

  get size(): number {
    return this.#subs.size
  }

  subscribe(input: PushSubscriptionInput): StoredSubscription {
    const sub: StoredSubscription = {
      subscription: input.subscription,
      points: input.points.map((p) => {
        const at = { lat: round(p.lat), lon: round(p.lon) }
        return {
          ...at,
          name: p.name,
          featureIds: this.#o.boundaries.containing(at).map((f) => f.id),
        }
      }),
      radiusKm: input.radiusKm,
      alerts: input.alerts,
      threats: input.threats,
      classes: input.classes,
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
      const payload = this.#alertPayload(sub, diff)
      if (payload) jobs.push(this.#send(sub, payload))
    }
    await Promise.all(jobs)
  }

  /**
   * Which of the subscriber's points an alert covers: names of matching points,
   * [] for an oblast-wide alert when no points are set, null when irrelevant.
   */
  #affected(sub: StoredSubscription, a: ActiveAlert): string[] | null {
    if (!sub.points.length) return a.locationType === 'oblast' ? [] : null
    const hit = sub.points.filter((p) => alertCovers(a, p.featureIds))
    return hit.length ? hit.map((p) => p.name) : null
  }

  #alertPayload(sub: StoredSubscription, diff: AlertsDiff): PushPayload | null {
    const started = diff.started.filter((a) => this.#affected(sub, a))
    if (started.length) {
      const a = started[0]!
      const who = this.#affected(sub, a)!
      const threats = a.threats.map((t) => OFFICIAL_THREAT_LABELS_UK[t.type] ?? t.type).join(', ')
      return {
        title: `🚨 ${ALERT_TYPE_LABELS_UK[a.alertType] ?? 'Тривога'}${who.length ? ` · ${who.join(', ')}` : ''}`,
        body: [started.map((x) => x.locationTitle).join(', '), threats].filter(Boolean).join(' — '),
        tag: 'alert',
        url: '/',
        kind: 'alert',
      }
    }
    const added = diff.threatsAdded.find(
      ({ alert, threat }) =>
        this.#affected(sub, alert) && sub.classes.includes(OFFICIAL_CLASS[threat.type] ?? 'drones'),
    )
    if (added) {
      const missiles = OFFICIAL_CLASS[added.threat.type] === 'missiles'
      return {
        title: `${missiles ? '🚀' : '⚠️'} ${OFFICIAL_THREAT_LABELS_UK[added.threat.type] ?? 'Загроза'}`,
        body: [added.alert.locationTitle, added.threat.message].filter(Boolean).join(' — '),
        tag: `alert-${added.threat.type}`,
        url: '/',
        kind: missiles ? 'ballistic' : 'alert',
      }
    }
    const ended = diff.ended.filter((a) => this.#affected(sub, a))
    if (ended.length) {
      return {
        title: '✅ Відбій тривоги',
        body: ended.map((a) => a.locationTitle).join(', '),
        tag: 'alert',
        url: '/',
        kind: 'clear',
      }
    }
    return null
  }

  async onTrack(track: Track): Promise<void> {
    if (track.status !== 'active' || track.type === 'explosion') return
    const now = this.#now()
    const threshold = this.#o.etaThresholdMin ?? 30
    const cls = THREAT_CLASS[track.type]
    const jobs: Promise<void>[] = []
    for (const sub of this.#subs.values()) {
      if (!sub.threats || !sub.points.length || !sub.classes.includes(cls)) continue
      const key = `${sub.subscription.endpoint}|${track.id}`
      const last = this.#notified.get(key)
      if (last !== undefined && now - last < THREAT_RENOTIFY_MS) continue
      const payload = this.#threatPayload(track, sub, now, threshold)
      if (!payload) continue
      this.#notified.set(key, now)
      jobs.push(this.#send(sub, payload))
    }
    await Promise.all(jobs)
    this.#gc(now)
  }

  #threatPayload(
    track: Track,
    sub: StoredSubscription,
    now: number,
    threshold: number,
  ): PushPayload | null {
    // Ballistic warnings have a target and a direction, not a track.
    if (track.type === 'ballistic') {
      const target = track.target ?? track.position
      if (!target) return null
      const near = sub.points.filter((p) => haversineKm(p, target) <= BALLISTIC_RADIUS_KM)
      if (!near.length) return null
      const spec = weaponSpec(track.model, 'ballistic')
      const eta =
        spec && track.origin && track.target
          ? ` Підліт ~${formatMinutesUk(flightMinutes(spec, haversineKm(track.origin, track.target)))}.`
          : ''
      const from = track.origin ? ` Напрямок: з боку ${track.origin.name}.${eta}` : ''
      return {
        title: `🚀 Загроза балістики · ${near.map((p) => p.name).join(', ')}`,
        body: `${track.target?.name ?? track.placeName ?? 'Ваш район'}.${from} Негайно в укриття!`,
        tag: `track-${track.id}`,
        url: `/?track=${track.id}`,
        kind: 'ballistic',
      }
    }
    let best: { name: string; eta: number; km: number } | null = null
    for (const p of sub.points) {
      const a = computeApproach(track, p, now, sub.radiusKm)
      if (!a || a.etaMin === null || a.etaMin > threshold) continue
      if (!best || a.etaMin < best.eta) best = { name: p.name, eta: a.etaMin, km: a.distanceKm }
    }
    if (!best) return null
    const eta = best.eta === 0 ? 'вже поруч' : `~${formatMinutesUk(best.eta)}`
    return {
      title: `⚠️ ${threatLabelUk(track.type, track.count)} → ${best.name}`,
      body: `${eta}, ${Math.round(best.km)} км${track.placeName ? ` · біля ${track.placeName}` : ''}`,
      tag: `track-${track.id}`,
      url: `/?track=${track.id}`,
      kind: 'threat',
    }
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
    for (const [k, at] of this.#notified) {
      if (now - at > THREAT_RENOTIFY_MS * 3) this.#notified.delete(k)
    }
  }
}
