<script lang="ts">
import { pointInGeometry } from '@arpha/shared'
import { onMount } from 'svelte'
import SettingsSheet from './components/SettingsSheet.svelte'
import ThreatPanel from './components/ThreatPanel.svelte'
import TopBar from './components/TopBar.svelte'
import { uk } from './lib/i18n'
import type { MapController } from './lib/map'
import { MotionModel } from './lib/motion'
import { disablePush, enablePush, pushSupported } from './lib/push'
import { applyTheme, loadSettings, prefersDark, type Settings, saveSettings } from './lib/settings'
import { applyEvent, initialState } from './lib/state'
import { type ConnectionStatus, LiveStream } from './lib/stream'
import { alertedFeatureIds, alertLevel, threatRows } from './lib/view'

const live = initialState()
const motion = new MotionModel()

let version = $state(0)
let now = $state(Date.now())
let status = $state<ConnectionStatus>('connecting')
let settings = $state<Settings>(loadSettings())
let selected = $state<string | null>(new URLSearchParams(location.search).get('track'))
let showSettings = $state(false)
let picking = $state(false)
let pushMessage = $state<string | null>(null)
let mapState = $state<'loading' | 'ready' | 'failed'>('loading')
let installPrompt = $state<(Event & { prompt(): Promise<void> }) | null>(null)
let myFeatureIds = $state<string[]>([])
let mapEl: HTMLDivElement
let map: MapController | null = null

const serverNow = () => Date.now() + live.clockOffset

const rows = $derived.by(() => {
  void version
  return threatRows(live.tracks.values(), settings.point, now, settings.radiusKm)
})
const alerts = $derived.by(() => {
  void version
  return live.alerts
})
const demo = $derived.by(() => {
  void version
  return live.demo
})
const level = $derived(alertLevel(alerts, myFeatureIds))

function onStreamEvent(ev: Parameters<typeof applyEvent>[1]) {
  applyEvent(live, ev, Date.now())
  const t = serverNow()
  if (ev.type === 'snapshot') {
    motion.retain(new Set(live.tracks.keys()))
    for (const track of live.tracks.values()) motion.upsert(track, t)
  } else if (ev.type === 'track') {
    motion.upsert(ev.track, t)
  } else if (ev.type === 'track_removed') {
    motion.remove(ev.id)
    if (selected === ev.id) selected = null
  }
  if (ev.type === 'alerts' || ev.type === 'snapshot') map?.setAlerts(alertedFeatureIds(live.alerts))
  version++
  map?.invalidate()
}

function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  saveSettings($state.snapshot(settings))
  if ('theme' in patch) {
    applyTheme(settings.theme)
    map?.setTheme(prefersDark(settings.theme))
  }
  if ('point' in patch || 'radiusKm' in patch) {
    map?.setObserver(settings.point, settings.radiusKm)
    void refreshMyAreas()
  }
  if (
    settings.pushEnabled &&
    ('point' in patch || 'radiusKm' in patch || 'pushAlerts' in patch || 'pushThreats' in patch)
  ) {
    void togglePush(true)
  }
}

/** Which polygons contain my point — decides "тривога у вашій громаді". */
async function refreshMyAreas() {
  const p = settings.point
  if (!p) {
    myFeatureIds = []
    return
  }
  try {
    const res = await fetch('/boundaries.geojson')
    const data = (await res.json()) as {
      features: { properties: { id: string }; geometry: Parameters<typeof pointInGeometry>[1] }[]
    }
    myFeatureIds = data.features
      .filter((f) => pointInGeometry(p, f.geometry))
      .map((f) => f.properties.id)
  } catch {
    myFeatureIds = []
  }
}

function useGps() {
  if (!('geolocation' in navigator)) {
    pushMessage = uk.gpsFailed
    return
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const point = { lat: pos.coords.latitude, lon: pos.coords.longitude }
      updateSettings({ point, pointSource: 'gps' })
      map?.flyTo(point, 10)
    },
    (err) => {
      pushMessage = err.code === err.PERMISSION_DENIED ? uk.gpsDenied : uk.gpsFailed
    },
    { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
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
    point: settings.point,
    radiusKm: settings.radiusKm,
    alerts: settings.pushAlerts,
    threats: settings.pushThreats,
  })
  if (res.ok) {
    if (!settings.pushEnabled) {
      settings = { ...settings, pushEnabled: true }
      saveSettings($state.snapshot(settings))
    }
    pushMessage = uk.pushOn
  } else {
    pushMessage = {
      unsupported: uk.pushUnsupported,
      denied: uk.pushDenied,
      unavailable: uk.pushUnavailable,
      failed: uk.pushFailed,
    }[res.reason]
  }
}

function select(id: string | null) {
  selected = id
  map?.select(id)
  const url = new URL(location.href)
  if (id) url.searchParams.set('track', id)
  else url.searchParams.delete('track')
  history.replaceState(null, '', url)
}

onMount(() => {
  applyTheme(settings.theme)
  void refreshMyAreas()

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

  const onInstall = (e: Event) => {
    e.preventDefault()
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
          updateSettings({ point, pointSource: 'manual' })
        },
      }),
    )
    .then((ctl) => {
      if (destroyed) return ctl.destroy()
      map = ctl
      map.bind(() => live.tracks.values(), motion)
      map.setAlerts(alertedFeatureIds(live.alerts))
      map.setObserver(settings.point, settings.radiusKm)
      // The user may have started picking a point before the map finished loading.
      map.setPicking(picking)
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
    map?.destroy()
  }
})
</script>

<main class="app" class:picking>
  <div class="map" bind:this={mapEl} aria-label={uk.mapLabel} role="region"></div>

  {#if mapState !== 'ready'}
    <div class="map-status" role="status">{mapState === 'failed' ? uk.mapFailed : uk.mapLoading}</div>
  {/if}

  <TopBar {level} alerts={alerts.alerts} {status} {demo} />

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
    <button type="button" class="fab" onclick={() => (settings.point ? map?.flyTo(settings.point, 10) : useGps())} aria-label={uk.locateMe}>
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

  <ThreatPanel {rows} {selected} {now} onselect={select} />

  {#if showSettings}
    <SettingsSheet
      {settings}
      pushSupported={pushSupported()}
      {pushMessage}
      canInstall={installPrompt !== null}
      onchange={updateSettings}
      ongps={useGps}
      onpick={startPicking}
      ontogglepush={togglePush}
      oninstall={async () => {
        await installPrompt?.prompt()
        installPrompt = null
      }}
      onclose={() => (showSettings = false)}
    />
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
  @media (min-width: 900px) {
    .fabs {
      bottom: 24px;
    }
  }
</style>
