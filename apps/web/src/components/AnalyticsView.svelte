<script lang="ts">
import { THREAT_CLASS_LABELS_UK, type ThreatClass } from '@arpha/shared'
import { uk } from '../lib/i18n'

export interface Corridor {
  from: string
  to: string
  fromLat: number
  fromLon: number
  toLat: number
  toLon: number
  count: number
  cls: ThreatClass
}
interface Patterns {
  days: number
  routes: number
  byClass: Partial<Record<ThreatClass, number>>
  hours: Partial<Record<ThreatClass, number[]>>
  corridors: Corridor[]
  entries: { place: string; count: number }[]
  endings: { place: string; count: number; outcome: string }[]
}

interface Props {
  showRoutes: boolean
  ontoggleroutes: (corridors: Corridor[] | null) => void
}
let { showRoutes, ontoggleroutes }: Props = $props()

let data = $state<Patterns | null>(null)
let failed = $state(false)
let cls = $state<ThreatClass>('drones')

$effect(() => {
  fetch('/api/patterns?days=30')
    .then((r) => r.json())
    .then((d: Patterns | null) => {
      data = d
      const top = Object.entries(d?.byClass ?? {}).sort((a, b) => b[1] - a[1])[0]
      if (top) cls = top[0] as ThreatClass
    })
    .catch(() => (failed = true))
})

const hours = $derived(data?.hours[cls] ?? new Array(24).fill(0))
const peak = $derived(Math.max(1, ...hours))
const corridors = $derived((data?.corridors ?? []).filter((c) => c.cls === cls).slice(0, 8))
</script>

<div class="analytics" data-testid="analytics">
  {#if failed}
    <p class="hint">{uk.analyticsFailed}</p>
  {:else if !data}
    <p class="hint">{uk.loading}</p>
  {:else if data.routes === 0}
    <p class="hint">{uk.analyticsEmpty}</p>
  {:else}
    <p class="hint">{uk.analyticsIntro(data.routes, data.days)}</p>
    <div class="classes" role="tablist">
      {#each Object.entries(data.byClass) as [c, n] (c)}
        <button type="button" role="tab" aria-selected={cls === c} class:on={cls === c} onclick={() => (cls = c as ThreatClass)}>
          {THREAT_CLASS_LABELS_UK[c as ThreatClass].split(' (')[0]} · {n}
        </button>
      {/each}
    </div>

    <h3>{uk.byHour}</h3>
    <div class="hours" aria-label={uk.byHour}>
      {#each hours as n, h (h)}
        <span class="bar" style:height={`${Math.round((n / peak) * 100)}%`} title={`${h}:00 — ${n}`}></span>
      {/each}
    </div>
    <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>

    {#if corridors.length}
      <h3>{uk.corridors}</h3>
      <ol class="list">
        {#each corridors as c (c.from + c.to)}
          <li><span>{c.from} → {c.to}</span><b>{c.count}</b></li>
        {/each}
      </ol>
      <button type="button" class="toggle" class:on={showRoutes} onclick={() => ontoggleroutes(showRoutes ? null : data!.corridors)}>
        {showRoutes ? uk.hideRoutes : uk.showRoutes}
      </button>
    {/if}

    {#if data.entries.length}
      <h3>{uk.entries}</h3>
      <ol class="list">
        {#each data.entries.slice(0, 5) as e (e.place)}<li><span>{e.place}</span><b>{e.count}</b></li>{/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
  .analytics {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }
  h3 {
    margin: 8px 0 0;
    font-size: 14px;
  }
  .classes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .classes button,
  .toggle {
    border: 0;
    border-radius: 999px;
    padding: 6px 12px;
    background: var(--chip);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .classes button.on,
  .toggle.on {
    background: var(--accent);
    color: #111;
  }
  .hours {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    align-items: end;
    gap: 2px;
    height: 70px;
    padding: 4px;
    border-radius: 10px;
    background: var(--chip);
  }
  .bar {
    min-height: 2px;
    border-radius: 2px;
    background: var(--danger);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
    padding: 0 4px;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .list li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 10px;
    background: var(--chip);
    font-size: 14px;
  }
</style>
