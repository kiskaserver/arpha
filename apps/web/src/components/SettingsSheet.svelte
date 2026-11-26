<script lang="ts">
import { THREAT_CLASS_LABELS_UK, THREAT_CLASSES, type ThreatClass } from '@arpha/shared'
import { uk } from '../lib/i18n'
import type { Settings, SoundCategory, SoundId, Theme } from '../lib/settings'

interface Props {
  settings: Settings
  pushSupported: boolean
  pushMessage: string | null
  canInstall: boolean
  onchange: (patch: Partial<Settings>) => void
  onaddgps: () => void
  onaddmap: () => void
  ontogglepush: (on: boolean) => void
  ontestsound: (category: SoundCategory) => void
  oninstall: () => void
  onclose: () => void
}
let {
  settings,
  pushSupported,
  pushMessage,
  canInstall,
  onchange,
  onaddgps,
  onaddmap,
  ontogglepush,
  ontestsound,
  oninstall,
  onclose,
}: Props = $props()

const themes: { value: Theme; label: string }[] = [
  { value: 'auto', label: uk.themeAuto },
  { value: 'light', label: uk.themeLight },
  { value: 'dark', label: uk.themeDark },
]
const sounds: { value: SoundId; label: string }[] = [
  { value: 'off', label: uk.soundOff },
  { value: 'soft', label: uk.soundSoft },
  { value: 'chime', label: uk.soundChime },
  { value: 'siren', label: uk.soundSiren },
]
const categories: { value: SoundCategory; label: string }[] = [
  { value: 'alert', label: uk.soundAlert },
  { value: 'ballistic', label: uk.soundBallistic },
  { value: 'threat', label: uk.soundThreat },
]

function toggleClass(c: ThreatClass, on: boolean) {
  const next = on ? [...settings.classes, c] : settings.classes.filter((x) => x !== c)
  onchange({ classes: THREAT_CLASSES.filter((x) => next.includes(x)) })
}

function renamePoint(id: string, name: string) {
  onchange({
    points: settings.points.map((p) => (p.id === id ? { ...p, name: name.slice(0, 40) || p.name } : p)),
  })
}

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
      <h3>{uk.myPoints}</h3>
      <p class="hint">{uk.myPointsHint}</p>
      {#if settings.points.length}
        <ul class="points" data-testid="points">
          {#each settings.points as p (p.id)}
            <li>
              <input
                aria-label={uk.pointName}
                value={p.name}
                maxlength="40"
                onchange={(e) => renamePoint(p.id, e.currentTarget.value.trim())}
              />
              <span class="coords">{p.lat.toFixed(3)}, {p.lon.toFixed(3)}</span>
              <button
                type="button"
                class="ghost"
                onclick={() => onchange({ points: settings.points.filter((x) => x.id !== p.id) })}
              >{uk.remove}</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="value" data-testid="point-value">{uk.noPoints}</p>
      {/if}
      {#if settings.points.length < 5}
        <div class="row">
          <button type="button" onclick={onaddgps}>{uk.addByGps}</button>
          <button type="button" onclick={onaddmap}>{uk.addOnMap}</button>
        </div>
      {/if}
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
      <h3>{uk.notifyAbout}</h3>
      {#each THREAT_CLASSES as c (c)}
        <label class="check">
          <input
            type="checkbox"
            checked={settings.classes.includes(c)}
            onchange={(e) => toggleClass(c, e.currentTarget.checked)}
          />
          {THREAT_CLASS_LABELS_UK[c]}
        </label>
      {/each}
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
          <button
            type="button"
            class:primary={!settings.pushEnabled}
            onclick={() => ontogglepush(!settings.pushEnabled)}
          >
            {settings.pushEnabled ? uk.pushDisable : uk.pushEnable}
          </button>
        </div>
      {/if}
      {#if pushMessage}<p class="hint" role="status">{pushMessage}</p>{/if}
    </section>

    <section>
      <h3>{uk.soundsTitle}</h3>
      <p class="hint">{uk.soundsHint}</p>
      {#each categories as cat (cat.value)}
        <div class="sound">
          <label for={`sound-${cat.value}`}>{cat.label}</label>
          <select
            id={`sound-${cat.value}`}
            value={settings.sounds[cat.value]}
            onchange={(e) =>
              onchange({ sounds: { ...settings.sounds, [cat.value]: e.currentTarget.value as SoundId } })}
          >
            {#each sounds as snd (snd.value)}<option value={snd.value}>{snd.label}</option>{/each}
          </select>
          <button type="button" class="ghost" onclick={() => ontestsound(cat.value)}>{uk.test}</button>
        </div>
      {/each}
      <label class="check">
        <input type="checkbox" checked={settings.vibrate} onchange={(e) => onchange({ vibrate: e.currentTarget.checked })} />
        {uk.vibrate}
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.flash} onchange={(e) => onchange({ flash: e.currentTarget.checked })} />
        {uk.flash}
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.speak} onchange={(e) => onchange({ speak: e.currentTarget.checked })} />
        {uk.speak}
      </label>
    </section>

    <section>
      <h3>{uk.display}</h3>
      <div class="sound">
        <label for="linger">{uk.linger}</label>
        <select
          id="linger"
          value={String(settings.lingerMin)}
          onchange={(e) => onchange({ lingerMin: Number(e.currentTarget.value) })}
        >
          <option value="0">{uk.lingerNow}</option>
          {#each [2, 5, 10] as m (m)}<option value={String(m)}>{uk.lingerMin(m)}</option>{/each}
        </select>
      </div>
      <label class="check">
        <input type="checkbox" checked={settings.hotspots} onchange={(e) => onchange({ hotspots: e.currentTarget.checked })} />
        {uk.hotspots}
      </label>
      <h3 id="theme-label" class="sub">{uk.theme}</h3>
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
    max-height: min(90dvh, 820px);
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
    gap: 20px;
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
  h3.sub {
    margin-top: 12px;
  }
  .hint {
    margin: 4px 0;
    font-size: 13px;
    color: var(--muted);
  }
  .hint a {
    color: var(--muted);
    text-decoration: underline;
  }
  .value {
    margin: 6px 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  button,
  select {
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
    padding: 8px;
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
  .points {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .points li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 8px;
    border-radius: 10px;
    background: var(--chip);
  }
  .points input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: 600;
  }
  .coords {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .sound {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
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
    flex: none;
    accent-color: var(--accent);
  }
</style>
