<script lang="ts">
import { type ActiveAlert, cityUnderAlert, pointInGeometry } from '@arpha/shared'
import { onMount } from 'svelte'
import LegendSheet from './components/LegendSheet.svelte'
import SettingsSheet from './components/SettingsSheet.svelte'
import ThreatPanel from './components/ThreatPanel.svelte'
import TopBar from './components/TopBar.svelte'
import { isVisible } from './lib/frame'
import { uk } from './lib/i18n'
import type { MapController } from './lib/map'
import { MotionModel } from './lib/motion'
import { type InAppAlert, Notifier } from './lib/notify'
import { disablePush, enablePush, pushSupported } from './lib/push'
import {
  applyTheme,
  loadSettings,
  newPointId,
  prefersDark,
  type Settings,
  type SoundCategory,
  saveSettings,
  zoneOf,
} from './lib/settings'
import { playSound, speak, unlockAudio, vibrate } from './lib/sound'
import { applyEvent, initialState } from './lib/state'
import { type ConnectionStatus, LiveStream } from './lib/stream'
import { alertedFeatures, alertLevel, threatRows } from './lib/view'

type Geometry = Parameters<typeof pointInGeometry>[1]

const live = initialState()
const motion = new MotionModel()

let version = $state(0)
let now = $state(Date.now())
let status = $state<ConnectionStatus>('connecting')
let settings = $state<Settings>(loadSettings())
let selected = $state<string | null>(new URLSearchParams(location.search).get('track'))
let showSettings = $state(false)
let showLegend = $state(false)
let picking = $state(false)
let pushMessage = $state<string | null>(null)
let mapState = $state<'loading' | 'ready' | 'failed'>('loading')
let installPrompt = $state<(Event & { prompt(): Promise<void> }) | null>(null)
let myFeatureIds = $state<string[]>([])
let toast = $state<InAppAlert | null>(null)
/** Live GPS position, only while the user shares it. */
let me = $state<{ lat: number; lon: number; accuracy: number } | null>(null)
let watchId: number | null = null
let showRoutes = $state(false)
let flashing = $state<SoundCategory | null>(null)
let mapEl: HTMLDivElement
let map: MapController | null = null
let boundaries: { features: { properties: { id: string }; geometry: Geometry }[] } | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined

const serverNow = () => Date.now() + live.clockOffset
const applyAlertsToMap = () =>
  map?.setAlerts(
    alertedFeatures(live.alerts),
    live.alerts.alerts.length > 0 && !cityUnderAlert(live.alerts.alerts),
  )

const notifier = new Notifier({
  sound: (c) => playSound(settings.sounds[c]),
  vibrate,
  speak,
  flash: (c) => {
    flashing = c
    setTimeout(() => (flashing = null), 4000)
  },
  show: (a) => {
    toast = a
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast = null), 8000)
  },
})

/** Places to protect: saved points, or the live GPS position when none are saved. */
const watched = $derived(
  settings.points.length ? settings.points : me ? [{ id: 'me', name: uk.meName, lat: me.lat, lon: me.lon }] : [],
)
const rows = $derived.by(() => {
  void version
  const visible = [...live.tracks.values()].filter((t) => isVisible(t, now, settings.lingerMin))
  const ref = watched[0] ?? null
  return threatRows(visible, ref, now, zoneOf(ref, settings))
})
const alerts = $derived.by(() => {
  void version
  return live.alerts
})
const feed = $derived.by(() => {
  void version
  return live.feed
})
const demo = $derived.by(() => {
  void version
  return live.demo
})
const level = $derived(alertLevel(alerts, myFeatureIds))
const cityClear = $derived(alerts.alerts.length > 0 && !cityUnderAlert(alerts.alerts))

function onStreamEvent(ev: Parameters<typeof applyEvent>[1]) {
  const prevAlerts: ActiveAlert[] = live.alerts.alerts
  const initial = ev.type === 'snapshot'
  applyEvent(live, ev, Date.now())
  const t = serverNow()
  if (ev.type === 'snapshot') {
    motion.retain(new Set(live.tracks.keys()))
    for (const track of live.tracks.values()) motion.upsert(track, t)
  } else if (ev.type === 'track') {
    motion.upsert(ev.track, t)
    notifier.track(ev.track, watched, settings, t)
  } else if (ev.type === 'track_removed') {
    motion.remove(ev.id)
    if (selected === ev.id) selected = null
  }
  if (ev.type === 'alerts' || initial) {
    applyAlertsToMap()
    // The first snapshot is the current state, not news.
    if (!initial) notifier.alerts(prevAlerts, live.alerts.alerts, myFeatureIds, settings, t)
  }
  if (ev.type === 'infra' || initial) map?.setInfra(live.infra)
  version++
  map?.invalidate()
}

