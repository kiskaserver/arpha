import { type LatLon, REGION_BBOX, THREAT_TYPES, type Track, ZAPORIZHZHIA } from '@arpha/shared'
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { buildFrame, circlePolygon, type Feature, fc, frameInterval, MIN_FRAME_MS } from './frame'
import { DESTROYED_SVG, iconId, iconSvg } from './icons'
import type { MotionModel } from './motion'

type MapLibre = typeof import('maplibre-gl')

const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron'

export interface MapCallbacks {
  onSelect(id: string | null): void
  onPick(point: LatLon): void
}

/**
 * Owns the MapLibre instance and the render loop. MapLibre is loaded lazily so
 * the app shell paints before ~250 KB of map code arrives.
 */
export class MapController {
  readonly #map: MapLibreMap
  readonly #lib: MapLibre
  readonly #cb: MapCallbacks
  #tracks: () => Iterable<Track> = () => []
  #motion: MotionModel | null = null
  #selected: string | null = null
  #alerted = new Set<string>()
  #observer: { point: LatLon | null; radiusKm: number } = { point: null, radiusKm: 15 }
  #picking = false
  #raf = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #lastFrame = 0
  #ready = false
  #dark: boolean

  private constructor(lib: MapLibre, map: MapLibreMap, cb: MapCallbacks, dark: boolean) {
    this.#lib = lib
    this.#map = map
    this.#cb = cb
    this.#dark = dark
  }

