<script lang="ts">
import { ALERT_TYPE_LABELS_UK, THREAT_LABELS_UK, THREAT_TYPES } from '@arpha/shared'
import { uk } from '../lib/i18n'
import { infraSvg } from '../lib/icons'
import { ALERT_COLORS } from '../lib/map-colors'
import ThreatIcon from './ThreatIcon.svelte'

interface Props {
  onclose: () => void
}
let { onclose }: Props = $props()

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
let dialog: HTMLDialogElement
$effect(() => {
  dialog.showModal()
})
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="legend-title"
  onclose={onclose}
  onclick={(e) => e.target === dialog && dialog.close()}
  data-testid="legend"
>
  <div class="inner">
    <header>
      <h2 id="legend-title">{uk.legend}</h2>
      <button class="x" type="button" onclick={() => dialog.close()} aria-label={uk.close}>✕</button>
    </header>
    <ul class="grid">
      {#each THREAT_TYPES as t (t)}
        <li><ThreatIcon type={t} size={30} /><span>{THREAT_LABELS_UK[t].one}</span></li>
      {/each}
    </ul>
    <ul class="list">
      <li><span class="sw cone"></span>{uk.legendCone}</li>
      <li><span class="sw impact"></span>{uk.legendImpact}</li>
      <li><span class="sw vector"></span>{uk.legendVector}</li>
      <li><span class="sw target"></span>{uk.legendTarget}</li>
      <li><span class="sw heat"></span>{uk.legendHotspots}</li>
      <li><img src={svgUrl(infraSvg('closed'))} alt="" width="22" height="22" />{uk.legendBridgeClosed}</li>
      <li><img src={svgUrl(infraSvg('open'))} alt="" width="22" height="22" />{uk.legendBridgeOpen}</li>
    </ul>
    <h3>{uk.legendAlerts}</h3>
    <ul class="list">
      {#each Object.entries(ALERT_COLORS) as [type, color] (type)}
        <li><span class="sw" style:background={color}></span>{ALERT_TYPE_LABELS_UK[type]}</li>
      {/each}
    </ul>
  </div>
</dialog>

<style>
  .sheet {
    width: min(480px, 100%);
    max-height: min(90dvh, 760px);
    margin: auto auto 0;
    padding: 0;
    border: 0;
    border-radius: 18px 18px 0 0;
    background: var(--panel-solid);
    color: var(--text);
  }
  .sheet::backdrop {
    background: rgb(0 0 0 / 0.45);
  }
  @media (min-width: 640px) {
    .sheet {
      margin: auto;
      border-radius: 18px;
    }
  }
  .inner {
    padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
  h3 {
    margin: 16px 0 6px;
    font-size: 15px;
  }
  .x {
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: var(--chip);
    color: var(--text);
    cursor: pointer;
  }
  ul {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }
  .list li {
    padding: 5px 0;
  }
  .sw {
    flex: none;
    width: 22px;
    height: 14px;
    border-radius: 4px;
  }
  .cone {
    background: rgb(255 138 0 / 0.3);
  }
  .impact {
    background: rgb(255 59 48 / 0.3);
    border: 1.5px dashed #ff3b30;
  }
  .vector {
    height: 0;
    border-top: 3px dashed #ff8a00;
  }
  .target {
    width: 14px;
    border-radius: 50%;
    border: 2.5px solid #ff8a00;
  }
  .heat {
    background: radial-gradient(circle, #ff3b30, #ffcc00 50%, transparent 75%);
  }
</style>