function persist() {
  saveSettings($state.snapshot(settings))
}

function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  persist()
  if ('theme' in patch) {
    applyTheme(settings.theme)
    map?.setTheme(prefersDark(settings.theme))
  }
  if ('points' in patch || 'radiusKm' in patch) {
    map?.setPoints(settings.points, settings.radiusKm)
    refreshMyAreas()
  }
  if ('lingerMin' in patch) map?.setLinger(settings.lingerMin)
  if ('showTrails' in patch) map?.setShowTrails(settings.showTrails)
  if ('hotspots' in patch) void refreshHotspots()
  const pushRelevant = ['points', 'radiusKm', 'pushAlerts', 'pushThreats', 'classes']
  if (settings.pushEnabled && pushRelevant.some((k) => k in patch)) void togglePush(true)
}

/** Which polygons contain my points — decides "тривога у вашій громаді". */
async function refreshMyAreas() {
  const areas = settings.points.length ? settings.points : me ? [me] : []
  if (!areas.length) {
    myFeatureIds = []
    return
  }
  try {
    boundaries ??= await (await fetch('/boundaries.geojson')).json()
    const ids = new Set<string>()
    for (const f of boundaries!.features) {
      if (areas.some((p) => pointInGeometry(p, f.geometry))) ids.add(f.properties.id)
    }
    myFeatureIds = [...ids]
  } catch {
    myFeatureIds = []
  }
}

async function refreshHotspots() {
  if (!settings.hotspots) {
    map?.setHotspots(null)
    return
  }
  try {
    map?.setHotspots(await (await fetch('/api/hotspots?days=30')).json())
  } catch {
    map?.setHotspots(null)
  }
}

function addPoint(at: { lat: number; lon: number }) {
  const name = uk.pointNameDefault(settings.points.length)
  updateSettings({ points: [...settings.points, { id: newPointId(), name, ...at }].slice(0, 5) })
}

function addByGps() {
  if (!('geolocation' in navigator)) {
    pushMessage = uk.gpsFailed
    return
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const point = { lat: pos.coords.latitude, lon: pos.coords.longitude }
      addPoint(point)
      map?.flyTo(point, 11)
    },
    (err) => {
      pushMessage = err.code === err.PERMISSION_DENIED ? uk.gpsDenied : uk.gpsFailed
    },
    { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
  )
}

/** Follow the user's position (battery-friendly: network/coarse fixes are fine). */
function watchMe(fly = false) {
  if (!('geolocation' in navigator)) {
    pushMessage = uk.gpsFailed
    return
  }
  if (watchId !== null) {
    if (fly && me) map?.flyTo(me, 12)
    return
  }
  let first = true
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }
      map?.setMe(me)
      if (first && fly) map?.flyTo(me, 12)
      first = false
      if (!settings.points.length) void refreshMyAreas()
    },
    (err) => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId)
      watchId = null
      me = null
      map?.setMe(null)
      pushMessage = err.code === err.PERMISSION_DENIED ? uk.gpsDenied : uk.gpsFailed
    },
    { enableHighAccuracy: false, maximumAge: 30_000, timeout: 30_000 },
  )
}

function startPicking() {
  showSettings = false
  picking = true
  map?.setPicking(true)
}

async function togglePush(on: boolean) {
  pushMessage = null
  if (!on) {
    await disablePush()
    updateSettings({ pushEnabled: false })
    return
  }
  const res = await enablePush({
    points: settings.points.map(({ name, lat, lon, radiusKm }) =>
      radiusKm ? { name, lat, lon, radiusKm } : { name, lat, lon },
    ),
    radiusKm: settings.radiusKm,
    alerts: settings.pushAlerts,
    threats: settings.pushThreats,
    classes: settings.classes,
  })
  if (res.ok) {
    if (!settings.pushEnabled) {
      settings = { ...settings, pushEnabled: true }
      persist()
    }
    pushMessage = uk.pushOn
  } else {
    pushMessage = {
      unsupported: uk.pushUnsupported,
      denied: uk.pushDenied,
      unavailable: uk.pushUnavailable,
      subscribe: res.standalone
        ? `${uk.pushSubscribeFailed(res.detail)} ${uk.pushStandaloneHelp}`
        : uk.pushSubscribeFailed(res.detail),
      server: uk.pushServerFailed(res.detail),
      failed: uk.pushFailed(res.detail),
    }[res.reason]
  }
}

