<script lang="ts">
import { uk } from '../lib/i18n'
import type { Settings, Theme } from '../lib/settings'

interface Props {
  settings: Settings
  pushSupported: boolean
  pushMessage: string | null
  canInstall: boolean
  onchange: (patch: Partial<Settings>) => void
  ongps: () => void
  onpick: () => void
  ontogglepush: (on: boolean) => void
  oninstall: () => void
  onclose: () => void
}
let {
  settings,
  pushSupported,
  pushMessage,
  canInstall,
  onchange,
  ongps,
  onpick,
  ontogglepush,
  oninstall,
  onclose,
}: Props = $props()

const themes: { value: Theme; label: string }[] = [
  { value: 'auto', label: uk.themeAuto },
  { value: 'light', label: uk.themeLight },
  { value: 'dark', label: uk.themeDark },
]
let dialog: HTMLDialogElement
$effect(() => {
  dialog.showModal()
})
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="settings-title"
  onclose={onclose}
  onclick={(e) => e.target === dialog && dialog.close()}
  data-testid="settings"
>
  <div class="inner">
    <header>
      <h2 id="settings-title">{uk.settings}</h2>
      <button class="x" type="button" onclick={() => dialog.close()} aria-label={uk.close}>✕</button>
    </header>

    <section>
      <h3>{uk.myPoint}</h3>
      <p class="hint">{uk.myPointHint}</p>
      <p class="value" data-testid="point-value">
        {settings.point
          ? `${settings.point.lat.toFixed(3)}, ${settings.point.lon.toFixed(3)}`
          : uk.pointNotSet}
      </p>
      <div class="row">
        <button type="button" onclick={ongps}>{uk.useGps}</button>
        <button type="button" onclick={onpick}>{uk.pickOnMap}</button>
        {#if settings.point}
          <button type="button" class="ghost" onclick={() => onchange({ point: null, pointSource: null })}>
            {uk.clearPoint}
          </button>
        {/if}
      </div>
    </section>

    <section>
      <label class="h3" for="radius">{uk.radius}: <b>{settings.radiusKm} {uk.km}</b></label>
      <input
        id="radius"
        type="range"
        min="3"
        max="50"
        step="1"
        value={settings.radiusKm}
        oninput={(e) => onchange({ radiusKm: Number(e.currentTarget.value) })}
      />
    </section>

    <section>
      <h3 id="theme-label">{uk.theme}</h3>
      <div class="seg" role="radiogroup" aria-labelledby="theme-label">
        {#each themes as t (t.value)}
          <button
            type="button"
            role="radio"
            aria-checked={settings.theme === t.value}
            class:on={settings.theme === t.value}
            onclick={() => onchange({ theme: t.value })}>{t.label}</button
          >
        {/each}
      </div>
    </section>

    <section>
      <h3>{uk.push}</h3>
      {#if !pushSupported}
        <p class="hint">{uk.pushUnsupported}</p>
      {:else}
        <label class="check">
          <input
            type="checkbox"
            checked={settings.pushAlerts}
            onchange={(e) => onchange({ pushAlerts: e.currentTarget.checked })}
          />
          {uk.pushAlerts}
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={settings.pushThreats}
            onchange={(e) => onchange({ pushThreats: e.currentTarget.checked })}
          />
          {uk.pushThreats}
        </label>
        <div class="row">
          <button type="button" class:primary={!settings.pushEnabled} onclick={() => ontogglepush(!settings.pushEnabled)}>
            {settings.pushEnabled ? uk.pushDisable : uk.pushEnable}
          </button>
        </div>
      {/if}
      {#if pushMessage}<p class="hint" role="status">{pushMessage}</p>{/if}
    </section>

    {#if canInstall}
      <section>
        <button type="button" class="primary wide" onclick={oninstall}>{uk.install}</button>
      </section>
    {/if}

    <section class="about">
      <h3>{uk.about}</h3>
      <p class="hint">{uk.disclaimer}</p>
      <p class="hint">
        <a href="https://github.com/kiskaserver/arpha" target="_blank" rel="noopener noreferrer">{uk.sourceCode}</a>
        · © OpenStreetMap · OpenFreeMap · GeoNames · alerts.in.ua
      </p>
    </section>
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
    box-shadow: var(--shadow-up);
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
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
  h3,
  .h3 {
    display: block;
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .hint {
    margin: 4px 0;
    font-size: 13px;
    color: var(--muted);
  }
  .hint a {
    color: var(--link);
  }
  .value {
    margin: 6px 0;
    font-variant-numeric: tabular-nums;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }
  button {
    min-height: 40px;
    padding: 8px 14px;
    border: 0;
    border-radius: 10px;
    background: var(--chip);
    color: var(--text);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    color: #111;
  }
  button.ghost {
    background: none;
    color: var(--muted);
  }
  .wide {
    width: 100%;
  }
  .x {
    width: 36px;
    height: 36px;
    min-height: 0;
    padding: 0;
    border-radius: 50%;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--chip);
  }
  .seg button {
    background: none;
  }
  .seg button.on {
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .check {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
  }
  .check input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
