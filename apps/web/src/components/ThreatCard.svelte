<script lang="ts">
import { formatMinutesUk, threatLabelUk } from '@arpha/shared'
import {
  formatAgo,
  formatClock,
  formatCourse,
  formatDistance,
  formatEta,
  formatSpeed,
} from '../lib/format'
import { uk } from '../lib/i18n'
import type { ThreatRow } from '../lib/view'
import ThreatIcon from './ThreatIcon.svelte'

interface Props {
  row: ThreatRow
  now: number
  onclose: () => void
}
let { row, now, onclose }: Props = $props()
const t = $derived(row.track)
const a = $derived(row.approach)
</script>

<article class="card" aria-labelledby="card-title" data-testid="threat-card">
  <header>
    <ThreatIcon type={t.type} heading={t.headingDeg} size={44} />
    <div class="title">
      <h2 id="card-title">{threatLabelUk(t.type, t.count)}</h2>
      <p class="sub">
        {#if t.status === 'destroyed'}<span class="badge ok">{uk.statusDestroyed}</span>
        {:else if t.status === 'lost'}<span class="badge">{uk.statusLost}</span>{/if}
        {uk.updated} {formatAgo(t.updatedAt, now)}
      </p>
    </div>
    <button class="close" type="button" onclick={onclose} aria-label={uk.close}>✕</button>
  </header>

  <dl>
    {#if t.status === 'active' && a}
      <div class="eta" class:hot={a.etaMin !== null}>
        <dt>{uk.eta}</dt>
        <dd data-testid="card-eta">{formatEta(a.etaMin)}</dd>
      </div>
    {:else if t.status === 'active' && t.target}
      <div class="eta hot">
        <dt>{uk.target}</dt>
        <dd>{t.target.name}</dd>
      </div>
    {/if}
    {#if a}
      <div>
        <dt>{uk.distance}</dt>
        <dd>
          {formatDistance(a.distanceKm)}
          <small>· {a.approaching ? uk.approaching : t.speedKmh ? uk.receding : uk.stationary}</small>
        </dd>
      </div>
      {#if a.approaching && a.etaMin === null}
        <div>
          <dt>{uk.closest}</dt>
          <dd>{uk.closestIn(formatMinutesUk(a.closestInMin), Math.round(a.closestKm))}</dd>
        </div>
      {/if}
    {/if}
    <div><dt>{uk.speed}</dt><dd>{formatSpeed(t)}</dd></div>
    <div><dt>{uk.course}</dt><dd>{formatCourse(t)}</dd></div>
    {#if t.placeName}<div><dt>{uk.place}</dt><dd>{t.placeName}</dd></div>{/if}
    {#if t.target && a}<div><dt>{uk.target}</dt><dd>{t.target.name}</dd></div>{/if}
    <div><dt>{uk.confidence}</dt><dd>{Math.round(t.confidence * 100)}%</dd></div>
  </dl>

  {#if t.sources.length}
    <section class="sources">
      <h3>{uk.sources}</h3>
      <ul>
        {#each t.sources as s (s.channel + s.messageId)}
          <li>
            <div class="src-head">
              {#if s.channel === 'demo'}
                <span>{s.channelTitle}</span>
              {:else}
                <a href={`https://t.me/${s.channel}/${s.messageId}`} target="_blank" rel="noopener noreferrer"
                  >{s.channelTitle}</a
                >
              {/if}
              <time datetime={new Date(s.at).toISOString()}>{formatClock(s.at)}</time>
            </div>
            <p>{s.text}</p>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .sub {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--muted);
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    margin-right: 4px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    background: var(--chip);
  }
  .badge.ok {
    background: var(--ok);
    color: #04210f;
  }
  .close {
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: var(--chip);
    color: var(--text);
    font-size: 16px;
    cursor: pointer;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    margin: 0;
  }
  dl > div {
    min-width: 0;
  }
  dt {
    font-size: 12px;
    color: var(--muted);
  }
  dd {
    margin: 2px 0 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  small {
    font-weight: 400;
    color: var(--muted);
  }
  .eta {
    grid-column: 1 / -1;
  }
  .eta dd {
    font-size: 22px;
  }
  .eta.hot dd {
    color: var(--danger);
  }
  .sources h3 {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--muted);
    font-weight: 600;
  }
  .sources ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sources li {
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--chip);
    font-size: 14px;
  }
  .src-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .src-head a {
    color: var(--link);
  }
  .sources p {
    margin: 4px 0 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
