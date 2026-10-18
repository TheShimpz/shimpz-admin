<script>
  import { onMount } from 'svelte';
  import { BrowserViewEndedError, watchBrowser } from './view.js';

  // The live screen of the Team's running Browser task (ADR-0117, M2 Watch), shown inline under the turn's progress so
  // the composer and Stop stay in reach. It only shows: the page cannot be clicked or typed into from here. Watching
  // stops when this view closes or the task ends, and every frame it held is released.
  let { teamId, labels } = $props();
  let source = $state('');
  let status = $state('waiting');

  onMount(() => {
    const controller = new AbortController();
    let shown = '';
    watchBrowser(teamId, {
      signal: controller.signal,
      onframe(blob) {
        const next = URL.createObjectURL(blob);
        if (shown) URL.revokeObjectURL(shown);
        shown = next;
        source = next;
        status = 'showing';
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      status = error instanceof BrowserViewEndedError ? 'ended' : 'failed';
    });
    return () => {
      controller.abort();
      if (shown) URL.revokeObjectURL(shown);
    };
  });
</script>

<figure class="browser-view" aria-label={labels.title}>
  {#if source}
    <img src={source} alt={labels.alt} draggable="false" />
  {/if}
  {#if status !== 'showing'}
    <p class="browser-view-status" role="status">{labels[status]}</p>
  {/if}
  <figcaption>{labels.note}</figcaption>
</figure>

<style>
  .browser-view {
    display: grid;
    gap: var(--gap-item);
    margin: var(--gap-item) 0 0;
    max-width: 100%;
  }

  img {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 1280 / 800;
    border: 1px solid var(--border);
    background: var(--surface-1);
    pointer-events: none;
    user-select: none;
  }

  .browser-view-status,
  figcaption {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }
</style>
