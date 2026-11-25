import { jaroWinkler } from '../text/normalize'
import type { PlaceKind, PlaceRecord } from './gazetteer'

/** GeoNames admin1 codes for Ukraine → our region codes. */
export const ADMIN1_REGION: Record<string, string> = {
  '26': 'ZP', // Zaporizhzhia
  '04': 'DP', // Dnipropetrovsk
  '05': 'DN', // Donetsk
  '08': 'KS', // Kherson
  '11': 'CR', // Crimea
}

/** [west, south, east, north] — neighbours are kept only inside this box. */
export const NEIGHBOUR_BBOX: [number, number, number, number] = [33.3, 45.8, 38.0, 48.8]

const CYRILLIC = /^[\p{Script=Cyrillic}\s'’ʼ.-]+$/u
const UKRAINIAN_ONLY = /[іїєґІЇЄҐ’ʼ']/

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'yu',
  я: 'ya',
  ы: 'y',
  э: 'e',
  ё: 'e',
  ъ: '',
  "'": '',
  '’': '',
  ʼ: '',
  '-': '-',
  ' ': ' ',
}

/** Ukrainian national romanization (the system GeoNames' ascii names follow). */
export function transliterateUk(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) out += TRANSLIT[ch] ?? ch
  return out
}

/**
 * GeoNames alternate names carry no language tags in the country dump, and
 * many are historic (Soviet) or Russian. The ascii name is the official
 * Ukrainian romanization, so the Cyrillic alternate whose transliteration is
 * closest to it is the current Ukrainian name.
 */
export function pickUkrainianName(ascii: string, alternates: string[]): string {
  const target = ascii.toLowerCase().replace(/['’]/g, '')
  let best: string | null = null
  let bestScore = -1
  for (const alt of alternates) {
    if (!CYRILLIC.test(alt)) continue
    let score = jaroWinkler(transliterateUk(alt), target)
    if (UKRAINIAN_ONLY.test(alt)) score += 0.03
    if (alt.includes('ь')) score += 0.01 // Бердянськ beats Бердянск on a transliteration tie
    if (score > bestScore) {
      bestScore = score
      best = alt
    }
  }
  return best ?? ascii
}

function kindFor(featureCode: string, population: number): PlaceKind {
  if (featureCode === 'PPLA' || featureCode === 'PPLC' || population >= 100_000) return 'city'
  if (featureCode === 'PPLA2' || featureCode === 'PPLA3' || population >= 5_000) return 'town'
  if (featureCode === 'PPLX') return 'district'
  return 'village'
}

/**
 * Converts a GeoNames country dump (tab-separated, see
 * https://download.geonames.org/export/dump/readme.txt) to gazetteer records.
 * Keeps every populated place of Zaporizhzhia oblast and notable places of
 * neighbouring regions that threats commonly fly through.
 */
export function parseGeoNames(tsv: string): PlaceRecord[] {
  const out: PlaceRecord[] = []
  for (const line of tsv.split('\n')) {
    const f = line.split('\t')
    if (f.length < 15 || f[6] !== 'P') continue
    const region = ADMIN1_REGION[f[10]!]
    if (!region) continue
    const lat = Number(f[4])
    const lon = Number(f[5])
    const population = Number(f[14]) || 0
    const code = f[7]!
    if (region !== 'ZP') {
      const [w, s, e, n] = NEIGHBOUR_BBOX
      if (lon < w || lon > e || lat < s || lat > n) continue
      if (population < 1000 && !code.startsWith('PPLA')) continue
    }
    const alternates = (f[3] ?? '').split(',').filter(Boolean)
    const name = pickUkrainianName(f[2]!, alternates)
    const aliases = [
      ...new Set(
        [f[1]!, f[2]!, ...alternates.filter((a) => CYRILLIC.test(a))].filter((a) => a !== name),
      ),
    ]
    const rec: PlaceRecord = {
      n: name,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      k: kindFor(code, population),
      r: region,
    }
    if (aliases.length) rec.a = aliases
    if (population) rec.p = population
    out.push(rec)
  }
  return out
}

/** Curated landmarks win over GeoNames duplicates of the same name. */
export function mergeRecords(curated: PlaceRecord[], generated: PlaceRecord[]): PlaceRecord[] {
  const curatedNames = new Set(curated.map((c) => `${c.n}|${c.r ?? ''}`))
  const generatedFiltered = generated.filter((g) => !curatedNames.has(`${g.n}|${g.r ?? ''}`))
  return [...curated, ...generatedFiltered].sort((a, b) => a.n.localeCompare(b.n, 'uk'))
}