  static async create(
    container: HTMLElement,
    dark: boolean,
    cb: MapCallbacks,
  ): Promise<MapController> {
    const [lib, worker] = await Promise.all([
      import('maplibre-gl'),
      // v6 resolves its worker relative to import.meta.url at runtime, which bundlers can't see.
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
    lib.setWorkerUrl(new URL(worker.default, location.href).href)
    const [w, s, e, n] = REGION_BBOX
    const map = new lib.Map({
      container,
      style: dark ? STYLE_DARK : STYLE_LIGHT,
      center: [ZAPORIZHZHIA.lon, ZAPORIZHZHIA.lat - 0.4],
      zoom: 7.4,
      minZoom: 6,
      maxZoom: 14,
      maxBounds: [
        [w - 1.5, s - 1],
        [e + 1.5, n + 1],
      ],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
      // Cap the drawing buffer on very dense screens: 2× looks identical, costs half the GPU.
      pixelRatio: Math.min(globalThis.devicePixelRatio || 1, 2),
    })
    map.touchZoomRotate.disableRotation()
    const ctl = new MapController(lib, map, cb, dark)
    ctl.#wire()
    await new Promise<void>((resolve) => map.once('load', () => resolve()))
    return ctl
  }

  #wire(): void {
    const map = this.#map
    map.on('style.load', () => {
      void this.#setupLayers().then(() => {
        this.#ready = true
        this.#applyAlerts()
        this.#applyObserver()
        this.invalidate()
      })
    })
    map.on('click', (e) => {
      if (this.#picking) {
        this.#cb.onPick({ lat: e.lngLat.lat, lon: e.lngLat.lng })
        return
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['threats'] })[0]
      this.#cb.onSelect((hit?.properties?.id as string | undefined) ?? null)
    })
    map.on('mouseenter', 'threats', () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'threats', () => {
      map.getCanvas().style.cursor = this.#picking ? 'crosshair' : ''
    })
    // Speed estimate depends on zoom; re-evaluate the frame budget.
    map.on('zoomend', () => this.invalidate())
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.invalidate()
    })
  }

  async #setupLayers(): Promise<void> {
    const map = this.#map
    // style.load can fire more than once for the same style; layers survive until setStyle.
    if (map.getSource('threats')) return
    // Ukrainian labels on the basemap.
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type === 'symbol' && map.getLayoutProperty(layer.id, 'text-field')) {
        map.setLayoutProperty(layer.id, 'text-field', [
          'coalesce',
          ['get', 'name:uk'],
          ['get', 'name'],
        ])
      }
    }

    const pixelRatio = 2
    await Promise.all([
      ...THREAT_TYPES.map(async (t) => {
        if (!map.hasImage(iconId(t)))
          map.addImage(iconId(t), await rasterize(iconSvg(t)), { pixelRatio })
      }),
      (async () => {
        if (!map.hasImage('destroyed'))
          map.addImage('destroyed', await rasterize(DESTROYED_SVG), { pixelRatio })
      })(),
    ])

    const empty = fc([])
    map.addSource('boundaries', { type: 'geojson', data: '/boundaries.geojson', promoteId: 'id' })
    map.addSource('observer', { type: 'geojson', data: empty })
    map.addSource('vectors', { type: 'geojson', data: empty })
    map.addSource('targets', { type: 'geojson', data: empty })
    map.addSource('uncertainty', { type: 'geojson', data: empty })
    map.addSource('threats', { type: 'geojson', data: empty })

    const alertRed = '#ff3b30'
    map.addLayer({
      id: 'alert-fill',
      type: 'fill',
      source: 'boundaries',
      filter: ['!=', ['get', 'kind'], 'oblast'],
      paint: {
        'fill-color': alertRed,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], 0.16, 0],
      },
    })
    map.addLayer({
      id: 'alert-oblast-fill',
      type: 'fill',
      source: 'boundaries',
      filter: ['==', ['get', 'kind'], 'oblast'],
      paint: {
        'fill-color': alertRed,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], 0.1, 0],
      },
    })
    map.addLayer({
      id: 'hromada-line',
      type: 'line',
      source: 'boundaries',
      filter: ['==', ['get', 'kind'], 'hromada'],
      minzoom: 8,
      paint: {
        'line-color': this.#dark ? '#3a4a63' : '#9aa7b8',
        'line-width': 0.6,
        'line-opacity': 0.7,
      },
    })
    map.addLayer({
      id: 'oblast-line',
      type: 'line',
      source: 'boundaries',
      filter: ['==', ['get', 'kind'], 'oblast'],
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'alert'], false], alertRed, '#f5a524'],
        'line-width': 2,
      },
    })
    map.addLayer({
      id: 'observer-radius',
      type: 'fill',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'radius'],
      paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.06 },
    })
    map.addLayer({
      id: 'observer-radius-line',
      type: 'line',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'radius'],
      paint: { 'line-color': '#0a84ff', 'line-width': 1, 'line-dasharray': [2, 2] },
    })
    map.addLayer({
      id: 'observer-point',
      type: 'circle',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'point'],
      paint: {
        'circle-radius': 7,
        'circle-color': '#0a84ff',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2.5,
      },
    })
    map.addLayer({
      id: 'uncertainty',
      type: 'fill',
      source: 'uncertainty',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': this.#dark ? 0.08 : 0.2 },
    })
    map.addLayer({
      id: 'vectors',
      type: 'line',
      source: 'vectors',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2.5,
        'line-dasharray': [1.5, 1.5],
        'line-opacity': 0.9,
      },
    })
    map.addLayer({
      id: 'targets',
      type: 'circle',
      source: 'targets',
      paint: {
        'circle-radius': 28,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.15,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 3,
      },
    })
    map.addLayer({
      id: 'threats',
      type: 'symbol',
      source: 'threats',
      layout: {
        'icon-image': ['concat', 'threat-', ['get', 'type']],
        'icon-size': ['case', ['get', 'selected'], 0.62, 0.48],
        'icon-rotate': ['get', 'rotate'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['get', 'selected'], 1, 0],
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-offset': [1.4, -1.2],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'icon-opacity': ['match', ['get', 'status'], 'active', 1, 0.45],
        'text-color': '#fff',
        'text-halo-color': '#0b1220',
        'text-halo-width': 2,
      },
    })
    map.addLayer({
      id: 'destroyed',
      type: 'symbol',
      source: 'threats',
      filter: ['==', ['get', 'status'], 'destroyed'],
      layout: {
        'icon-image': 'destroyed',
        'icon-size': 0.5,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }

  bind(tracks: () => Iterable<Track>, motion: MotionModel): void {
    this.#tracks = tracks
    this.#motion = motion
    this.invalidate()
  }

  setTheme(dark: boolean): void {
    if (dark === this.#dark) return
    this.#dark = dark
    this.#ready = false
    this.#map.setStyle(dark ? STYLE_DARK : STYLE_LIGHT)
  }

  setAlerts(featureIds: Set<string>): void {
    this.#alerted = featureIds
    this.#applyAlerts()
  }

  #applyAlerts(): void {
    if (!this.#ready) return
    const src = this.#map.getSource('boundaries') as GeoJSONSource | undefined
    if (!src) return
    const apply = () => {
      this.#map.removeFeatureState({ source: 'boundaries' })
      for (const id of this.#alerted)
        this.#map.setFeatureState({ source: 'boundaries', id }, { alert: true })
    }
    if (this.#map.isSourceLoaded('boundaries')) apply()
    else this.#map.once('sourcedata', () => this.#applyAlerts())
  }

  setObserver(point: LatLon | null, radiusKm: number): void {
    this.#observer = { point, radiusKm }
    this.#applyObserver()
  }

  #applyObserver(): void {
    if (!this.#ready) return
    const { point, radiusKm } = this.#observer
    const features: Feature[] = point
      ? [
          {
            type: 'Feature',
            geometry: circlePolygon(point, radiusKm),
            properties: { kind: 'radius' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
            properties: { kind: 'point' },
          },
        ]
      : []
    ;(this.#map.getSource('observer') as GeoJSONSource).setData(fc(features))
  }

  setPicking(on: boolean): void {
    this.#picking = on
    this.#map.getCanvas().style.cursor = on ? 'crosshair' : ''
  }

  select(id: string | null, fly = true): void {
    this.#selected = id
    this.invalidate()
    if (!id || !fly || !this.#motion) return
    const pose = this.#motion.pose(id, Date.now())
    if (pose)
      this.#map.easeTo({
        center: [pose.lon, pose.lat],
        zoom: Math.max(this.#map.getZoom(), 9),
        duration: 600,
      })
  }

  flyTo(point: LatLon, zoom = 10): void {
    this.#map.easeTo({ center: [point.lon, point.lat], zoom, duration: 600 })
  }

  fitRegion(): void {
    const [w, s, e, n] = REGION_BBOX
    this.#map.fitBounds(
      [
        [w + 0.4, s + 0.4],
        [e - 0.4, n - 0.4],
      ],
      { padding: 24, duration: 600 },
    )
  }

  /** Request a frame; the loop keeps itself alive only while something moves. */
  invalidate(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame((t) => this.#frame(t))
  }

  #frame(t: number): void {
    this.#raf = 0
    if (!this.#ready || !this.#motion || document.hidden) return
    const now = Date.now()
    const frame = buildFrame({
      tracks: this.#tracks(),
      motion: this.#motion,
      now,
      selected: this.#selected,
    })
    ;(this.#map.getSource('threats') as GeoJSONSource).setData(fc(frame.points))
    ;(this.#map.getSource('vectors') as GeoJSONSource).setData(fc(frame.vectors))
    ;(this.#map.getSource('targets') as GeoJSONSource).setData(fc(frame.targets))
    ;(this.#map.getSource('uncertainty') as GeoJSONSource).setData(
      fc(
        frame.selectedPose
          ? [
              {
                type: 'Feature',
                geometry: circlePolygon(frame.selectedPose, frame.selectedPose.uncertaintyKm, 32),
                properties: {},
              },
            ]
          : [],
      ),
    )
    this.#lastFrame = t

    const blending = this.#motion.isBlending(now)
    if (!blending && frame.maxSpeed === 0) return
    const interval = blending
      ? MIN_FRAME_MS
      : frameInterval(frame.maxSpeed, this.#map.getZoom(), this.#map.getCenter().lat)
    // Exactly one pending timer, or external invalidations would multiply the loop.
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(
      () => {
        this.#timer = null
        this.invalidate()
      },
      Math.max(0, interval - (performance.now() - this.#lastFrame)),
    )
  }

  resize(): void {
    this.#map.resize()
  }

  destroy(): void {
    cancelAnimationFrame(this.#raf)
    if (this.#timer) clearTimeout(this.#timer)
    this.#map.remove()
  }

  get lib(): MapLibre {
    return this.#lib
  }
}

/** Rasterize an SVG for map.addImage (sharp on high-DPI screens). */
export async function rasterize(svg: string, size = 64, pixelRatio = 2): Promise<ImageData> {
  const img = new Image()
  img.decoding = 'async'
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const px = size * pixelRatio
  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, px, px)
  return ctx.getImageData(0, 0, px, px)
}
