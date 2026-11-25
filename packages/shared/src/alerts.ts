import type { ActiveAlert } from './model'

/** Boundary polygon ids (apps/web/public/boundaries.geojson, OSM relation ids). */
export const OBLAST_FEATURE_ID = 'r71980'
/** "Запорізька міська громада" — the city has its own alerts, independent of the raion. */
export const ZP_CITY_FEATURE_ID = 'r12152861'

/**
 * Does an alert apply to an area (the polygons containing a point)?
 * Zaporizhzhia city is announced separately: an alert for Запорізький район
 * does not mean the city is under alert. Only a city/hromada alert or an
 * oblast-wide one covers it.
 */
export function alertCovers(
  alert: Pick<ActiveAlert, 'featureIds' | 'locationType'>,
  areaFeatureIds: string[],
): boolean {
  if (areaFeatureIds.includes(ZP_CITY_FEATURE_ID)) {
    return alert.featureIds.includes(ZP_CITY_FEATURE_ID) || alert.locationType === 'oblast'
  }
  return alert.featureIds.some((id) => areaFeatureIds.includes(id))
}

/** Is the city itself under alert right now? */
export function cityUnderAlert(
  alerts: Pick<ActiveAlert, 'featureIds' | 'locationType'>[],
): boolean {
  return alerts.some((a) => alertCovers(a, [ZP_CITY_FEATURE_ID]))
}
