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

export interface PredictedTarget extends NamedPoint {
  /** Probability among the listed candidates, 0..1. */
  p: number
  /** Minutes until the object reaches it on the current course; null if not on the way. */
  etaMin: number | null
}

/** Server-side forecast: where the threat is likely heading and what it may hit. */
export interface Prediction {
  computedAt: number
  horizonMin: number
  targets: PredictedTarget[]
  /** Expected impact area (KAB/ballistic target, or the top candidate for drones). */
  impact: (LatLon & { radiusKm: number }) | null
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
  /** Where it came from, when a source said so (e.g. ballistic "з Криму"). */
  origin: NamedPoint | null
  prediction: Prediction | null
  confidence: number
  sources: TrackSource[]
  createdAt: number
  updatedAt: number
}

export type AlertLocationType = 'oblast' | 'raion' | 'hromada' | 'city'

export interface OfficialThreat {
  /** alerts.in.ua threat_type: ballistic_missiles, drones, guided_aerial_bombs… */
  type: string
  level: string | null
  startedAt: number
  message: string | null
}

export interface ActiveAlert {
  id: number
  locationTitle: string
  locationType: AlertLocationType
  locationUid: string
  /** air_raid, artillery_shelling, urban_fights, chemical, nuclear. */
  alertType: string
  /** red / yellow, when published. */
  level: string | null
  threats: OfficialThreat[]
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

/** Bridges, the dam and other crossings reported closed/open by the channels. */
export interface InfraStatus {
  id: string
  name: string
  lat: number
  lon: number
  status: 'closed' | 'open'
  updatedAt: number
  source: string
}

/** A recent relevant channel post, for the in-app feed. */
export interface FeedItem {
  key: string
  channel: string
  channelTitle: string
  messageId: number
  text: string
  at: number
  types: ThreatType[]
  trackIds: string[]
}

export interface Hotspot extends NamedPoint {
  count: number
}

export type StreamEvent =
  | {
      type: 'snapshot'
      tracks: Track[]
      alerts: AlertsState
      infra: InfraStatus[]
      feed: FeedItem[]
      serverTime: number
      demo: boolean
    }
  | { type: 'infra'; infra: InfraStatus[] }
  | { type: 'feed'; item: FeedItem }
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
