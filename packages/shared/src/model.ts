import { destination, type LatLon } from './geo'
import { THREAT_PROFILES, type ThreatType } from './threats'

export interface TrackSource {
  channel: string
  channelTitle: string
  messageId: number
  text: string
  /** Epoch ms of the Telegram message. */
  at: number
}

export type TrackStatus = 'active' | 'destroyed' | 'lost'

export interface NamedPoint extends LatLon {
  name: string
}

/**
 * Wire representation of a tracked threat. Kinematics are expressed as a state
 * at `stateAt` plus speed/heading so every consumer can dead-reckon identically.
 */
export interface Track {
  id: string
  type: ThreatType
  count: number | null
  status: TrackStatus
  /** Estimated position at `stateAt`; null when only a target is known (e.g. "балістика на Запоріжжя"). */
  position: LatLon | null
  speedKmh: number | null
  headingDeg: number | null
  stateAt: number
  /** 1-sigma position uncertainty at `stateAt`. */
  uncertaintyKm: number
  /** Last place name reported by a source. */
  placeName: string | null
  target: NamedPoint | null
  confidence: number
  sources: TrackSource[]
  createdAt: number
  updatedAt: number
}

export type AlertLocationType = 'oblast' | 'raion' | 'hromada' | 'city'

export interface ActiveAlert {
  id: number
  locationTitle: string
  locationType: AlertLocationType
  locationUid: string
  alertType: string
  startedAt: number
  /** Ids of boundary polygons (boundaries.geojson) this alert covers. */
  featureIds: string[]
}

export interface AlertsState {
  alerts: ActiveAlert[]
  updatedAt: number
  /** True when the data source is unreachable or not configured. */
  stale: boolean
}

export type StreamEvent =
  | { type: 'snapshot'; tracks: Track[]; alerts: AlertsState; serverTime: number; demo: boolean }
  | { type: 'track'; track: Track }
  | { type: 'track_removed'; id: string }
  | { type: 'alerts'; alerts: AlertsState }

/** Where the track is at `now`, honouring the per-type extrapolation horizon. */
export function predictPosition(track: Track, now: number): LatLon | null {
  if (!track.position) return null
  const profile = THREAT_PROFILES[track.type]
  if (
    track.status !== 'active' ||
    !profile.moving ||
    track.speedKmh === null ||
    track.headingDeg === null ||
    track.speedKmh <= 0
  ) {
    return track.position
  }
  const dtMin = Math.min(Math.max(0, now - track.stateAt) / 60_000, profile.maxExtrapolationMin)
  if (dtMin === 0) return track.position
  return destination(track.position, track.headingDeg, (track.speedKmh / 60) * dtMin)
}

/** Whether a track is still being extrapolated (false once the horizon is exceeded). */
export function isExtrapolating(track: Track, now: number): boolean {
  const profile = THREAT_PROFILES[track.type]
  return (
    track.status === 'active' &&
    profile.moving &&
    track.speedKmh !== null &&
    track.speedKmh > 0 &&
    now - track.stateAt < profile.maxExtrapolationMin * 60_000
  )
}