function testSound(c: SoundCategory) {
  unlockAudio()
  playSound(settings.sounds[c])
  if (settings.vibrate) vibrate([200, 100, 200])
}

function select(id: string | null) {
  selected = id
  map?.select(id)
  const url = new URL(location.href)
  if (id) url.searchParams.set('track', id)
  else url.searchParams.delete('track')
  history.replaceState(null, '', url)
}

function selectFromToast() {
  const id = toast?.key.startsWith('track-') ? toast.key.slice(6) : null
  toast = null
  if (id) select(id)
}

onMount(() => {
  applyTheme(settings.theme)
  void refreshMyAreas()
  // If location access was granted before, show "you are here" right away.
  navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((st) => {
      if (st.state === 'granted') watchMe()
      st.onchange = () => (st.state === 'granted' ? watchMe() : null)
    })
    .catch(() => {})
  // Browsers only allow sound after a user gesture.
  addEventListener('pointerdown', unlockAudio, { once: true })

  const stream = new LiveStream({ onEvent: onStreamEvent, onStatus: (s) => (status = s) })
  stream.start()

  // A 1 s clock for "N хв тому"/ETA labels; paused in background tabs.
  const tick = setInterval(() => {
    if (!document.hidden) now = serverNow()
  }, 1000)
  const onVisible = () => {
    if (!document.hidden) {
      now = serverNow()
      if (status !== 'online') stream.reconnect()
    }
  }
  document.addEventListener('visibilitychange', onVisible)

  const media = matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => settings.theme === 'auto' && map?.setTheme(media.matches)
  media.addEventListener('change', onScheme)

  // Keep the event for our "Встановити" button, but don't suppress the browser's own
  // install UI (preventDefault without prompt() only earns a console warning).
  const onInstall = (e: Event) => {
    installPrompt = e as Event & { prompt(): Promise<void> }
  }
  addEventListener('beforeinstallprompt', onInstall)

  let destroyed = false
  import('./lib/map')
    .then(({ MapController }) =>
      MapController.create(mapEl, prefersDark(settings.theme), {
        onSelect: select,
        onPick: (point) => {
          picking = false
          map?.setPicking(false)
          addPoint(point)
        },
      }),
    )
    .then((ctl) => {
      if (destroyed) return ctl.destroy()
      map = ctl
      map.bind(() => live.tracks.values(), motion)
      applyAlertsToMap()
      map.setPoints(settings.points, settings.radiusKm)
      map.setInfra(live.infra)
      map.setLinger(settings.lingerMin)
      map.setShowTrails(settings.showTrails)
      map.setMe(me)
      // The user may have started picking a point before the map finished loading.
      map.setPicking(picking)
      void refreshHotspots()
      if (selected) map.select(selected)
      mapState = 'ready'
    })
    .catch(() => {
      mapState = 'failed'
    })

  return () => {
    destroyed = true
    stream.stop()
    clearInterval(tick)
    document.removeEventListener('visibilitychange', onVisible)
    media.removeEventListener('change', onScheme)
    removeEventListener('beforeinstallprompt', onInstall)
    if (watchId !== null) navigator.geolocation.clearWatch(watchId)
    map?.destroy()
  }
})

const locate = () => watchMe(true)
</script>

