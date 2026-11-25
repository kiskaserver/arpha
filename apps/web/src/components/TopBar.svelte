<script lang="ts">
import type { ActiveAlert } from '@arpha/shared'
import { uk } from '../lib/i18n'
import type { ConnectionStatus } from '../lib/stream'
import type { AlertLevel } from '../lib/view'

interface Props {
  level: AlertLevel
  alerts: ActiveAlert[]
  status: ConnectionStatus
  demo: boolean
}
let { level, alerts, status, demo }: Props = $props()
let open = $state(false)

const label = $derived(
  level === 'mine'
    ? uk.alertMine
    : level === 'region'
      ? uk.alertActive
      : level === 'none'
        ? uk.alertNone
        : uk.alertUnknown,
)
const connLabel = $derived(
  status === 'online'
    ? uk.connOnline
    : status === 'connecting'
      ? uk.connConnecting
      : uk.connOffline,
)
</script>

<header class="topbar">
  <div class="brand">
    <img src="/logo.svg" alt="" width="28" height="28" />
    <span class="name">{uk.appName}</span>
    {#if demo}<span class="demo" title={uk.demoHint}>{uk.demoBadge}</span>{/if}
  </div>

  <button
    class="alert {level}"
    type="button"
    aria-expanded={open}
    aria-label={label}
    onclick={() => (open = !open)}
    disabled={!alerts.length}
    data-testid="alert-chip"
  >
    <span class="pulse" aria-hidden="true"></span>
    <span class="text">{label}</span>
    {#if alerts.length > 1}<span class="count">{alerts.length}</span>{/if}
  </button>

  <span class="conn {status}" role="status" aria-live="polite" title={connLabel} data-testid="conn">
    <span class="dot" aria-hidden="true"></span>
    <span class="sr-only">{connLabel}</span>
  </span>

  {#if open && alerts.length}
    <ul class="alert-list" aria-label={uk.alertsList}>
      {#each alerts as a (a.id)}
        <li>{a.locationTitle}</li>
      {/each}
    </ul>
  {/if}
</header>

{#if status === 'offline'}
  <div class="offline" role="alert">{uk.connOffline}</div>
{/if}

<style>
  .topbar {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: calc(env(safe-area-inset-top) + 8px) 12px 8px;
    pointer-events: none;
    flex-wrap: wrap;
  }
  .topbar > * {
    pointer-events: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px 6px 6px;
    background: var(--panel);
    border-radius: 999px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
  }
  .name {
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .demo {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--accent);
    color: #111;
  }
  .alert {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 8px 14px;
    border: 0;
    border-radius: 999px;
    font: inherit;
    font-weight: 600;
    color: var(--text);
    background: var(--panel);
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
    cursor: pointer;
  }
  .alert:disabled {
    cursor: default;
  }
  .alert.mine,
  .alert.region {
    background: var(--danger);
    color: #fff;
  }
  .alert.region {
    background: color-mix(in srgb, var(--danger) 78%, #000);
  }
  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ok);
  }
  .alert.mine .pulse,
  .alert.region .pulse {
    background: #fff;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .alert.unknown .pulse {
    background: var(--muted);
  }
  .count {
    font-size: 12px;
    background: rgb(0 0 0 / 0.25);
    border-radius: 999px;
    padding: 0 7px;
  }
  .conn {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--panel);
    box-shadow: var(--shadow);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ok);
  }
  .conn.connecting .dot {
    background: var(--accent);
    animation: pulse 1s infinite;
  }
  .conn.offline .dot {
    background: var(--muted);
  }
  .alert-list {
    flex-basis: 100%;
    margin: 0 0 0 auto;
    max-width: 360px;
    padding: 8px 14px;
    list-style: none;
    background: var(--panel);
    border-radius: 14px;
    box-shadow: var(--shadow);
    font-size: 14px;
    max-height: 40vh;
    overflow: auto;
  }
  .alert-list li {
    padding: 4px 0;
  }
  .alert-list li::before {
    content: '● ';
    color: var(--danger);
  }
  .offline {
    position: absolute;
    top: calc(env(safe-area-inset-top) + 60px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    padding: 6px 12px;
    border-radius: 10px;
    background: var(--panel);
    box-shadow: var(--shadow);
    font-size: 13px;
    color: var(--muted);
    max-width: calc(100% - 32px);
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse,
    .dot {
      animation: none !important;
    }
  }
</style>
