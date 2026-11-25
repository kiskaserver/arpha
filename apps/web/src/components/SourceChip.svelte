<script lang="ts">
  import { formatClock } from '../lib/format'
  import { uk } from '../lib/i18n'

  interface Props {
    channel: string
    title: string
    messageId: number
    at: number
  }
  let { channel, title, messageId, at }: Props = $props()
  const linkable = $derived(channel !== 'demo')
</script>

{#if linkable}
  <a
    class="chip"
    href={`https://t.me/${channel}/${messageId}`}
    target="_blank"
    rel="noopener noreferrer"
    title={uk.openInTelegram}
  >
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
      ><path
        fill="currentColor"
        d="M21.5 4.2 2.9 11.4c-1.3.5-1.3 1.2-.2 1.5l4.8 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.5-1.4zM9.8 14.4l-.4 4 -1.4-4.6 10.4-6.6z"
      /></svg
    >
    <span class="name">{title}</span>
    <time datetime={new Date(at).toISOString()}>{formatClock(at)}</time>
  </a>
{:else}
  <span class="chip">
    <span class="name">{title}</span>
    <time datetime={new Date(at).toISOString()}>{formatClock(at)}</time>
  </span>
{/if}

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 3px 9px 3px 7px;
    border-radius: 999px;
    background: var(--chip-strong);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
  }
  a.chip:hover {
    color: var(--text);
  }
  svg {
    flex: none;
    color: #2aabee;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  time {
    flex: none;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
</style>
