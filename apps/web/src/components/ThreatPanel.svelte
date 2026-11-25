<script lang="ts">
import { type FeedItem, threatLabelUk } from '@arpha/shared'
import { formatAgo, formatDistance, formatEta } from '../lib/format'
import { uk } from '../lib/i18n'
import type { ThreatRow } from '../lib/view'
import FeedList from './FeedList.svelte'
import ThreatCard from './ThreatCard.svelte'
import ThreatIcon from './ThreatIcon.svelte'

interface Props {
  rows: ThreatRow[]
  feed: FeedItem[]
  selected: string | null
  now: number
  onselect: (id: string | null) => void
}
let { rows, feed, selected, now, onselect }: Props = $props()
let expanded = $state(false)
let tab = $state<'threats' | 'feed'>('threats')

const active = $derived(rows.filter((r) => r.track.status === 'active'))
const selectedRow = $derived(rows.find((r) => r.track.id === selected) ?? null)
const nearest = $derived(active.find((r) => r.approach?.etaMin != null) ?? null)
</script>

<section
  class="panel"
  class:expanded={expanded || selectedRow}
  aria-label={uk.threatsTitle}
  data-testid="threat-panel"
>
  {#if selectedRow}
    <div class="scroll">
      <ThreatCard row={selectedRow} {now} onclose={() => onselect(null)} />
    </div>
  {:else}
    <button
      class="handle"
      type="button"
      aria-expanded={expanded}
      aria-controls="threat-list"
      onclick={() => (expanded = !expanded)}
    >
      <span class="grip" aria-hidden="true"></span>
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
    </button>

    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'threats'} class:on={tab === 'threats'} onclick={() => ((tab = 'threats'), (expanded = true))}>{uk.tabThreats}</button>
      <button type="button" role="tab" aria-selected={tab === 'feed'} class:on={tab === 'feed'} onclick={() => ((tab = 'feed'), (expanded = true))} data-testid="tab-feed">{uk.tabFeed}{#if feed.length}<span class="badge">{feed.length}</span>{/if}</button>
    </div>

    {#if tab === 'feed'}
      <div class="scroll"><FeedList items={feed} onselect={(id) => onselect(id)} /></div>
    {:else}
    <ul id="threat-list" class="scroll list" data-testid="threat-list">
      {#each rows as r (r.track.id)}
        <li class:done={r.track.status !== 'active'}>
          <button type="button" onclick={() => onselect(r.track.id)} data-testid="threat-row">
            <ThreatIcon type={r.track.type} heading={r.track.headingDeg} />
            <span class="main">
              <span class="name">{threatLabelUk(r.track.type, r.track.count)}</span>
              <span class="meta">
                {#if r.track.status === 'destroyed'}{uk.statusDestroyed} ·
                {:else if r.track.status === 'lost'}{uk.statusLost} ·{/if}
                {r.track.placeName ?? r.track.target?.name ?? uk.noPosition}
                · {formatAgo(r.track.updatedAt, now)}
              </span>
            </span>
            {#if r.track.status === 'active'}
              <span class="right">
                {#if r.approach}
                  <span class="eta" class:hot={r.approach.etaMin !== null}>{formatEta(r.approach.etaMin)}</span>
                  <span class="dist">{formatDistance(r.approach.distanceKm)}</span>
                {:else if r.track.target}
                  <span class="eta hot">→ {r.track.target.name}</span>
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
    max-height: 64px;
    display: flex;
    flex-direction: column;
    background: var(--panel-solid);
    border-radius: 18px 18px 0 0;
    box-shadow: var(--shadow-up);
    padding-bottom: env(safe-area-inset-bottom);
    transition: max-height 0.25s ease;
    overflow: hidden;
  }
  .panel.expanded {
    max-height: min(62vh, 560px);
  }
  .handle {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 8px 16px 12px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .grip {
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
    grid-template-columns: 1fr 1fr;
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
      max-height: none;
      border-radius: 18px;
      box-shadow: var(--shadow);
    }
    .grip {
      display: none;
    }
    .handle {
      cursor: default;
      pointer-events: none;
    }
  }
</style>
