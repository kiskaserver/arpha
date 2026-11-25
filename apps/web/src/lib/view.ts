import {
  type AlertsState,
  type Approach,
  computeApproach,
  type LatLon,
  type Track,
  ZAPORIZHZHIA,
} from '@arpha/shared'

export interface ThreatRow {
  track: Track
  approach: Approach | null
}

const STATUS_ORDER = { active: 0, destroyed: 1, lost: 2 } as const

/**
 * List order: what reaches me first, then what passes closest, then the rest
 * by distance; finished tracks last. Position-less threats (ballistic warning
 * for the city) go first — they're the most urgent and have no ETA.
 */
export function threatRows(
  tracks: Iterable<Track>,
  observer: LatLon | null,
  now: number,
  radiusKm: number,
): ThreatRow[] {
  const me = observer ?? ZAPORIZHZHIA
  const rows = [...tracks].map((track) => ({
    track,
    approach: computeApproach(track, me, now, radiusKm),
  }))
  return rows.sort((a, b) => {
    const s = STATUS_ORDER[a.track.status] - STATUS_ORDER[b.track.status]
    if (s) return s
    if (!a.approach !== !b.approach) return a.approach ? 1 : -1
    if (!a.approach || !b.approach) return b.track.updatedAt - a.track.updatedAt
    const ea = a.approach.etaMin ?? Number.POSITIVE_INFINITY
    const eb = b.approach.etaMin ?? Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return a.approach.distanceKm - b.approach.distanceKm
  })
}

export type AlertLevel = 'mine' | 'region' | 'none' | 'unknown'

/** How the alert affects the observer: their hromada/raion, elsewhere in the oblast, or nowhere. */
export function alertLevel(alerts: AlertsState, myFeatureIds: string[]): AlertLevel {
  if (alerts.stale && !alerts.alerts.length) return 'unknown'
  if (!alerts.alerts.length) return 'none'
  const mine = alerts.alerts.some((a) => a.featureIds.some((id) => myFeatureIds.includes(id)))
  return mine ? 'mine' : 'region'
}

/** Feature ids under alert, for map highlighting. */
export function alertedFeatureIds(alerts: AlertsState): Set<string> {
  return new Set(alerts.alerts.flatMap((a) => a.featureIds))
}
