<script lang="ts">
import { type FeedItem, threatLabelUk } from '@arpha/shared'
import { formatAgo, formatDistance, formatEta, targetNames } from '../lib/format'
import { isQuiet } from '../lib/frame'
import { uk } from '../lib/i18n'
import { clampHeight, pickSnap, type Snap, snapHeights, toggleSnap } from '../lib/sheet'
import type { ThreatRow } from '../lib/view'
import AnalyticsView, { type Corridor } from './AnalyticsView.svelte'
import FeedList from './FeedList.svelte'
import ThreatCard from './ThreatCard.svelte'
import ThreatIcon from './ThreatIcon.svelte'

interface Props {
  rows: ThreatRow[]
  feed: FeedItem[]
  selected: string | null
  now: number
  showRoutes: boolean
  onselect: (id: string | null) => void
  ontoggleroutes: (corridors: Corridor[] | null) => void
}
let { rows, feed, selected, now, showRoutes, onselect, ontoggleroutes }: Props = $props()
let tab = $state<'threats' | 'feed' | 'analytics'>('threats')
let snap = $state<Snap>('peek')
/** Live height while the finger is on the handle; null when settled. */
let dragHeight = $state<number | null>(null)
let viewport = $state(typeof window === 'undefined' ? 800 : window.innerHeight)

const active = $derived(rows.filter((r) => r.track.status === 'active'))
const selectedRow = $derived(rows.find((r) => r.track.id === selected) ?? null)
const nearest = $derived(active.find((r) => r.approach?.etaMin != null) ?? null)
const settled = $derived(snap === 'peek' && selectedRow ? 'half' : snap)
const height = $derived(dragHeight ?? snapHeights(viewport)[settled])
const expanded = $derived(settled !== 'peek')

let drag: {
  y: number
  h: number
  lastY: number
  lastT: number
  moved: boolean
  target: HTMLElement
} | null = null

