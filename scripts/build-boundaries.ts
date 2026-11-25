/**
 * Builds apps/web/public/boundaries.geojson: Zaporizhzhia oblast, its 5 raions
 * and 67 hromadas from OpenStreetMap (ODbL). Geometry is simplified by
 * Nominatim and rounded to ~10 m, which keeps the file small enough for phones.
 *
 *   pnpm data:boundaries
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const UA = 'arpha-build/0.1 (https://github.com/kiskaserver/arpha)'
const OBLAST_RELATION = 71980
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

type Kind = 'oblast' | 'raion' | 'hromada'
interface Rel {
  id: number
  name: string
  kind: Kind
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function overpass(
  query: string,
): Promise<{ elements: { id: number; tags: Record<string, string> }[] }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(120_000),
        })
        if (res.ok) return (await res.json()) as never
        console.warn(`${url}: HTTP ${res.status}`)
      } catch (err) {
        console.warn(`${url}: ${(err as Error).message}`)
      }
    }
    await sleep(2000 * 2 ** attempt)
  }
  throw new Error('All Overpass endpoints failed')
}

const roundCoords = (c: unknown): unknown =>
  Array.isArray(c) && typeof c[0] === 'number'
    ? [Math.round((c[0] as number) * 1e4) / 1e4, Math.round((c[1] as number) * 1e4) / 1e4]
    : (c as unknown[]).map(roundCoords)

async function geometries(ids: number[], threshold: number) {
  const out = new Map<number, { type: string; coordinates: unknown }>()
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const url = `https://nominatim.openstreetmap.org/lookup?osm_ids=${batch.map((id) => `R${id}`).join(',')}&format=jsonv2&polygon_geojson=1&polygon_threshold=${threshold}`
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`)
    const items = (await res.json()) as {
      osm_id: number
      geojson: { type: string; coordinates: unknown }
    }[]
    for (const it of items) {
      if (it.geojson.type === 'Polygon' || it.geojson.type === 'MultiPolygon') {
        out.set(it.osm_id, {
          type: it.geojson.type,
          coordinates: roundCoords(it.geojson.coordinates),
        })
      }
    }
    await sleep(1100) // Nominatim usage policy: ≤ 1 req/s
  }
  return out
}

console.log('Listing raions and hromadas via Overpass …')
const data = await overpass(
  `[out:json][timeout:90];area(${3600000000 + OBLAST_RELATION})->.a;rel(area.a)["boundary"="administrative"]["admin_level"~"^(6|7)$"];out tags;`,
)
const rels: Rel[] = [
  { id: OBLAST_RELATION, name: 'Запорізька область', kind: 'oblast' },
  ...data.elements
    .filter((e) => e.tags.name)
    .map((e) => ({
      id: e.id,
      name: e.tags['name:uk'] ?? e.tags.name!,
      kind: (e.tags.admin_level === '6' ? 'raion' : 'hromada') as Kind,
    })),
]
console.log(`Found ${rels.length - 1} subdivisions, fetching simplified polygons …`)

const geoms = await geometries(
  rels.map((r) => r.id),
  0.002,
)
const features = rels
  .filter((r) => geoms.has(r.id))
  .map((r) => ({
    type: 'Feature',
    id: `r${r.id}`,
    properties: { id: `r${r.id}`, name: r.name, kind: r.kind },
    geometry: geoms.get(r.id),
  }))

const out = resolve(root, 'apps/web/public/boundaries.geojson')
writeFileSync(out, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`)
const size = Math.round(JSON.stringify(features).length / 1024)
console.log(`Wrote ${features.length} features (${size} KB) → ${out}`)
