import {
  bearingDeg,
  haversineKm,
  type LatLon,
  type PredictedTarget,
  type Prediction,
  THREAT_CLASS,
  THREAT_PROFILES,
  type Track,
} from '@arpha/shared'
import type { PlaceKind, PlaceRecord } from '../geo/gazetteer'
import { nextProbabilities, type TransitionTable } from './patterns'

/** How likely a kind of place is to be the intended target, all else equal. */
const KIND_WEIGHT: Partial<Record<PlaceKind, number>> = {
  city: 1.6,
  district: 1.4,
  landmark: 1.5,
  town: 1.2,
  village: 0.6,
}

export interface Candidate extends LatLon {
  name: string
  weight: number
}

const MAX_TARGETS = 3

/**
 * Forecasts where a threat is heading and what it may hit.
 *
 * score(place) = course likelihood (Gaussian in the angle off the course)
 *              × reachability (closer within the horizon is likelier)
 *              × place importance (city districts, bridges, plants)
 *              × historical prior (how often that place was reported/hit
 *                in the last 30 days — routes repeat, especially for KABs)
 *              × 3 if a source named it as the destination
 *              × (1 + 3·P(next = place | current place)) — learned routes.
 * Scores are normalised over the top candidates into probabilities.
 */
export class Predictor {
  #candidates: Candidate[]
  #prior = new Map<string, number>()
  #transitions: TransitionTable = new Map()

  constructor(places: PlaceRecord[]) {
    this.#candidates = places
      .filter((p) => (p.r === 'ZP' || p.r === undefined) && KIND_WEIGHT[p.k] !== undefined)
      .map((p) => ({
        name: p.n,
        lat: p.lat,
        lon: p.lon,
        weight: (KIND_WEIGHT[p.k] ?? 1) * (1 + Math.log10((p.p ?? 0) + 1) / 6),
      }))
  }

  /** Learned place→place movement (see patterns.ts). */
  setTransitions(table: TransitionTable): void {
    this.#transitions = table
  }

  /** Counts of recent observations/impacts per place name. */
  setPrior(counts: Map<string, number>): void {
    this.#prior = counts
  }

  predict(track: Track, now: number): Prediction | null {
    if (track.status !== 'active') return null
    const profile = THREAT_PROFILES[track.type]
    const base = { computedAt: now, horizonMin: profile.predictHorizonMin }

    // Stationary / target-only threats: the impact zone is the named target or the reported spot.
    if (
      !profile.moving ||
      track.speedKmh === null ||
      track.headingDeg === null ||
      !track.position
    ) {
      const spot = track.target ?? (profile.impactRadiusKm > 0 ? track.position : null)
      if (!spot) return null
      return {
        ...base,
        targets: track.target ? [{ ...track.target, p: 1, etaMin: null }] : [],
        impact:
          profile.impactRadiusKm > 0
            ? { lat: spot.lat, lon: spot.lon, radiusKm: profile.impactRadiusKm }
            : null,
      }
    }

    const reachKm = (track.speedKmh / 60) * profile.predictHorizonMin
    // Where objects of this class went next from here in past attacks.
    const learned = track.placeName
      ? nextProbabilities(this.#transitions, THREAT_CLASS[track.type], track.placeName)
      : new Map<string, number>()
    const sigma = Math.max(profile.coneHalfAngleDeg / 1.5, 8)
    const scored: (PredictedTarget & { score: number })[] = []
    for (const c of this.#candidates) {
      const d = haversineKm(track.position, c)
      if (d < 0.5 || d > reachKm * 1.15) continue
      const off = Math.abs(((bearingDeg(track.position, c) - track.headingDeg + 540) % 360) - 180)
      const history = learned.get(c.name) ?? 0
      if (off > profile.coneHalfAngleDeg * 1.5 && history < 0.2) continue
      // A route that history says is common stays plausible even if the course says otherwise.
      const course = Math.max(Math.exp(-((off / sigma) ** 2)), history > 0.2 ? 0.3 : 0)
      const reach = 1 - 0.6 * (d / (reachKm * 1.15))
      const prior = 1 + Math.log1p(this.#prior.get(c.name) ?? 0)
      const named = track.target?.name === c.name ? 3 : 1
      const score = course * reach * c.weight * prior * named * (1 + 3 * history)
      const etaMin = off <= profile.coneHalfAngleDeg / 2 ? d / (track.speedKmh / 60) : null
      scored.push({ name: c.name, lat: c.lat, lon: c.lon, p: 0, etaMin, score })
    }
    // The declared destination may be beyond the horizon — keep it in the list anyway.
    if (track.target && !scored.some((s) => s.name === track.target!.name)) {
      const d = haversineKm(track.position, track.target)
      scored.push({ ...track.target, p: 0, etaMin: d / (track.speedKmh / 60), score: 0.5 })
    }
    if (!scored.length) return { ...base, targets: [], impact: null }

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, MAX_TARGETS)
    // A destination a source named explicitly always stays on the list.
    const declared = track.target && scored.find((s) => s.name === track.target!.name)
    if (declared && !top.includes(declared)) top[top.length - 1] = declared
    const total = top.reduce((s, t) => s + t.score, 0)
    const targets = top.map(({ score, ...t }) => ({
      ...t,
      p: Math.round((score / total) * 100) / 100,
      etaMin: t.etaMin === null ? null : Math.round(t.etaMin * 10) / 10,
    }))
    const best = targets[0]!
    return {
      ...base,
      targets,
      impact:
        profile.impactRadiusKm > 0 && best.p >= 0.4
          ? { lat: best.lat, lon: best.lon, radiusKm: Math.max(profile.impactRadiusKm, 0.5) }
          : null,
    }
  }
}
