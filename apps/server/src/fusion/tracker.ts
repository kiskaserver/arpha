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
  sameKind,
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
import { foldName, stemName } from '../text/normalize'
import {
  type KalmanState,
  kfClampSpeed,
  kfInit,
  kfPositionSigma,
  kfPredict,
  kfSnapPosition,
  kfUpdatePosition,
  kfUpdateVelocity,
  kfVelocity,
  velocityFrom,
} from './kalman'

export interface ResolvedEvent extends ExtractedEvent {
  locationPlace: Place | null
  fromPlace: Place | null
  towardPlace: Place | null
  /** Alternative goals the post joined to `toward` with "/" ("Оріхів/Таврійське"). */
  towardAlts?: Place[]
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
  /**
   * A report the object could not have reached from its last place. Ignored once; if the
   * next report agrees with it rather than with the track, the track was what was wrong.
   */
  suspect?: PathPoint | null
}

export interface TrackerHooks {
  /** Forecast attached to every published state (see predict/predictor.ts). */
  predict?(track: Track, now: number): Track['prediction']
  onChange?(track: Track, state: TrackState): void
  onRemove?(id: string, state: TrackState): void
  /** `id` turned out to be the same object as `into` and was folded into it. */
  onMerge?(id: string, into: string): void
  /** Whether a point lies outside the covered oblast (objects that left it are dropped). */
  outside?(p: LatLon): boolean
}

/** Below this, the filter's velocity is noise, not a course. */
const MIN_REPORTED_SPEED_KMH = 25
/** Base association gate, km — reports name the nearest village, not the object. */
const BASE_GATE_KM = 20
const DESTROYED_LINGER_MS = 90_000
/**
 * A lost object (no reports, "зник", "без фіксації") often reappears minutes or hours
 * later in the same reply thread. Its state is kept this long so it comes back with its
 * history instead of as a new track; clients stop showing it after their linger setting.
 */
