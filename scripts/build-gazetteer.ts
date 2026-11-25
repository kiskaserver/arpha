/**
 * Builds data/gazetteer.json from the GeoNames Ukraine dump + curated landmarks.
 * GeoNames data is CC BY 4.0 (https://www.geonames.org).
 *
 *   pnpm data:gazetteer
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { unzipSync } from 'fflate'
import type { PlaceRecord } from '../apps/server/src/geo/gazetteer'
import { mergeRecords, parseGeoNames } from '../apps/server/src/geo/geonames'

const root = resolve(import.meta.dirname, '..')
const url = 'https://download.geonames.org/export/dump/UA.zip'

console.log(`Downloading ${url} …`)
const res = await fetch(url)
if (!res.ok) throw new Error(`GeoNames download failed: ${res.status}`)
const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
const tsv = new TextDecoder().decode(files['UA.txt'])

const generated = parseGeoNames(tsv)
const curated = JSON.parse(
  readFileSync(resolve(root, 'data/landmarks.json'), 'utf8'),
) as PlaceRecord[]
const merged = mergeRecords(curated, generated)

writeFileSync(resolve(root, 'data/gazetteer.json'), `${JSON.stringify(merged)}\n`)
const zp = merged.filter((r) => r.r === 'ZP').length
console.log(`Wrote ${merged.length} places (${zp} in Zaporizhzhia oblast) → data/gazetteer.json`)
