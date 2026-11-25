import { randomBytes } from 'node:crypto'
import {
  bearingDeg,
  compassToBearing,
  haversineKm,
  type LatLon,
  localFrame,
  type NamedPoint,
  THREAT_PROFILES,
  type ThreatType,
  type Track,
  type TrackSource,
  typesCompatible,
  weaponSpec,
  ZAPORIZHZHIA,
} from '@arpha/shared'
import type { ExtractedEvent, RawMessage, TrackBrief } from '../extract/types'
import type { Place } from '../geo/gazetteer'
import {
  type KalmanState,
  kfClampSpeed,
  kfInit,
  kfPositionSigma,
  kfPredict,
  kfUpdatePosition,
  kfUpdateVelocity,
  kfVelocity,
  velocityFrom,
} from './kalman'

export interface ResolvedEvent extends ExtractedEvent {
  locationPlace: Place | null
  fromPlace: Place | null
  towardPlace: Place | null
}

export interface ApplyContext {
  message: RawMessage
  /** Tracks linked to the message this one replies to. */
  parentTrackIds: string[]
  /** Time the report refers to (epoch ms). */
  observedAt: number
}

export interface PathPoint {
  lat: number
  lon: number
  at: number
  place: string
}

/** Internal per-track state; persisted so restarts don't lose the picture. */
export interface TrackState {
  track: Track
  kf: KalmanState | null
  lastObsAt: number
  channels: string[]
  removeAt: number | null
  /** Reported places in order — saved as a route when the track ends. */
  path: PathPoint[]
}

export interface TrackerHooks {
  /** Forecast attached to every published state (see predict/predictor.ts). */
  predict?(track: Track, now: number): Track['prediction']
  onChange?(track: Track, state: TrackState): void
  onRemove?(id: string, state: TrackState): void
}

/** Below this, the filter's velocity is noise, not a course. */
const MIN_REPORTED_SPEED_KMH = 25
/** Base association gate, km — reports name the nearest village, not the object. */
const BASE_GATE_KM = 20
const DESTROYED_LINGER_MS = 90_000
const LOST_LINGER_MS = 60_000
const MAX_SOURCES = 6
/** Weapons whose "lost"/"впали" means they hit the ground. */
const IMPACTING = new Set<ThreatType>(['kab', 'ballistic', 'cruise_missile', 'mlrs', 'artillery'])
const frame = localFrame(ZAPORIZHZHIA)

interface Observation {
  point: LatLon
  sigma: number
  name: string
}

const newId = () => `t${randomBytes(4).toString('hex')}`

function observationSigma(place: Place, precision: ResolvedEvent['precision']): number {
  const floor = precision === 'area' ? 15 : precision === 'near' ? 5 : 1.5
  return Math.max(place.precisionKm, floor)
}

/**
 * Multi-source track fusion: associates extracted events with existing tracks
 * (explicit id → reply link → spatial gating), runs a constant-velocity Kalman
 * filter per moving object, and manages lifecycle (destroyed/lost/expired).
 */
export class Tracker {
  readonly #states = new Map<string, TrackState>()
  readonly #hooks: TrackerHooks

  constructor(hooks: TrackerHooks = {}, initial: TrackState[] = []) {
    this.#hooks = hooks
    for (const s of initial) {
      s.path ??= []
      s.track.model ??= null
      this.#states.set(s.track.id, s)
    }
  }

  get(id: string): Track | undefined {
    return this.#states.get(id)?.track
  }