const REVIVE_MS = 2 * 3_600_000
/** Without an explicit link, only a recently lost object is revived by proximity. */
const SPATIAL_REVIVE_MS = 10 * 60_000
/** Last seen outside the oblast and silent this long: it flew away ("на Дніпропетровщину"). */
const LEFT_REGION_MS = 2 * 60_000
/** Finished tracks older than this are not sent to clients any more. */
const SHOWN_AFTER_END_MS = 15 * 60_000
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
/** Explosion reports this close in space and time describe the same blast. */
const SAME_BLAST_KM = 2
const SAME_BLAST_MS = 15 * 60_000
/** A course-only update with no visible thread joins the single object this close to its goal. */
const COURSE_ONLY_KM = 25
/** An unattached update this far from every object of its reply thread is a misread place. */
const THREAD_RADIUS_KM = 40
/** Reports this close to the forecast are blended; farther ones move the object there. */
const SNAP_KM = 1.5
/** Slack on the reachable distance: report lag, district size, the odd cut corner. */
const REACH_SLACK_KM = 8
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
  /** Pairs of tracks one post described as separate groups: never merged ("3 … ⏎ 2 …"). */
  readonly #distinct = new Set<string>()
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

  /** What clients need: everything active, plus recently ended tracks (not dormant ones). */
  visible(now: number): Track[] {
    return this.tracks().filter(
      (t) => t.status === 'active' || now - t.updatedAt <= SHOWN_AFTER_END_MS,
    )
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
    const courseOnly = (e: ResolvedEvent) =>
      e.action === 'update' && !e.locationPlace && e.count === null
    // Only goals the post itself joins with "/" ("Аеропорт/Матвіївка") are alternatives;
    // "1 на Степногірськ ⏎ 1 на Червонодніпровку" or "перший …, другий …" are two objects.
    const text = foldName(ctx.message.text)
    const key = (e: ResolvedEvent) => stemName(foldName(e.towardPlace?.name ?? '')).slice(0, 4)
    const slashed = (a: ResolvedEvent, b: ResolvedEvent) =>
      text
        .split(/[\n,;!?]/)
        .some((part) => part.includes('/') && part.includes(key(a)) && part.includes(key(b)))
    // "Всі до Хортицького" came back as six "lost" events, one per active threat of every
    // channel. A post ends the objects of its own reply thread; outside a thread, at most
    // one object on the model's say-so alone. Naming where it fell still ends it.
    const thread = new Set(ctx.parentTrackIds.map((id) => this.#state(id)?.track.id))
    let endedOnSaySo = false
    const mayEnd = (e: ResolvedEvent): boolean => {
      if ((e.action !== 'lost' && e.action !== 'destroyed') || e.locationPlace) return true
      const named = e.track_id ? this.#state(e.track_id)?.track.id : undefined
      if (ctx.parentTrackIds.length) return named === undefined || thread.has(named)
      if (endedOnSaySo) return false
      endedOnSaySo = true
      return true
    }
    const ids: (string | null)[] = []
    for (const [i, ev] of events.entries()) {
      if (!mayEnd(ev)) {
        ids.push(null)
        continue
      }
      // "Курс Аеропорт/Матвіївка" split by the model into two course-only updates of one
      // object: the second is an alternative goal, not another object. Counted lines
      // ("3 … ⏎ 1 …") or named positions stay separate.
      const alternative =
        courseOnly(ev) &&
        events
          .slice(0, i)
          .some((p, j) => ids[j] && p.type === ev.type && courseOnly(p) && slashed(p, ev))
      if (alternative && ev.towardPlace) {
        const first = events.findIndex((p, j) => j < i && ids[j] && courseOnly(p) && slashed(p, ev))
        const s = this.#state(ids[first]!)
        if (s) {
          s.track = withAlt(s.track, ev.towardPlace)
          this.#emit(s, ctx.observedAt)
        }
      }
      const id = alternative ? null : this.#applyOne(ev, ctx, used)
      if (id) used.add(id)
      ids.push(id)
    }
    // Events that differ (place, course or count) are groups the post told apart; identical
    // ones are the model repeating a single object and say nothing.
    const sig = (e: ResolvedEvent) =>
      `${e.locationPlace?.name}|${e.towardPlace?.name}|${e.count ?? ''}`
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        if (!a || !b || a === b || sig(events[i]!) === sig(events[j]!)) continue
        this.#distinct.add(a < b ? `${a}|${b}` : `${b}|${a}`)
      }
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
    if (a?.track.status !== 'active' || a.track.type === 'explosion') return id
    for (const b of this.#states.values()) {
      if (b === a || b.track.status !== 'active') continue
      if (!sameKind(a.track.type, b.track.type)) continue
      const pair =
        a.track.id < b.track.id ? `${a.track.id}|${b.track.id}` : `${b.track.id}|${a.track.id}`
      if (this.#distinct.has(pair)) continue
      if (now - a.track.updatedAt > MERGE_RECENT_MS || now - b.track.updatedAt > MERGE_RECENT_MS)
        continue
      if (a.track.position && b.track.position) {
        // Moving objects by their forecast, KAB groups and the like by where they were named.
        if (haversineKm(this.#predicted(a, now).point, this.#predicted(b, now).point) > MERGE_KM)
          continue
      } else if (a.track.position || b.track.position) {
        continue
      } else if (!a.track.target || a.track.target.name !== b.track.target?.name) {
        // Two position-less announcements: the same only when they name the same target.
        continue
      }
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
      altTargets: fresher.track.target ? fresher.track.altTargets : keep.track.altTargets,
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

  /** "Чисто" about one thread: its objects are gone, the rest of the sky is not. */
  endThread(ids: string[], now: number): void {
    for (const id of ids) {
      const s = this.#state(id)
      if (s?.track.status === 'active') this.#setStatus(s, 'lost', now)
    }
  }

  /** "Відбій" for the region: everything still in the air is considered gone. */
  allClear(now: number, only?: ThreatType[]): void {
    for (const s of this.#states.values()) {
      if (s.track.status !== 'active') continue
      if (only && !only.includes(s.track.type)) continue
      this.#setStatus(s, 'lost', now)
    }
  }

  /** Expire stale tracks and purge lingering ones. Call periodically. */
  tick(now: number): void {
    for (const s of [...this.#states.values()]) {
      if (s.removeAt !== null && now >= s.removeAt) {
        this.#states.delete(s.track.id)
        for (const [from, to] of this.#aliases) if (to === s.track.id) this.#aliases.delete(from)
        for (const pair of this.#distinct)
          if (pair.includes(s.track.id)) this.#distinct.delete(pair)
        this.#hooks.onRemove?.(s.track.id, s)
        continue
      }
      if (s.track.status !== 'active') continue
      const ttl = THREAT_PROFILES[s.track.type].ttlMin * 60_000
      const last = s.path.at(-1)
      const left =
        last && now - s.lastObsAt > LEFT_REGION_MS && this.#hooks.outside?.(last) === true
      // A lost object stays revivable (REVIVE_MS) if it turns up again.
      if (left || now - s.lastObsAt > ttl) this.#setStatus(s, 'lost', now)
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
      // An "update" in a reply names objects of that thread. One that cannot be attached and
      // lies far from all of them is a misread place ("ДД" → Дніпрорудне), not a new threat;
      // a nearby one is a real extra object ("1 Заводи ⏎ 1 Аеропорт ⏎ 1 Українка").
      const where = obs?.point ?? ev.towardPlace
      const thread = ctx.parentTrackIds
        .map((id) => this.#state(id)?.track.position)
        .filter((p): p is LatLon => !!p)
      if (
        ev.action === 'update' &&
        where &&
        thread.length &&
        thread.every((p) => haversineKm(p, where) > THREAD_RADIUS_KM)
      ) {
        return null
      }
      const created = this.#create(ev, ctx, obs)
      // "Ще БпЛА повз Смоляне": the channel says this is another object than the ones it is
      // already reporting, so a later merge must not fold them back together.
      if (ev.action === 'new') {
        for (const other of this.#states.values()) {
          if (
            other !== created &&
            other.track.status === 'active' &&
            other.channels.includes(ctx.message.channel)
          ) {
            const [x, y] = [created.track.id, other.track.id].sort()
            this.#distinct.add(`${x}|${y}`)
          }
        }
      }
      return created.track.id
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
    const at = ctx.observedAt
    // "Впали" in reply to a KAB thread often comes back typed as an explosion: an ending
    // without a specific type ends the thread's object, whatever it is.
    const ending = ev.action === 'lost' || ev.action === 'destroyed'
    const anyType = ending && (ev.type === 'explosion' || ev.type === 'unknown')
    const compatible = (s: TrackState | undefined): s is TrackState =>
      !!s && (anyType ? s.track.type !== 'explosion' : typesCompatible(s.track.type, ev.type))
    // Explicit links (model id, reply chain) may wake a lost object up to two hours later.
    const usable = (s: TrackState | undefined): s is TrackState =>
      compatible(s) &&
      (s.track.status === 'active' ||
        (s.track.status === 'lost' && at - s.track.updatedAt <= REVIVE_MS))
    // Proximity alone only for something lost minutes ago.
    const nearby = (s: TrackState): boolean =>
      s.track.status === 'active' ||
      (s.track.status === 'lost' && at - s.track.updatedAt <= SPATIAL_REVIVE_MS)
    // "Ще 3 …", "ще шахед", "ще пара": the channel itself says this is another object, so not
    // one it is already reporting (another channel's report of it is still a duplicate).
    const fresh = ev.action === 'new'
    // …while that object is still being reported; a lost one may simply have reappeared.
    const own = (s: TrackState) =>
      s.track.status === 'active' && s.channels.includes(ctx.message.channel)

    // A blast is a point: only a report of the same spot minutes later is the same one
    // (separate explosions at Кар'єри, Мокрянка and Космос are not a flight path).
    if (ev.type === 'explosion' && ev.action !== 'lost' && ev.action !== 'destroyed') {
      if (!point) return null
      return (
        [...this.#states.values()].find(
          (s) =>
            s.track.type === 'explosion' &&
            s.track.position !== null &&
            haversineKm(s.track.position, point) <= SAME_BLAST_KM &&
            at - s.track.updatedAt <= SAME_BLAST_MS,
        ) ?? null
      )
    }

    // 1. The model linked it explicitly.
    if (ev.track_id) {
      const s = this.#state(ev.track_id)
      if (usable(s) && !(fresh && own(s))) return s
    }

    // 2. A reply to a post about known tracks (merged ids resolve to their survivor).
    const parents = fresh
      ? []
      : [...new Set(ctx.parentTrackIds.map((id) => this.#state(id)))].filter(usable)
    const freeParents = parents.filter((s) => !used.has(s.track.id))
    if (freeParents.length === 1) return freeParents[0]!
    if (freeParents.length > 1)
      return this.#nearest(freeParents, point, ctx.observedAt) ?? freeParents[0]!

    // 3. Spatial gating against everything compatible.
    const candidates = [...this.#states.values()].filter(
      (s) =>
        sameKind(s.track.type, ev.type) && nearby(s) && !used.has(s.track.id) && !(fresh && own(s)),
    )
    if (!point) {
      const target = ev.towardPlace?.name
      if (!target) return null
      // A repeated position-less warning ("Загроза балістики на Запоріжжя") is the same one,
      // even when the channel posts it again as new.
      const announced = [...this.#states.values()].find(
        (s) =>
          sameKind(s.track.type, ev.type) &&
          nearby(s) &&
          !used.has(s.track.id) &&
          !s.track.position &&
          s.track.target?.name === target,
      )
      if (announced) return announced
      const same = candidates.filter((s) => s.track.target?.name === target)
      // "Реактив до Ясної Поляни продовжує рух" from another channel: the one object of
      // this kind already heading there. A "new" report means another object.
      if (ev.action !== 'new' && same.length === 1) return same[0]!
      // "Розвернувся в бік X" whose thread we cannot see: the one object of this kind close to X.
      const toward = ev.towardPlace
      if (ev.action !== 'new' && toward) {
        const close = candidates.filter(
          (s) => s.track.position && haversineKm(s.track.position, toward) <= COURSE_ONLY_KM,
        )
        if (close.length === 1) return close[0]!
      }
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

  /**
   * The observation, or null when the object could not have got there since its last
   * report. A second report agreeing with a rejected one wins: the track had it wrong.
   */
  #plausible(
    state: TrackState,
    obs: Observation,
    at: number,
    maxSpeedKmh: number,
  ): Observation | null {
    const last = state.path.at(-1)
    const reach = (from: PathPoint) =>
      (maxSpeedKmh / 60) * Math.max(0, (at - from.at) / 60_000) * 1.5 + REACH_SLACK_KM
    if (!last || haversineKm(last, obs.point) <= reach(last)) {
      state.suspect = null
      return obs
    }
    const suspect = state.suspect
    if (suspect && haversineKm(suspect, obs.point) <= reach(suspect)) {
      // Two reports agree with each other, not with us: start again from them.
      state.suspect = null
      state.kf = null
      state.path = [suspect]
      return obs
    }
    state.suspect = { lat: obs.point.lat, lon: obs.point.lon, at, place: obs.name }
    return null
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
      altTargets: alternatives(ev),
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

  #update(
    state: TrackState,
    ev: ResolvedEvent,
    ctx: ApplyContext,
    reported: Observation | null,
  ): void {
    let obs = reported
    if (state.track.status === 'lost') {
      // It reappeared: same object, same history, fresh filter from this report.
      state.removeAt = null
      state.kf = null
      state.track = { ...state.track, status: 'active', speedKmh: null, headingDeg: null }
    }
    const at = Math.max(ctx.observedAt, state.track.stateAt)
    // A generic "unknown" report must not downgrade a specific type, but a specific one upgrades it.
    const type: ThreatType = state.track.type === 'unknown' ? ev.type : state.track.type
    const profile = THREAT_PROFILES[type]
    const model = ev.model ?? state.track.model ?? null
    const speed = cruiseKmh(type, model)
    const maxSpeed = Math.min(maxKmh(type, model), speed * SPEED_CAP_FACTOR)
    const target = toTarget(ev.towardPlace) ?? state.track.target
    let reaimed = false
    // "ДД" read as Дніпрорудне, "Острів" as Остриківка: 60 km away twenty seconds after the
    // last report. Physically impossible places are not where it is.
    if (obs && profile.moving)
      obs = this.#plausible(state, obs, ctx.observedAt, maxKmh(type, model))

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
          // The report is where it is now; the filter only has to work out the course.
          const p = frame.toLatLon(kf.x[0], kf.x[1])
          if (haversineKm(p, obs.point) > SNAP_KM) {
            kf = kfSnapPosition(kf, frame.toXY(obs.point), Math.min(obs.sigma, 3))
          }
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
      // A new goal brings its own alternatives (or none); without one the old ones stay.
      altTargets: ev.towardPlace ? alternatives(ev) : state.track.altTargets,
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
    state.removeAt = now + (status === 'destroyed' ? DESTROYED_LINGER_MS : REVIVE_MS)
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

function alternatives(ev: ResolvedEvent): NamedPoint[] | undefined {
  const alts = (ev.towardAlts ?? []).filter((p) => p.name !== ev.towardPlace?.name)
  return alts.length ? alts.map((p) => toTarget(p)!) : undefined
}

function withAlt(track: Track, place: Place): Track {
  const known = [track.target, ...(track.altTargets ?? [])].some((t) => t?.name === place.name)
  return known ? track : { ...track, altTargets: [...(track.altTargets ?? []), toTarget(place)!] }
}
