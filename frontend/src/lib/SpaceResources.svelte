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
  <p class="space-resources">
    {#each segments as segment, index (segment.label)}
      {#if index}<span aria-hidden="true">·</span>{/if}
      <span title={index === 0 ? $t('shell.resourceServicesTitle') : undefined}>{segment.label} {segment.value ?? '—'}</span>
    {/each}
  </p>
{/if}

<style>
  .space-resources { display: flex; flex-wrap: wrap; justify-content: center; gap: 0 var(--gap-inside); margin: 0; padding-inline: var(--gap-group); color: var(--shimpz-color-text-muted); font: 600 0.68rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.02em; }
  .space-resources span { white-space: nowrap; }
</style>