  tracks(): Track[] {
    return [...this.#states.values()].map((s) => s.track)
  }

  active(): Track[] {
    return this.tracks().filter((t) => t.status === 'active')
  }

  briefs(now: number): TrackBrief[] {
    return this.active().map((t) => ({
      id: t.id,
      type: t.type,
      count: t.count,
      placeName: t.placeName,
      headingDeg: t.headingDeg,
      targetName: t.target?.name ?? null,
      minutesAgo: Math.round((now - t.updatedAt) / 60_000),
    }))
  }

  /** Applies one message's events. Returns the track id each event landed on (null if dropped). */
  apply(events: ResolvedEvent[], ctx: ApplyContext): (string | null)[] {
    const used = new Set<string>()
    return events.map((ev) => {
      const id = this.#applyOne(ev, ctx, used)
      if (id) used.add(id)
      return id
    })
  }

  /** "Відбій" for the region: everything still in the air is considered gone. */
  allClear(now: number): void {
    for (const s of this.#states.values()) {
      if (s.track.status !== 'active') continue
      this.#setStatus(s, 'lost', now)
    }
  }

  /** Expire stale tracks and purge lingering ones. Call periodically. */
  tick(now: number): void {
    for (const s of [...this.#states.values()]) {
      if (s.removeAt !== null && now >= s.removeAt) {
        this.#states.delete(s.track.id)
        this.#hooks.onRemove?.(s.track.id, s)
        continue
      }
      const ttl = THREAT_PROFILES[s.track.type].ttlMin * 60_000
      if (s.track.status === 'active' && now - s.lastObsAt > ttl) this.#setStatus(s, 'lost', now)
    }
  }

  #applyOne(raw: ResolvedEvent, ctx: ApplyContext, used: Set<string>): string | null {
    // A ballistic warning names what is threatened, never where the missile is.
    const ev: ResolvedEvent =
      raw.type === 'ballistic' && raw.locationPlace && !raw.towardPlace
        ? { ...raw, towardPlace: raw.locationPlace, locationPlace: null }
        : raw
    const obs = this.#observation(ev)
    const state = this.#associate(ev, ctx, obs?.point ?? null, used)

    if (ev.action === 'destroyed' || ev.action === 'lost') {
      // "Впали каби" / a missile that "lost" over a place = it hit there: mark the impact.
      const impact = ev.action === 'lost' && IMPACTING.has(ev.type)
      const where = obs?.point ?? state?.track.position ?? null
      if (impact && where && obs) {
        this.#create({ ...ev, type: 'explosion', action: 'new', track_id: null }, ctx, obs)
      } else if (impact && where && state?.track.placeName) {
        const name = state.track.placeName
        this.#create({ ...ev, type: 'explosion', action: 'new', track_id: null }, ctx, {
          point: where,
          sigma: state.track.uncertaintyKm || 2,
          name,
        })
      }
      if (!state) return null // nothing to kill; never spawn a dead track
      if (
        ev.action === 'destroyed' &&
        ev.count &&
        state.track.count &&
        ev.count < state.track.count
      ) {
        state.track = { ...state.track, count: state.track.count - ev.count }
        this.#touch(state, ev, ctx)
        return state.track.id
      }
      this.#setStatus(state, ev.action, Math.max(ctx.observedAt, state.track.stateAt), ev, ctx)
      return state.track.id
    }

