import {
  type Hotspot,
  type InfraStatus,
  type LatLon,
  REGION_BBOX,
  THREAT_TYPES,
  type Track,
  ZAPORIZHZHIA,
  ZP_CITY_FEATURE_ID,
} from '@arpha/shared'
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { buildFrame, circlePolygon, type Feature, fc, frameInterval, MIN_FRAME_MS } from './frame'
import { DESTROYED_SVG, iconId, iconSvg, infraSvg } from './icons'
import { ALERT_COLORS } from './map-colors'
import type { MotionModel } from './motion'

type MapLibre = typeof import('maplibre-gl')

const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark'
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron'

export interface MapCallbacks {
  onSelect(id: string | null): void
  onPick(point: LatLon): void
}

export interface MapPoint extends LatLon {
  name: string
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
  /** featureId → alert_type. */
  #alerted = new Map<string, string>()
  /** Area alerts are on but the city itself is not under alert. */
  #cityClear = false
  #points: MapPoint[] = []
  #radiusKm = 15
  #infra: InfraStatus[] = []
  #me: (LatLon & { accuracy: number }) | null = null
  #routes: { fromLat: number; fromLon: number; toLat: number; toLon: number; count: number }[] = []
  #hotspots: Hotspot[] | null = null
  #lingerMin = 2
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
      maxZoom: 15,
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
        this.#applyPoints()
        this.#applyInfra()
        this.#applyHotspots()
        this.#applyMe()
        this.#applyRoutes()
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
    // Ukrainian, legible basemap labels: one language, solid halo (people complained the
    // labels "doubled" and were hard to read).
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type === 'symbol' && map.getLayoutProperty(layer.id, 'text-field')) {
        map.setLayoutProperty(layer.id, 'text-field', [
          'coalesce',
          ['get', 'name:uk'],
          ['get', 'name'],
        ])
        map.setPaintProperty(layer.id, 'text-halo-width', 1.6)
        map.setPaintProperty(layer.id, 'text-halo-color', this.#dark ? '#0b1220' : '#ffffff')
      }
    }

    const pixelRatio = 2
    const images: [string, string][] = [
      ...THREAT_TYPES.map((t) => [iconId(t), iconSvg(t)] as [string, string]),
      ['destroyed', DESTROYED_SVG],
      ['infra-closed', infraSvg('closed')],
      ['infra-open', infraSvg('open')],
    ]
    await Promise.all(
      images.map(async ([id, svg]) => {
        if (!map.hasImage(id)) map.addImage(id, await rasterize(svg), { pixelRatio })
      }),
    )

    const empty = fc([])
    map.addSource('boundaries', { type: 'geojson', data: '/boundaries.geojson', promoteId: 'id' })
    for (const id of [
      'observer',
      'routes',
      'hotspots',
      'cones',
      'impacts',
      'trails',
      'trail-points',
      'vectors',
      'targets',
      'uncertainty',
      'predicted',
      'infra',
      'me',
      'threats',
    ]) {
      map.addSource(id, { type: 'geojson', data: empty })
    }

    const alertColor = [
      'match',
      ['feature-state', 'alert'],
      ...Object.entries(ALERT_COLORS).flat(),
      '#ff3b30',
    ] as unknown as ExpressionSpecification
    const alerted: ExpressionSpecification = ['to-boolean', ['feature-state', 'alert']]
    map.addLayer({
      id: 'alert-fill',
      type: 'fill',
      source: 'boundaries',
      filter: ['!=', ['get', 'kind'], 'oblast'],
      paint: { 'fill-color': alertColor, 'fill-opacity': ['case', alerted, 0.16, 0] },
    })
    map.addLayer({
      id: 'alert-oblast-fill',
      type: 'fill',
      source: 'boundaries',
      filter: ['==', ['get', 'kind'], 'oblast'],
      paint: { 'fill-color': alertColor, 'fill-opacity': ['case', alerted, 0.1, 0] },
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
      paint: { 'line-color': ['case', alerted, alertColor, '#f5a524'], 'line-width': 2 },
    })
    // Zaporizhzhia is announced separately from its raion: show it clearly.
    const cityFilter: ExpressionSpecification = ['==', ['get', 'id'], ZP_CITY_FEATURE_ID]
    const cityClear: ExpressionSpecification = ['to-boolean', ['feature-state', 'cityClear']]
    map.addLayer({
      id: 'city-clear',
      type: 'fill',
      source: 'boundaries',
      filter: cityFilter,
      paint: { 'fill-color': '#30d158', 'fill-opacity': ['case', cityClear, 0.22, 0] },
    })
    map.addLayer({
      id: 'city-line',
      type: 'line',
      source: 'boundaries',
      filter: cityFilter,
      paint: {
        'line-color': [
          'case',
          cityClear,
          '#30d158',
          alerted,
          alertColor,
          this.#dark ? '#c7d2e3' : '#475569',
        ],
        'line-width': ['case', cityClear, 3, 2],
      },
    })
    map.addLayer({
      id: 'routes',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': '#bf5af2',
        'line-width': ['interpolate', ['linear'], ['get', 'count'], 1, 1.5, 20, 7],
        'line-opacity': 0.55,
      },
    })
    map.addLayer({
      id: 'hotspots',
      type: 'heatmap',
      source: 'hotspots',
      maxzoom: 13,
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'count'], 1, 0.2, 30, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 14, 12, 40],
        'heatmap-opacity': 0.55,
      },
    })
    map.addLayer({
      id: 'observer-radius',
      type: 'fill',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'radius'],
      paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.05 },
    })
    map.addLayer({
      id: 'observer-radius-line',
      type: 'line',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'radius'],
      paint: { 'line-color': '#0a84ff', 'line-width': 1, 'line-dasharray': [2, 2] },
    })
    map.addLayer({
      id: 'cones',
      type: 'fill',
      source: 'cones',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['case', ['get', 'selected'], 0.2, 0.08],
      },
    })
    map.addLayer({
      id: 'impacts',
      type: 'fill',
      source: 'impacts',
      paint: { 'fill-color': '#ff3b30', 'fill-opacity': ['case', ['get', 'selected'], 0.28, 0.14] },
    })
    map.addLayer({
      id: 'impacts-line',
      type: 'line',
      source: 'impacts',
      paint: { 'line-color': '#ff3b30', 'line-width': 1.5, 'line-dasharray': [1, 1] },
    })
    map.addLayer({
      id: 'uncertainty',
      type: 'fill',
      source: 'uncertainty',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': this.#dark ? 0.08 : 0.2 },
    })
    map.addLayer({
      id: 'trails',
      type: 'line',
      source: 'trails',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['get', 'selected'], 3, 1.5],
        'line-opacity': ['case', ['get', 'selected'], 0.85, 0.45],
      },
    })
    map.addLayer({
      id: 'trail-points',
      type: 'circle',
      source: 'trail-points',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 4, 2.5],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['case', ['get', 'selected'], 0.95, 0.5],
        'circle-stroke-color': this.#dark ? '#0b1220' : '#fff',
        'circle-stroke-width': 1,
      },
    })
    map.addLayer({
      id: 'trail-labels',
      type: 'symbol',
      source: 'trail-points',
      filter: ['!=', ['get', 'label'], ''],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-optional': true,
        'symbol-sort-key': ['get', 'order'],
      },
      paint: {
        'text-color': this.#dark ? '#d8dee9' : '#333',
        'text-halo-color': this.#dark ? '#0b1220' : '#fff',
        'text-halo-width': 1.5,
      },
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
      id: 'predicted',
      type: 'circle',
      source: 'predicted',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'p'], 0, 5, 1, 11],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2.5,
      },
    })
    map.addLayer({
      id: 'predicted-label',
      type: 'symbol',
      source: 'predicted',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-offset': [0, 1.4],
        // Zoomed out, "Запоріжжя" and "Центр міста" collide: show the likelier one.
        'text-allow-overlap': false,
        'symbol-sort-key': ['-', 1, ['get', 'p']],
      },
      paint: {
        'text-color': this.#dark ? '#fff' : '#111',
        'text-halo-color': this.#dark ? '#0b1220' : '#fff',
        'text-halo-width': 2,
      },
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
      id: 'observer-label',
      type: 'symbol',
      source: 'observer',
      filter: ['==', ['get', 'kind'], 'point'],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 12,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
      },
      paint: { 'text-color': '#0a84ff', 'text-halo-color': '#fff', 'text-halo-width': 2 },
    })
    map.addLayer({
      id: 'me-accuracy',
      type: 'fill',
      source: 'me',
      filter: ['==', ['get', 'kind'], 'accuracy'],
      paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.12 },
    })
    map.addLayer({
      id: 'me-halo',
      type: 'circle',
      source: 'me',
      filter: ['==', ['get', 'kind'], 'me'],
      paint: { 'circle-radius': 16, 'circle-color': '#0a84ff', 'circle-opacity': 0.25 },
    })
    map.addLayer({
      id: 'me-dot',
      type: 'circle',
      source: 'me',
      filter: ['==', ['get', 'kind'], 'me'],
      paint: {
        'circle-radius': 8,
        'circle-color': '#0a84ff',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 3,
      },
    })
    map.addLayer({
      id: 'infra',
      type: 'symbol',
      source: 'infra',
      layout: {
        'icon-image': ['concat', 'infra-', ['get', 'status']],
        'icon-size': 0.45,
        'icon-allow-overlap': true,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': ['match', ['get', 'status'], 'closed', '#ff3b30', '#30d158'],
        'text-halo-color': this.#dark ? '#0b1220' : '#fff',
        'text-halo-width': 2,
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

  /** featureId → alert_type. */
  setAlerts(alerted: Map<string, string>, cityClear = false): void {
    this.#alerted = alerted
    this.#cityClear = cityClear
    this.#applyAlerts()
  }

  #applyAlerts(): void {
    if (!this.#ready || !this.#map.getSource('boundaries')) return
    const apply = () => {
      this.#map.removeFeatureState({ source: 'boundaries' })
      for (const [id, type] of this.#alerted) {
        this.#map.setFeatureState({ source: 'boundaries', id }, { alert: type })
      }
      this.#map.setFeatureState(
        { source: 'boundaries', id: ZP_CITY_FEATURE_ID },
        { cityClear: this.#cityClear },
      )
    }
    if (this.#map.isSourceLoaded('boundaries')) apply()
    else this.#map.once('sourcedata', () => this.#applyAlerts())
  }

  setPoints(points: MapPoint[], radiusKm: number): void {
    this.#points = points
    this.#radiusKm = radiusKm
    this.#applyPoints()
  }

  #applyPoints(): void {
    if (!this.#ready) return
    const features: Feature[] = this.#points.flatMap((p) => [
      {
        type: 'Feature',
        geometry: circlePolygon(p, this.#radiusKm),
        properties: { kind: 'radius' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { kind: 'point', name: p.name },
      },
    ])
    ;(this.#map.getSource('observer') as GeoJSONSource).setData(fc(features))
  }

  setInfra(items: InfraStatus[]): void {
    this.#infra = items
    this.#applyInfra()
  }

  #applyInfra(): void {
    if (!this.#ready) return
    const features: Feature[] = this.#infra.map((i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [i.lon, i.lat] },
      properties: {
        status: i.status,
        label: `${i.name}: ${i.status === 'closed' ? 'перекрито' : 'відкрито'}`,
      },
    }))
    ;(this.#map.getSource('infra') as GeoJSONSource).setData(fc(features))
  }

  /** null hides the layer. */
  setHotspots(data: Hotspot[] | null): void {
    this.#hotspots = data
    this.#applyHotspots()
  }

  #applyHotspots(): void {
    if (!this.#ready) return
    const features: Feature[] = (this.#hotspots ?? []).map((h) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
      properties: { count: h.count },
    }))
    ;(this.#map.getSource('hotspots') as GeoJSONSource).setData(fc(features))
  }

  /** The user's live GPS position (null when not shared). */
  setMe(me: (LatLon & { accuracy: number }) | null): void {
    this.#me = me
    this.#applyMe()
  }

  #applyMe(): void {
    if (!this.#ready) return
    const me = this.#me
    const features: Feature[] = me
      ? [
          {
            type: 'Feature',
            geometry: circlePolygon(me, Math.min(Math.max(me.accuracy / 1000, 0.02), 5), 32),
            properties: { kind: 'accuracy' },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [me.lon, me.lat] },
            properties: { kind: 'me' },
          },
        ]
      : []
    ;(this.#map.getSource('me') as GeoJSONSource).setData(fc(features))
  }

  /** Learned corridors (empty array hides them). */
  setRoutes(
    routes: { fromLat: number; fromLon: number; toLat: number; toLon: number; count: number }[],
  ): void {
    this.#routes = routes
    this.#applyRoutes()
  }

  #applyRoutes(): void {
    if (!this.#ready) return
    const features: Feature[] = this.#routes.map((r) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [r.fromLon, r.fromLat],
          [r.toLon, r.toLat],
        ],
      },
      properties: { count: r.count },
    }))
    ;(this.#map.getSource('routes') as GeoJSONSource).setData(fc(features))
  }

  setLinger(min: number): void {
    this.#lingerMin = min
    this.invalidate()
  }

  setPicking(on: boolean): void {
    this.#picking = on
    this.#map.getCanvas().style.cursor = on ? 'crosshair' : ''
  }

  select(id: string | null, fly = true): void {
    this.#selected = id
    this.invalidate()
    if (!id || !fly || !this.#motion) return
    const pose = this.#motion.pose(id)
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
    this.#motion.advance(now)
    const frame = buildFrame({
      tracks: this.#tracks(),
      motion: this.#motion,
      now,
      selected: this.#selected,
      lingerMin: this.#lingerMin,
    })
    const set = (id: string, features: Feature[]) =>
      (this.#map.getSource(id) as GeoJSONSource).setData(fc(features))
    set('threats', frame.points)
    set('vectors', frame.vectors)
    set('targets', frame.targets)
    set('cones', frame.cones)
    set('impacts', frame.impacts)
    set('predicted', frame.predicted)
    set('trails', frame.trails)
    set('trail-points', frame.trailPoints)
    set(
      'uncertainty',
      frame.selectedPose
        ? [
            {
              type: 'Feature',
              geometry: circlePolygon(frame.selectedPose, frame.selectedPose.uncertaintyKm, 32),
              properties: {},
            },
          ]
        : [],
    )
    this.#lastFrame = t

    const settling = this.#motion.isSettling()
    if (!settling && frame.maxSpeed === 0) return
    const interval = settling
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
