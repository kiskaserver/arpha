import { readFileSync } from 'node:fs'
import { type ActiveAlert, type LatLon, pointInGeometry } from '@arpha/shared'
import { foldName } from '../text/normalize'

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

export interface BoundaryFeature {
  id: string
  name: string
  kind: 'oblast' | 'raion' | 'hromada'
  geometry: Geometry
}

interface FeatureCollection {
  features: {
    properties: { id: string; name: string; kind: BoundaryFeature['kind'] }
    geometry: Geometry
  }[]
}

const words = (s: string) =>
  foldName(s)
    .split(/[\s,]+/)
    .filter(Boolean)

/**
 * OSM boundaries ↔ alerts.in.ua locations. Names differ ("Вільнянська міська
 * громада" vs "Вільнянська територіальна громада", "м. Запоріжжя та Запорізька
 * територіальна громада"), so we match on the distinctive adjective.
 */
export class Boundaries {
  readonly features: BoundaryFeature[]

  constructor(fc: FeatureCollection) {
    this.features = fc.features.map((f) => ({ ...f.properties, geometry: f.geometry }))
  }

  static load(path: string): Boundaries {
    return new Boundaries(JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection)
  }

  static empty(): Boundaries {
    return new Boundaries({ features: [] })
  }

  match(alert: Pick<ActiveAlert, 'locationTitle' | 'locationType'>): string[] {
    if (alert.locationType === 'oblast') {
      return this.features.filter((f) => f.kind === 'oblast').map((f) => f.id)
    }
    const kind = alert.locationType === 'raion' ? 'raion' : 'hromada'
    const titleWords = new Set(words(alert.locationTitle))
    return this.features
      .filter((f) => f.kind === kind && titleWords.has(words(f.name)[0] ?? ''))
      .map((f) => f.id)
  }

  /** Features containing a point, most specific first. */
  containing(p: LatLon): BoundaryFeature[] {
    const order = { hromada: 0, raion: 1, oblast: 2 }
    return this.features
      .filter((f) => pointInGeometry(p, f.geometry))
      .sort((a, b) => order[a.kind] - order[b.kind])
  }
}