function onDown(e: PointerEvent) {
  if (e.button !== 0) return
  viewport = window.innerHeight
  drag = {
    y: e.clientY,
    h: height,
    lastY: e.clientY,
    lastT: e.timeStamp,
    moved: false,
    target: e.target as HTMLElement,
  }
  // Capture right away: the finger leaves the small handle within the first pixels.
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onMove(e: PointerEvent) {
  if (!drag) return
  if (!drag.moved && Math.abs(e.clientY - drag.y) > 6) drag.moved = true
  if (!drag.moved) return
  dragHeight = clampHeight(drag.h + (drag.y - e.clientY), viewport)
  drag.lastY = e.clientY
  drag.lastT = e.timeStamp
}

function onUp(e: PointerEvent) {
  if (!drag) return
  const d = drag
  drag = null
  if (!d.moved) {
    // A tap. With the pointer captured, the click lands on the handle, so forward taps on tabs.
    const tabButton = d.target.closest<HTMLElement>('[role="tab"]')
    if (tabButton) tabButton.click()
    else snap = toggleSnap(settled)
    return
  }
  const dt = Math.max(1, e.timeStamp - d.lastT)
  const velocity = (d.lastY - e.clientY) / dt
  snap = pickSnap(dragHeight ?? height, velocity, viewport, settled)
  dragHeight = null
}

function openTab(t: typeof tab) {
  tab = t
  if (snap === 'peek') snap = 'half'
}
</script>

<svelte:window onresize={() => (viewport = window.innerHeight)} />

<section
  class="panel"
  class:expanded
  class:dragging={dragHeight !== null}
  style:--sheet-h={`${height}px`}
  aria-label={uk.threatsTitle}
  data-testid="threat-panel"
>
  <div
    class="grab"
    role="presentation"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    data-testid="sheet-handle"
  >
    <span class="grip" aria-hidden="true"></span>
  {#if !selectedRow}
    <div class="handle">
      <span class="summary">
        <strong data-testid="threat-count">
          {active.length ? uk.threatsCount(active.length) : uk.threatsNone}
        </strong>
        {#if nearest}
          <span class="nearest">
            · {threatLabelUk(nearest.track.type, nearest.track.count)}
            <b>{formatEta(nearest.approach!.etaMin)}</b>
          </span>
        {/if}
      </span>
    </div>

    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'threats'} class:on={tab === 'threats'} aria-expanded={expanded} onclick={() => openTab('threats')}>{uk.tabThreats}</button>
      <button type="button" role="tab" aria-selected={tab === 'feed'} class:on={tab === 'feed'} onclick={() => openTab('feed')} data-testid="tab-feed">{uk.tabFeed}{#if feed.length}<span class="badge">{feed.length}</span>{/if}</button>
      <button type="button" role="tab" aria-selected={tab === 'analytics'} class:on={tab === 'analytics'} onclick={() => openTab('analytics')} data-testid="tab-analytics">{uk.tabAnalytics}</button>
    </div>
  {/if}
  </div>

  {#if selectedRow}
    <div class="scroll">
      <ThreatCard row={selectedRow} {now} onclose={() => onselect(null)} />
    </div>
  {:else}
    {#if tab === 'feed'}
      <div class="scroll"><FeedList items={feed} onselect={(id) => onselect(id)} /></div>
    {:else if tab === 'analytics'}
      <div class="scroll"><AnalyticsView {showRoutes} {ontoggleroutes} /></div>
    {:else}
    <ul id="threat-list" class="scroll list" data-testid="threat-list">
      {#each rows as r (r.track.id)}
        <li class:done={r.track.status !== 'active'} class:quiet={r.track.status === 'active' && isQuiet(r.track, now)}>
          <button type="button" onclick={() => onselect(r.track.id)} data-testid="threat-row">
            <ThreatIcon type={r.track.type} heading={r.track.headingDeg} />
            <span class="main">
              <span class="name">{threatLabelUk(r.track.type, r.track.count)}</span>
              <span class="meta">
                {#if r.track.status === 'destroyed'}{uk.statusDestroyed} ·
                {:else if r.track.status === 'lost'}{uk.statusLost} ·{/if}
                {r.track.placeName ?? r.track.target?.name ?? uk.noPosition}
                {#if r.track.status === 'active' && isQuiet(r.track, now)}
                  · <span class="quiet">{uk.quiet(Math.round((now - r.track.updatedAt) / 60_000))}</span>
                {:else}
                  · {formatAgo(r.track.updatedAt, now)}
                {/if}
              </span>
            </span>
            {#if r.track.status === 'active'}
              <span class="right">
                {#if r.approach}
                  <span class="eta" class:hot={r.approach.etaMin !== null}>{formatEta(r.approach.etaMin)}</span>
                  <span class="dist">{formatDistance(r.approach.distanceKm)}</span>
                {:else if r.track.target}
                  <span class="eta hot">→ {targetNames(r.track)}</span>
                {/if}
              </span>
            {/if}
          </button>
        </li>
      {:else}
        <li class="empty">{uk.threatsNone}</li>
      {/each}
    </ul>
    {/if}
  {/if}
</section>

<style>
  .panel {
    position: absolute;
    z-index: 4;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--sheet-h, 64px);
    display: flex;
    flex-direction: column;
    background: var(--panel-solid);
    border-radius: 18px 18px 0 0;
    box-shadow: var(--shadow-up);
    padding-bottom: env(safe-area-inset-bottom);
    transition: height 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
    overflow: hidden;
  }
  .panel.dragging {
    transition: none;
  }
  .grab {
    flex: none;
    display: flex;
    flex-direction: column;
    touch-action: none;
    cursor: grab;
    user-select: none;
    padding-top: 8px;
  }
  .handle {
    padding: 6px 16px 10px;
    color: var(--text);
  }
  .grip {
    flex: none;
    margin-bottom: 2px;
    align-self: center;
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--muted);
    opacity: 0.5;
  }
  .summary {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nearest {
    color: var(--muted);
  }
  .nearest b {
    color: var(--danger);
  }
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 4px;
    margin: 0 16px 6px;
    padding: 3px;
    border-radius: 10px;
    background: var(--chip);
  }
  .tabs button {
    border: 0;
    border-radius: 8px;
    padding: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .tabs button.on {
    background: var(--panel-solid);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .badge {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--chip-strong);
  }
  .scroll {
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 16px 16px;
  }
  .list {
    margin: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border: 0;
    border-radius: 12px;
    background: var(--chip);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .list button:hover {
    filter: brightness(1.08);
  }
  .quiet :global(svg) {
    opacity: 0.55;
  }
  span.quiet {
    color: var(--warn, #b26b00);
  }
  .done {
    opacity: 0.55;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-weight: 600;
  }
  .meta {
    font-size: 13px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    flex: none;
    max-width: 40%;
  }
  .eta {
    font-weight: 700;
    font-size: 14px;
    text-align: right;
  }
  .eta.hot {
    color: var(--danger);
  }
  .dist {
    font-size: 12px;
    color: var(--muted);
  }
  .empty {
    padding: 16px;
    text-align: center;
    color: var(--muted);
  }

  @media (min-width: 900px) {
    .panel,
    .panel.expanded {
      top: 72px;
      left: 12px;
      right: auto;
      bottom: 12px;
      width: 360px;
      height: auto;
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    .grip {
      display: none;
    }
    .grab {
      cursor: default;
      touch-action: auto;
    }
  }
</style>
