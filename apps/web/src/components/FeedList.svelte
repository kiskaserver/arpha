<script lang="ts">
  import type { FeedItem } from '@arpha/shared'
  import { uk } from '../lib/i18n'
  import SourceChip from './SourceChip.svelte'
  import ThreatIcon from './ThreatIcon.svelte'

  interface Props {
    items: FeedItem[]
    onselect: (trackId: string) => void
  }
  let { items, onselect }: Props = $props()
</script>

<ul class="feed" data-testid="feed">
  {#each items as item (item.key)}
    <li>
      <div class="head">
        <SourceChip channel={item.channel} title={item.channelTitle} messageId={item.messageId} at={item.at} />
        <span class="icons">
          {#each item.types.slice(0, 3) as t (t)}<ThreatIcon type={t} size={20} />{/each}
        </span>
      </div>
      {#if item.trackIds[0]}
        <button type="button" class="text" onclick={() => onselect(item.trackIds[0]!)}>{item.text}</button>
      {:else}
        <p class="text">{item.text}</p>
      {/if}
    </li>
  {:else}
    <li class="empty">{uk.feedEmpty}</li>
  {/each}
</ul>

<style>
  .feed {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    padding: 8px 10px;
    border-radius: 12px;
    background: var(--chip);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .icons {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .text {
    display: block;
    width: 100%;
    margin: 6px 0 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 14px;
    text-align: left;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  button.text {
    cursor: pointer;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    background: none;
  }
</style>
