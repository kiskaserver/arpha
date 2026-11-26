/**
 * Builds data/city-places.json: micro-districts, villages around the city,
 * bridges and the airport of Zaporizhzhia from OpenStreetMap (ODbL).
 * Local monitoring channels report at this granularity ("Шевчік", "Соцмісто", "мости").
 *
 *   pnpm data:city            # fetch from Overpass
 *   pnpm data:city cache.json # convert a saved Overpass response
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PlaceKind, PlaceRecord } from '../apps/server/src/geo/gazetteer'

const root = resolve(import.meta.dirname, '..')
const UA = 'arpha-build/0.1 (https://github.com/kiskaserver/arpha)'
const BBOX = '47.70,34.90,48.02,35.40'
const QUERY = `[out:json][timeout:100];(
node["place"~"suburb|neighbourhood|quarter|locality|hamlet|village"](${BBOX});
way["place"~"suburb|neighbourhood|quarter"](${BBOX});
relation["place"~"suburb|neighbourhood|quarter"](${BBOX});
node["aeroway"="aerodrome"](${BBOX});way["aeroway"="aerodrome"](${BBOX});
way["bridge"]["name"~"міст|Міст"](${BBOX});
);out center tags;`

interface Element {
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags: Record<string, string>
}

async function fetchOverpass(): Promise<{ elements: Element[] }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(QUERY)}`,
    }).catch(() => null)
    if (res?.ok) return (await res.json()) as { elements: Element[] }
    await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt))
  }
  throw new Error('Overpass unavailable')
}

function kindOf(t: Record<string, string>): { k: PlaceKind; e: number } {
  if (t.aeroway) return { k: 'landmark', e: 1.5 }
  if (t.bridge) return { k: 'landmark', e: 0.8 }
  if (t.place === 'village' || t.place === 'hamlet') return { k: 'village', e: 1.5 }
  return { k: 'district', e: 1.2 }
}

const data = process.argv[2]
  ? (JSON.parse(readFileSync(process.argv[2], 'utf8')) as { elements: Element[] })
  : await fetchOverpass()

const seen = new Map<string, PlaceRecord>()
for (const el of data.elements) {
  const t = el.tags
  const name = t['name:uk'] ?? t.name
  const pos = el.center ?? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : null)
  // Skip garden plots and "names" that are mapper notes ("Міст у дуже поганому стані").
  if (!name || !pos || /садове товариство|^None$|поганому стані|аварійн/i.test(name)) continue
  const { k, e } = kindOf(t)
  const key = `${name}|${k}`
  if (seen.has(key)) continue // bridges are split into several ways
  const aliases = [
    t['name:ru'],
    t.name !== name ? t.name : undefined,
    t.alt_name,
    t.old_name,
  ].filter((a): a is string => Boolean(a))
  const rec: PlaceRecord = {
    n: name.replace(/^Міжнародний аеропорт "Запоріжжя"$/, 'Аеропорт Запоріжжя'),
    lat: Math.round(pos.lat * 1e5) / 1e5,
    lon: Math.round(pos.lon * 1e5) / 1e5,
    k,
    r: 'ZP',
    e,
  }
  if (aliases.length) rec.a = [...new Set(aliases)]
  seen.set(key, rec)
}

const out = [...seen.values()].sort((a, b) => a.n.localeCompare(b.n, 'uk'))
writeFileSync(resolve(root, 'data/city-places.json'), `${JSON.stringify(out, null, 0)}\n`)
console.log(`Wrote ${out.length} city places → data/city-places.json`)
