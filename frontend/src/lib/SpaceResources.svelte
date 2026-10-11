<script>
  import { onMount } from 'svelte';
  import { locale, t } from '#lib/i18n.js';
  import { backgroundFetch } from '#lib/localApi.js';
  import { fetchSpaceResources, resourceSegments } from '#lib/spaceResources.js';

  const INTERVAL_MS = 30_000;
  let resources = $state(null);
  let pending = false;
  let segments = $derived(resources ? resourceSegments(resources, $locale, $t) : []);

  // One read at a time and only while the page is visible: a hidden page or a read still pending skips its turn.
  async function refresh() {
    if (pending || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      resources = await fetchSpaceResources(backgroundFetch);
    } catch {
      resources = null;
    } finally {
      pending = false;
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, INTERVAL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  });
</script>

{#if resources}
  <dl class="telemetry">
    {#each segments as segment, index (segment.label)}
      <div class="row {segment.level}" title={index === 0 ? $t('shell.resourceServicesTitle') : undefined}>
        <dt>{segment.label}</dt>
        <dd>{segment.value ?? '—'}</dd>
        <span
          class="bar"
          class:cells={segment.cells}
          style:--cells={segment.cells}
          style:--share={segment.ratio ?? 0}
          aria-hidden="true"
        ></span>
      </div>
    {/each}
  </dl>
{/if}

<style>
  .telemetry {
    --signal: var(--shimpz-color-cyan);
    display: grid;
    gap: 0.55rem;
    margin: 0;
    padding: 0.25rem var(--gap-group);
  }
  .row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 0.25rem var(--gap-inside); min-width: 0; }
  .row.warn { --signal: var(--shimpz-color-yellow); }
  .row.alert { --signal: var(--shimpz-color-danger); }
  .row.unknown { --signal: var(--shimpz-color-text-dim); }
  dt {
    overflow: hidden;
    color: var(--shimpz-color-text-dim);
    font: 700 0.6rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.14em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  dd {
    margin: 0;
    color: var(--signal);
    font: 600 0.68rem/1.2 var(--shimpz-font-mono);
    font-variant-numeric: tabular-nums;
    text-shadow: 0 0 6px color-mix(in srgb, var(--signal) 55%, transparent);
    white-space: nowrap;
  }
  .row.ok:not(:first-child) dd { color: var(--shimpz-color-text); text-shadow: none; }
  .bar {
    position: relative;
    grid-column: 1 / -1;
    height: 4px;
    background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--signal) 16%, transparent) 0 6px, transparent 6px 8px);
  }
  .bar::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--share) * 100%);
    background: repeating-linear-gradient(90deg, var(--signal) 0 6px, transparent 6px 8px);
    filter: drop-shadow(0 0 3px var(--signal));
    transition: width 600ms ease;
  }
  .bar.cells {
    background: linear-gradient(90deg, color-mix(in srgb, var(--signal) 16%, transparent) calc(100% - 2px), transparent 0)
      0 0 / calc(100% / var(--cells)) 100%;
  }
  .bar.cells::after {
    background: linear-gradient(90deg, var(--signal) calc(100% - 2px), transparent 0) 0 0 / calc(100% / (var(--cells) * var(--share))) 100%;
  }
  @media (prefers-reduced-motion: reduce) {
    .bar::after { transition: none; }
  }
</style>
