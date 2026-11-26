import { randomBytes } from 'node:crypto'
import {
  bearingDeg,
  compassToBearing,
  destination,
  haversineKm,
  inBbox,
  kmToTarget,
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
  /** `id` turned out to be the same object as `into` and was folded into it. */
  onMerge?(id: string, into: string): void
}

/** Below this, the filter's velocity is noise, not a course. */
const MIN_REPORTED_SPEED_KMH = 25
/** Base association gate, km — reports name the nearest village, not the object. */
const BASE_GATE_KM = 20
const DESTROYED_LINGER_MS = 90_000
const LOST_LINGER_MS = 60_000
const MAX_SOURCES = 6
/** Places sent to clients to draw where the object has been. */
const TRAIL_POINTS = 15
/**
 * Reports lag behind the object by tens of seconds, so two places named a minute
 * apart can imply twice the real speed. Above this share of cruise it is noise.
 */
const SPEED_CAP_FACTOR = 1.2
/** Two channels describing one object: tracks this close, on similar courses, merge. */
const MERGE_KM = 6
const MERGE_HEADING_DEG = 60
const MERGE_RECENT_MS = 4 * 60_000
/** An origin this precise (a village, not an oblast or a sea) can stand in for a position. */
const MAX_ORIGIN_AS_POSITION_KM = 5
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
  /** Ids of merged tracks → the track they live on in (replies still name the old id). */
  readonly #aliases = new Map<string, string>()
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
    return this.#state(id)?.track
  }

  #state(id: string): TrackState | undefined {
    return this.#states.get(this.#aliases.get(id) ?? id)
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
    const ids = events.map((ev) => {
      const id = this.#applyOne(ev, ctx, used)
      if (id) used.add(id)
      return id
    })
    return ids.map((id) => (id ? this.#mergeDuplicates(id, ctx.observedAt) : id))
  }

  /**
   * Different channels open their own thread for the same drone ("з півночі до X" vs
   * "з Дніпропетровщини на Y"), so one object becomes two tracks that then fly over the
   * same villages. When an updated track sits on top of another one of the same kind, on
   * a similar course, and both were just observed, fold the younger into the older.
   */
  #mergeDuplicates(id: string, now: number): string {
    const a = this.#states.get(id)
    if (a?.track.status !== 'active' || !a.kf) return id
    for (const b of this.#states.values()) {
      if (b === a || b.track.status !== 'active' || !b.kf) continue
      if (!typesCompatible(a.track.type, b.track.type)) continue
      if (now - a.lastObsAt > MERGE_RECENT_MS || now - b.lastObsAt > MERGE_RECENT_MS) continue
      if (haversineKm(this.#predicted(a, now).point, this.#predicted(b, now).point) > MERGE_KM)
        continue
      const ha = a.track.headingDeg
      const hb = b.track.headingDeg
      if (ha !== null && hb !== null && Math.abs(((ha - hb + 540) % 360) - 180) > MERGE_HEADING_DEG)
        continue
      const [keep, drop] = a.track.createdAt <= b.track.createdAt ? [a, b] : [b, a]
      this.#merge(keep, drop)
      return keep.track.id
    }
    return id
  }

  #merge(keep: TrackState, drop: TrackState): void {
    const fresher = drop.lastObsAt > keep.lastObsAt ? drop : keep
    const sources = [...keep.track.sources, ...drop.track.sources]
      .sort((x, y) => y.at - x.at)
      .slice(0, MAX_SOURCES)
    const path = [...keep.path, ...drop.path].sort((x, y) => x.at - y.at)
    keep.path = path.filter((p, i) => p.place !== path[i - 1]?.place).slice(-60)
    keep.channels = [...new Set([...keep.channels, ...drop.channels])]
    keep.kf = fresher.kf
    keep.lastObsAt = fresher.lastObsAt
    keep.track = {
      ...keep.track,
      type: keep.track.type === 'unknown' ? drop.track.type : keep.track.type,
      model: keep.track.model ?? drop.track.model,
      count: Math.max(keep.track.count ?? 0, drop.track.count ?? 0) || null,
      stateAt: fresher.track.stateAt,
      placeName: fresher.track.placeName,
      target: fresher.track.target ?? keep.track.target,
      origin: keep.track.origin ?? drop.track.origin,
      altitudeM: fresher.track.altitudeM ?? keep.track.altitudeM ?? drop.track.altitudeM ?? null,
      sources,
      confidence: Math.min(
        0.99,
        Math.max(keep.track.confidence, drop.track.confidence) + 0.1 * (keep.channels.length - 1),
      ),
      updatedAt: Math.max(keep.track.updatedAt, drop.track.updatedAt),
    }
    this.#states.delete(drop.track.id)
    for (const [from, to] of this.#aliases) {
      if (to === drop.track.id) this.#aliases.set(from, keep.track.id)
    }
    this.#aliases.set(drop.track.id, keep.track.id)
    this.#hooks.onMerge?.(drop.track.id, keep.track.id)
    this.#refresh(keep)
    this.#emit(keep, keep.track.updatedAt)
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
        for (const [from, to] of this.#aliases) if (to === s.track.id) this.#aliases.delete(from)
        this.#hooks.onRemove?.(s.track.id, s)
        continue
      }
      const ttl = THREAT_PROFILES[s.track.type].ttlMin * 60_000
      if (s.track.status === 'active' && now - s.lastObsAt > ttl) this.#setStatus(s, 'lost', now)
    }
    // Two channels' tracks often converge between reports (both dead-reckon to the same
    // named target), so look for duplicates on the clock too, not only on updates.
    for (const id of [...this.#states.keys()]) {
      if (this.#states.has(id)) this.#mergeDuplicates(id, now)
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
    // "Від Пологів на Оріхів" puts a drone near Пологи; but "з Дніпропетровщини" or a
    // ballistic "з Криму" is a direction of origin, never a position.
    const local = (p: Place | null) =>
      p && p.precisionKm <= MAX_ORIGIN_AS_POSITION_KM && inBbox(p) ? p : null
    const place = ev.locationPlace ?? (ev.type === 'ballistic' ? null : local(ev.fromPlace))
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
      const s = this.#state(ev.track_id)
      if (usable(s)) return s
    }

    // 2. A reply to a post about known tracks (merged ids resolve to their survivor).
    const parents = [...new Set(ctx.parentTrackIds.map((id) => this.#state(id)))].filter(usable)
    const freeParents = parents.filter((s) => !used.has(s.track.id))
    if (freeParents.length === 1) return freeParents[0]!
    if (freeParents.length > 1)
      return this.#nearest(freeParents, point, ctx.observedAt) ?? freeParents[0]!

    // 3. Spatial gating against everything compatible.
    const candidates = [...this.#states.values()].filter((s) => usable(s) && !used.has(s.track.id))
    if (!point) {
      const target = ev.towardPlace?.name
      if (!target) return null
      const same = candidates.filter((s) => s.track.target?.name === target)
      // "Реактив до Ясної Поляни продовжує рух" from another channel: the one object of
      // this kind already heading there. A "new" report means another object.
      if (ev.action !== 'new' && same.length === 1) return same[0]!
      return same.find((s) => !s.track.position) ?? null
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
    // Like the map: an object with a named target waits there, not beyond it, so the next
    // report is matched against where it was going rather than somewhere past it.
    const v = kfVelocity(s.kf)
    const left = s.track.position ? kmToTarget({ ...s.track, headingDeg: v.headingDeg }) : null
    const point =
      left !== null && (v.speedKmh / 60) * dt > left
        ? destination(s.track.position!, v.headingDeg, left)
        : frame.toLatLon(kf.x[0], kf.x[1])
    return { point, sigma: kfPositionSigma(kf) }
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
      altitudeM: ev.altitude_m ?? null,
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
    const maxSpeed = Math.min(maxKmh(type, model), speed * SPEED_CAP_FACTOR)
    const target = toTarget(ev.towardPlace) ?? state.track.target
    let reaimed = false

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
          // Wildly inconsistent: the object (or our association) jumped. Re-seed from the report,
          // keeping the direction it evidently moved in when the post gives none.
          const last = state.path.at(-1)
          const course =
            this.#courseHint(ev, obs.point) ??
            (last && haversineKm(last, obs.point) > 3 ? bearingDeg(last, obs.point) : null)
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
    } else if (!obs && profile.moving && state.kf && (ev.towardPlace || ev.heading)) {
      // "Довернув на X" / "курс на північ": a new course without a position.
      // Turn from where we believe it is now instead of flying the old course.
      const dt = Math.min((at - state.track.stateAt) / 60_000, profile.maxExtrapolationMin)
      let kf = kfPredict(state.kf, Math.max(0, dt), profile.processNoise)
      const course = this.#courseHint(ev, frame.toLatLon(kf.x[0], kf.x[1]))
      if (course !== null) {
        const v = Math.min(Math.max(kfVelocity(kf).speedKmh, speed * 0.7), maxSpeed)
        kf = kfUpdateVelocity(kf, velocityFrom(course, v), (speed / 60) * 0.2).state
        state.kf = kfClampSpeed(kf, maxSpeed)
        reaimed = true
      }
    } else if (!profile.moving && obs) {
      state.kf = null
    }

    state.track = {
      ...state.track,
      type,
      model,
      count: ev.count ?? state.track.count,
      stateAt: obs || reaimed ? at : state.track.stateAt,
      position: obs && !profile.moving ? obs.point : state.track.position,
      uncertaintyKm: obs && !profile.moving ? obs.sigma : state.track.uncertaintyKm,
      placeName: obs?.name ?? state.track.placeName,
      target,
      origin: toTarget(ev.fromPlace) ?? state.track.origin,
      altitudeM: ev.altitude_m ?? state.track.altitudeM ?? null,
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
    const trail = state.path
      .slice(-TRAIL_POINTS)
      .map((p) => ({ name: p.place, lat: p.lat, lon: p.lon, at: p.at }))
    const t = { ...state.track, trail }
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
