import { haversineKm, type LatLon } from '@arpha/shared'
import { foldName, jaroWinkler, stemName } from '../text/normalize'

export type PlaceKind =
  | 'city'
  | 'town'
  | 'village'
  | 'district'
  | 'raion'
  | 'oblast'
  | 'landmark'
  | 'water'

/** Compact on-disk record (data/gazetteer.json). */
export interface PlaceRecord {
  /** Ukrainian display name. */
  n: string
  /** Alternative spellings (Russian, transliterations, old names). */
  a?: string[]
  lat: number
  lon: number
  k: PlaceKind
  /** Population (0 when unknown). */
  p?: number
  /** Region code: ZP = Zaporizhzhia oblast, otherwise neighbour. */
  r?: string
  /** Precision override in km (landmarks, raions, areas). */
  e?: number
}

export interface Place extends LatLon {
  name: string
  kind: PlaceKind
  /** 1-sigma radius of what the name designates. */
  precisionKm: number
  /** Match quality in [0, 1]. */
  score: number
}

const KIND_RANK: Record<PlaceKind, number> = {
  city: 6,
  district: 5,
  town: 5,
  landmark: 4,
  water: 3,
  raion: 3,
  village: 2,
  oblast: 1,
}

const DEFAULT_PRECISION_KM: Record<PlaceKind, number> = {
  city: 6,
  town: 3,
  village: 2,
  district: 3,
  raion: 25,
  oblast: 80,
  landmark: 4,
  water: 15,
}

interface Indexed {
  rec: PlaceRecord
  keys: string[]
  stems: string[]
}

export interface LookupOptions {
  /** Prefer candidates near this point (e.g. the track's last position). */
  near?: LatLon
}

/**
 * Resolves free-text place names to coordinates. The LLM is asked to return
 * nominative Ukrainian names, but sources use Russian, abbreviations and case
 * forms, so we try exact → stem → fuzzy, then disambiguate homonyms
 * (Ukraine has dozens of "Михайлівка") by importance, region and proximity.
 */
export class Gazetteer {
  readonly #exact = new Map<string, Indexed[]>()
  readonly #stem = new Map<string, Indexed[]>()
  readonly #byFirst = new Map<string, Indexed[]>()
  readonly size: number

  constructor(records: PlaceRecord[]) {
    for (const rec of records) {
      const names = [rec.n, ...(rec.a ?? [])]
      const keys = [...new Set(names.map(foldName).filter((k) => k.length >= 2))]
      const stems = [...new Set(keys.flatMap((k) => alternations(stemName(k))))]
      const item: Indexed = { rec, keys, stems }
      for (const k of keys) push(this.#exact, k, item)
      for (const s of stems) push(this.#stem, s, item)
      for (const k of keys) push(this.#byFirst, k[0]!, item)
    }
    this.size = records.length
  }

  lookup(name: string, opts: LookupOptions = {}): Place | null {
    const key = foldName(name)
    if (key.length < 2) return null

    const exact = this.#exact.get(key)
    if (exact) return this.#best(exact, 1, opts)

    const stem = stemName(key)
    const byStem = this.#stem.get(stem)
    if (byStem) return this.#best(byStem, 0.95, opts)

    // Fuzzy: only compare names sharing the first letter, keeps it O(bucket).
    let bestScore = 0
    let candidates: Indexed[] = []
    for (const item of this.#byFirst.get(key[0]!) ?? []) {
      for (const k of item.stems) {
        const s = jaroWinkler(stem, k)
        if (s > bestScore + 1e-9) {
          bestScore = s
          candidates = [item]
        } else if (Math.abs(s - bestScore) <= 1e-9 && !candidates.includes(item)) {
          candidates.push(item)
        }
      }
    }
    const minScore = key.length <= 5 ? 0.95 : 0.9
    if (bestScore < minScore) return null
    return this.#best(candidates, bestScore, opts)
  }

  #best(items: Indexed[], score: number, opts: LookupOptions): Place {
    let best = items[0]!
    let bestRank = -Infinity
    for (const item of items) {
      const r = rank(item.rec, opts.near)
      if (r > bestRank) {
        bestRank = r
        best = item
      }
    }
    const rec = best.rec
    return {
      name: rec.n,
      lat: rec.lat,
      lon: rec.lon,
      kind: rec.k,
      precisionKm: rec.e ?? DEFAULT_PRECISION_KM[rec.k],
      score,
    }
  }
}

function rank(rec: PlaceRecord, near?: LatLon): number {
  let r = KIND_RANK[rec.k] * 10
  r += Math.log10((rec.p ?? 0) + 1) * 4
  if (rec.r === 'ZP') r += 15
  if (near) r -= haversineKm(near, rec) / 5
  return r
}

/**
 * Ukrainian і alternates with о/е in oblique cases: Оріхів → Оріхова,
 * Львів → Львова. Index both so case forms hit the stem map directly.
 */
function alternations(stem: string): string[] {
  const m = /^(.*)и(в|л|р|н|ж)$/.exec(stem)
  return m ? [stem, `${m[1]}о${m[2]}`, `${m[1]}е${m[2]}`] : [stem]
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key)
  if (list) {
    if (!list.includes(value)) list.push(value)
  } else map.set(key, [value])
}