<main class="app" class:picking>
  <div class="map" bind:this={mapEl} aria-label={uk.mapLabel} role="region"></div>

  {#if mapState !== 'ready'}
    <div class="map-status" role="status">{mapState === 'failed' ? uk.mapFailed : uk.mapLoading}</div>
  {/if}

  {#if flashing}
    <div class="flash {flashing}" aria-hidden="true"></div>
  {/if}

  <TopBar {level} alerts={alerts.alerts} {status} {demo} {cityClear} />

  {#if toast}
    <div class="toast-wrap" role="alert">
      <button type="button" class="toast {toast.category}" onclick={selectFromToast} data-testid="toast">
        {toast.title}
      </button>
    </div>
  {/if}

  {#if picking}
    <div class="pick-hint" role="status">
      {uk.pickOnMapHint}
      <button type="button" onclick={() => ((picking = false), map?.setPicking(false))}>{uk.close}</button>
    </div>
  {/if}

  <div class="fabs">
    <button type="button" class="fab" onclick={() => (showSettings = true)} aria-label={uk.settings} data-testid="open-settings">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        ><path
          fill="currentColor"
          d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.3 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.3-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
        /></svg
      >
    </button>
    <button type="button" class="fab" onclick={() => (showLegend = true)} aria-label={uk.legend} data-testid="open-legend">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        ><path fill="currentColor" d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /></svg
      >
    </button>
    <button
      type="button"
      class="fab"
      class:active={me !== null}
      aria-pressed={me !== null}
      onclick={locate}
      aria-label={me ? uk.locateOn : uk.locateMe}
      title={me ? uk.locateOn : uk.locateMe}
      data-testid="locate"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        ><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21z" /></svg
      >
    </button>
    <button type="button" class="fab" onclick={() => map?.fitRegion()} aria-label={uk.zoomRegion}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
        ><path fill="currentColor" d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" /></svg
      >
    </button>
  </div>

  <ThreatPanel
    {rows}
    {feed}
    {selected}
    {now}
    {showRoutes}
    onselect={select}
    ontoggleroutes={(corridors) => {
      showRoutes = corridors !== null
      map?.setRoutes(corridors ?? [])
    }}
  />

  {#if showSettings}
    <SettingsSheet
      {settings}
      pushSupported={pushSupported()}
      {pushMessage}
      canInstall={installPrompt !== null}
      onchange={updateSettings}
      onaddgps={addByGps}
      onaddmap={startPicking}
      ontogglepush={togglePush}
      ontestsound={testSound}
      oninstall={async () => {
        await installPrompt?.prompt()
        installPrompt = null
      }}
      onclose={() => (showSettings = false)}
    />
  {/if}

  {#if showLegend}
    <LegendSheet onclose={() => (showLegend = false)} />
  {/if}
</main>

<style>
  .app {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
  .map {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
  .picking .map {
    cursor: crosshair;
  }
  .map-status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--muted);
    pointer-events: none;
  }
  .flash {
    position: absolute;
    inset: 0;
    z-index: 20;
    pointer-events: none;
    border: 14px solid var(--danger);
    animation: flash 0.5s steps(2, jump-none) 8;
  }
  .flash.threat {
    border-color: #ff9500;
  }
  @keyframes flash {
    50% {
      opacity: 0;
    }
  }
  .toast-wrap {
    position: absolute;
    z-index: 7;
    top: calc(env(safe-area-inset-top) + 60px);
    left: 50%;
    transform: translateX(-50%);
    max-width: min(520px, calc(100% - 24px));
  }
  .toast {
    width: 100%;
    padding: 10px 16px;
    border: 0;
    border-radius: 14px;
    background: var(--danger);
    color: #fff;
    font: inherit;
    font-weight: 700;
    box-shadow: var(--shadow);
    cursor: pointer;
  }
  .toast.threat {
    background: #ff9500;
    color: #111;
  }
  .fabs {
    position: absolute;
    z-index: 3;
    right: 12px;
    bottom: calc(84px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fab {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: var(--panel-solid);
    color: var(--text);
    box-shadow: var(--shadow);
    cursor: pointer;
  }
  .fab.active {
    background: #0a84ff;
    color: #fff;
  }
  .pick-hint {
    position: absolute;
    z-index: 6;
    top: calc(env(safe-area-inset-top) + 64px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border-radius: 12px;
    background: var(--accent);
    color: #111;
    font-weight: 600;
    box-shadow: var(--shadow);
    max-width: calc(100% - 32px);
  }
  .pick-hint button {
    border: 0;
    border-radius: 8px;
    padding: 6px 10px;
    background: rgb(0 0 0 / 0.15);
    font: inherit;
    cursor: pointer;
  }
  @media (prefers-reduced-motion: reduce) {
    .flash {
      animation: none;
    }
  }
  @media (min-width: 900px) {
    .fabs {
      bottom: 24px;
    }
  }
</style>