    if (!state) {
      if (!obs && !ev.towardPlace) return null // nothing to show
      return this.#create(ev, ctx, obs).track.id
    }
    this.#update(state, ev, ctx, obs)
    return state.track.id
  }

  #observation(ev: ResolvedEvent): Observation | null {
    // A ballistic "з Криму" is a direction of origin, never a position.
    const place = ev.locationPlace ?? (ev.type === 'ballistic' ? null : ev.fromPlace)
    if (!place) return null
    const precision = ev.locationPlace ? ev.precision : 'near'
    return {
      point: { lat: place.lat, lon: place.lon },
      sigma: observationSigma(place, precision),
      name: place.name,
    }
  }

  #associate(
    ev: ResolvedEvent,
    ctx: ApplyContext,
    point: LatLon | null,
    used: Set<string>,
  ): TrackState | null {
    const usable = (s: TrackState | undefined): s is TrackState =>
      !!s && s.track.status === 'active' && typesCompatible(s.track.type, ev.type)

    // 1. The model linked it explicitly.
    if (ev.track_id) {
      const s = this.#states.get(ev.track_id)
      if (usable(s)) return s
    }

    // 2. A reply to a post about known tracks.
    const parents = ctx.parentTrackIds.map((id) => this.#states.get(id)).filter(usable)
    const freeParents = parents.filter((s) => !used.has(s.track.id))
    if (freeParents.length === 1) return freeParents[0]!
    if (freeParents.length > 1)
      return this.#nearest(freeParents, point, ctx.observedAt) ?? freeParents[0]!

    // 3. Spatial gating against everything compatible.
    const candidates = [...this.#states.values()].filter((s) => usable(s) && !used.has(s.track.id))
    if (!point) {
      const target = ev.towardPlace?.name
      return (
        candidates.find((s) => !s.track.position && target && s.track.target?.name === target) ??
        null
      )
    }
    return this.#nearest(candidates, point, ctx.observedAt, true)
  }

  #nearest(
    candidates: TrackState[],
    point: LatLon | null,
    at: number,
    gated = false,
  ): TrackState | null {
    if (!point) return null
    let best: TrackState | null = null
    let bestScore = Infinity
    for (const s of candidates) {
      if (!s.track.position) continue
      const predicted = this.#predicted(s, at)
      const dist = haversineKm(predicted.point, point)
      const gate = BASE_GATE_KM + 3 * predicted.sigma
      const score = dist / gate
      if (score < bestScore && (!gated || score <= 1)) {
        bestScore = score
        best = s
      }
    }
    return best
  }

  #predicted(s: TrackState, at: number): { point: LatLon; sigma: number } {
    if (!s.kf) return { point: s.track.position!, sigma: s.track.uncertaintyKm }
    const profile = THREAT_PROFILES[s.track.type]
    const dt = Math.min(Math.max(0, (at - s.track.stateAt) / 60_000), profile.maxExtrapolationMin)
    const kf = kfPredict(s.kf, dt, profile.processNoise)
    return { point: frame.toLatLon(kf.x[0], kf.x[1]), sigma: kfPositionSigma(kf) }
  }

  #courseHint(ev: ResolvedEvent, from: LatLon | null): number | null {
    if (ev.heading) return compassToBearing(ev.heading)
    if (ev.fromPlace && ev.locationPlace && haversineKm(ev.fromPlace, ev.locationPlace) > 3) {
      return bearingDeg(ev.fromPlace, ev.locationPlace)
    }
    if (ev.towardPlace && from && haversineKm(from, ev.towardPlace) > 3) {
      return bearingDeg(from, ev.towardPlace)
    }
    return null
  }

  #create(ev: ResolvedEvent, ctx: ApplyContext, obs: Observation | null): TrackState {
    const profile = THREAT_PROFILES[ev.type]
    const speed = cruiseKmh(ev.type, ev.model)
    const now = ctx.observedAt
    let kf: KalmanState | null = null
    if (obs && profile.moving) {
      const course = this.#courseHint(ev, obs.point)
      const vel = course === null ? { x: 0, y: 0 } : velocityFrom(course, speed)
      const velSigma = (speed / 60) * (course === null ? 1 : 0.35)
      kf = kfInit(frame.toXY(obs.point), obs.sigma, vel, velSigma)
    }
    const track: Track = {
      id: newId(),
      type: ev.type,
      model: ev.model ?? null,
      count: ev.count,
      status: 'active',
      position: obs?.point ?? null,
      speedKmh: null,
      headingDeg: null,
      stateAt: now,
      uncertaintyKm: obs?.sigma ?? 0,
      placeName: obs?.name ?? null,
      target: toTarget(ev.towardPlace),
      origin: toTarget(ev.fromPlace),
      prediction: null,
      confidence: ev.confidence,
      sources: [],
      createdAt: now,
      updatedAt: now,
    }
    const state: TrackState = { track, kf, lastObsAt: now, channels: [], removeAt: null, path: [] }
    if (obs) addPathPoint(state, obs, now)
    this.#states.set(track.id, state)
    this.#refresh(state)
    this.#touch(state, ev, ctx)
    return state
  }

  #update(state: TrackState, ev: ResolvedEvent, ctx: ApplyContext, obs: Observation | null): void {
    const at = Math.max(ctx.observedAt, state.track.stateAt)
    // A generic "unknown" report must not downgrade a specific type, but a specific one upgrades it.
    const type: ThreatType = state.track.type === 'unknown' ? ev.type : state.track.type
    const profile = THREAT_PROFILES[type]
    const model = ev.model ?? state.track.model ?? null
    const speed = cruiseKmh(type, model)
    const maxSpeed = maxKmh(type, model)
    const target = toTarget(ev.towardPlace) ?? state.track.target

    if (obs && profile.moving) {
      if (!state.kf) {
        const course = this.#courseHint(ev, obs.point)
        const vel = course === null ? { x: 0, y: 0 } : velocityFrom(course, speed)
        state.kf = kfInit(frame.toXY(obs.point), obs.sigma, vel, speed / 60)
      } else {
        const dt = (at - state.track.stateAt) / 60_000
        let kf = kfPredict(state.kf, dt, profile.processNoise)
        const { state: updated, d2 } = kfUpdatePosition(kf, frame.toXY(obs.point), obs.sigma)
        if (d2 > 16 && haversineKm(state.track.position ?? obs.point, obs.point) > 40) {
          // Wildly inconsistent: the object (or our association) jumped. Re-seed from the report.
          const course = this.#courseHint(ev, obs.point)
          const vel = course === null ? { x: 0, y: 0 } : velocityFrom(course, speed)
          kf = kfInit(frame.toXY(obs.point), obs.sigma, vel, speed / 60)
        } else {
          kf = updated
        }
        const course = this.#courseHint(ev, frame.toLatLon(kf.x[0], kf.x[1]))
        if (course !== null) {
          const speed = Math.max(kfVelocity(kf).speedKmh, profile.speedKmh * 0.7)
          kf = kfUpdateVelocity(
            kf,
            velocityFrom(course, speed),
            (profile.speedKmh / 60) * 0.35,
          ).state
        }
        state.kf = kfClampSpeed(kf, maxSpeed)
      }
    } else if (!profile.moving && obs) {
      state.kf = null
    }

    state.track = {
      ...state.track,
      type,
      model,
      count: ev.count ?? state.track.count,
      stateAt: obs ? at : state.track.stateAt,
      position: obs && !profile.moving ? obs.point : state.track.position,
      uncertaintyKm: obs && !profile.moving ? obs.sigma : state.track.uncertaintyKm,
      placeName: obs?.name ?? state.track.placeName,
      target,
      origin: toTarget(ev.fromPlace) ?? state.track.origin,
    }
    if (obs) {
      state.lastObsAt = Math.max(state.lastObsAt, ctx.observedAt)
      addPathPoint(state, obs, ctx.observedAt)
    }
    this.#refresh(state)
    this.#touch(state, ev, ctx)
  }

  /** Recompute wire kinematics from the filter. */
  #refresh(state: TrackState): void {
    const t = state.track
    if (!state.kf) {
      state.track = { ...t, speedKmh: null, headingDeg: null }
      return
    }
    const v = kfVelocity(state.kf)
    const moving = v.speedKmh >= MIN_REPORTED_SPEED_KMH
    state.track = {
      ...t,
      position: frame.toLatLon(state.kf.x[0], state.kf.x[1]),
      uncertaintyKm: Math.round(kfPositionSigma(state.kf) * 10) / 10,
      speedKmh: moving ? Math.round(v.speedKmh) : null,
      headingDeg: moving ? Math.round(v.headingDeg) : null,
    }
  }

  #touch(state: TrackState, ev: ResolvedEvent, ctx: ApplyContext): void {
    const m = ctx.message
    const source: TrackSource = {
      channel: m.channel,
      channelTitle: m.channelTitle,
      messageId: m.id,
      text: m.text.length > 280 ? `${m.text.slice(0, 277)}…` : m.text,
      at: m.date,
    }
    const sources = [
      source,
      ...state.track.sources.filter((s) => !(s.channel === m.channel && s.messageId === m.id)),
    ].slice(0, MAX_SOURCES)
    if (!state.channels.includes(m.channel)) state.channels.push(m.channel)
    const corroboration = 0.1 * (state.channels.length - 1)
    state.track = {
      ...state.track,
      sources,
      confidence: Math.min(0.99, Math.max(state.track.confidence, ev.confidence) + corroboration),
      updatedAt: Math.max(state.track.updatedAt, ctx.observedAt),
    }
    this.#emit(state, ctx.observedAt)
  }

  #setStatus(
    state: TrackState,
    status: 'destroyed' | 'lost',
    now: number,
    ev?: ResolvedEvent,
    ctx?: ApplyContext,
  ): void {
    // Freeze the icon where we last believed it was.
    const position = state.kf ? this.#predicted(state, now).point : state.track.position
    state.kf = null
    state.removeAt = now + (status === 'destroyed' ? DESTROYED_LINGER_MS : LOST_LINGER_MS)
    state.track = {
      ...state.track,
      status,
      position,
      stateAt: now,
      speedKmh: null,
      headingDeg: null,
      updatedAt: now,
    }
    if (ev && ctx) this.#touch(state, ev, ctx)
    else this.#emit(state, now)
  }

  #emit(state: TrackState, now: number): void {
    state.track = { ...state.track, prediction: this.#hooks.predict?.(state.track, now) ?? null }
    this.#hooks.onChange?.(state.track, state)
  }

  snapshot(): TrackState[] {
    return [...this.#states.values()]
  }
}

function addPathPoint(state: TrackState, obs: Observation, at: number): void {
  const last = state.path.at(-1)
  if (last?.place === obs.name) return
  state.path.push({ lat: obs.point.lat, lon: obs.point.lon, at, place: obs.name })
  if (state.path.length > 60) state.path.shift()
}

/** Cruise speed from the named model's published figures, else the type default. */
function cruiseKmh(type: ThreatType, model: string | null | undefined): number {
  const spec = model ? weaponSpec(model) : null
  return spec && spec.type === type ? spec.cruiseKmh : THREAT_PROFILES[type].speedKmh
}

function maxKmh(type: ThreatType, model: string | null | undefined): number {
  const spec = model ? weaponSpec(model) : null
  return spec && spec.type === type ? spec.maxKmh : THREAT_PROFILES[type].maxSpeedKmh
}

function toTarget(place: Place | null): NamedPoint | null {
  return place ? { name: place.name, lat: place.lat, lon: place.lon } : null
}
