import {
  type ActiveAlert,
  ALERT_TYPE_LABELS_UK,
  computeApproach,
  formatMinutesUk,
  haversineKm,
  OFFICIAL_THREAT_LABELS_UK,
  THREAT_CLASS,
  type Track,
  threatLabelUk,
} from '@arpha/shared'
import type { SavedPoint, Settings, SoundCategory } from './settings'

export interface InAppAlert {
  key: string
  category: SoundCategory
  title: string
  /** What the voice says. */
  speech: string
}

export interface Sinks {
  sound(category: SoundCategory): void
  vibrate(pattern: number[]): void
  flash(category: SoundCategory): void
  speak(text: string): void
  show(alert: InAppAlert): void
}

const VIBRATION: Record<SoundCategory, number[]> = {
  alert: [300, 150, 300],
  ballistic: [600, 200, 600, 200, 600],
  threat: [200, 100, 200],
}

const REPEAT_MS = 10 * 60_000
const THREAT_ETA_MIN = 15
const BALLISTIC_RADIUS_KM = 25
const MISSILES = new Set([
  'ballistic_missiles',
  'cruise_missiles',
  'unspecified_missiles',
  'mig31k_departure',
])

/**
 * Decides when the open app should alert the user (sound, vibration, flash,
 * voice) — the in-app counterpart of server push, with the same rules:
 * an alert covering one of my points, a missile threat, or a threat whose
 * course reaches one of my points within 15 minutes.
 */
export class Notifier {
  readonly #seen = new Map<string, number>()
  readonly #sinks: Sinks

  constructor(sinks: Sinks) {
    this.#sinks = sinks
  }

  alerts(
    prev: ActiveAlert[],
    next: ActiveAlert[],
    myFeatureIds: string[],
    s: Settings,
    now: number,
  ): void {
    const prevById = new Map(prev.map((a) => [a.id, a]))
    const mine = (a: ActiveAlert) =>
      myFeatureIds.length
        ? a.featureIds.some((id) => myFeatureIds.includes(id))
        : a.locationType === 'oblast'
    for (const a of next) {
      if (!mine(a)) continue
      const before = prevById.get(a.id)
      if (!before) {
        const label = ALERT_TYPE_LABELS_UK[a.alertType] ?? 'Тривога'
        this.#fire(
          {
            key: `alert-${a.id}`,
            category: 'alert',
            title: `${label}: ${a.locationTitle}`,
            speech: `${label}. ${a.locationTitle}`,
          },
          s,
          now,
        )
      }
      const known = new Set(before?.threats.map((t) => t.type) ?? [])
      for (const t of a.threats) {
        if (known.has(t.type) || !MISSILES.has(t.type) || !s.classes.includes('missiles')) continue
        const label = OFFICIAL_THREAT_LABELS_UK[t.type] ?? 'Ракетна небезпека'
        this.#fire(
          {
            key: `threat-${a.id}-${t.type}`,
            category: 'ballistic',
            title: `${label}: ${a.locationTitle}`,
            speech: `Увага! ${label}. Негайно в укриття`,
          },
          s,
          now,
        )
      }
    }
  }

  track(track: Track, points: SavedPoint[], s: Settings, now: number): void {
    if (track.status !== 'active' || !points.length) return
    if (!s.classes.includes(THREAT_CLASS[track.type])) return
    if (track.type === 'ballistic') {
      const target = track.target ?? track.position
      if (!target) return
      const near = points.filter((p) => haversineKm(p, target) <= BALLISTIC_RADIUS_KM)
      if (!near.length) return
      const from = track.origin ? `, з боку ${track.origin.name}` : ''
      this.#fire(
        {
          key: `track-${track.id}`,
          category: 'ballistic',
          title: `Загроза балістики${from}`,
          speech: `Увага! Загроза балістики${from}. Негайно в укриття`,
        },
        s,
        now,
      )
      return
    }
    for (const p of points) {
      const a = computeApproach(track, p, now, s.radiusKm)
      if (!a || a.etaMin === null || a.etaMin > THREAT_ETA_MIN) continue
      const label = threatLabelUk(track.type, track.count)
      const eta = a.etaMin === 0 ? 'поруч' : `через ${formatMinutesUk(a.etaMin)}`
      this.#fire(
        {
          key: `track-${track.id}`,
          category: 'threat',
          title: `${label} → ${p.name}, ${eta}`,
          speech: `${label} у напрямку ${p.name}, ${eta}`,
        },
        s,
        now,
      )
      return
    }
  }

  #fire(alert: InAppAlert, s: Settings, now: number): void {
    const last = this.#seen.get(alert.key)
    if (last !== undefined && now - last < REPEAT_MS) return
    this.#seen.set(alert.key, now)
    this.#sinks.show(alert)
    if (s.sounds[alert.category] !== 'off') this.#sinks.sound(alert.category)
    if (s.vibrate) this.#sinks.vibrate(VIBRATION[alert.category])
    if (s.flash) this.#sinks.flash(alert.category)
    if (s.speak) this.#sinks.speak(alert.speech)
  }
}
