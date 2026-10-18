<script>
  import { onMount } from 'svelte';
  import { BrowserViewEndedError, watchBrowser } from './view.js';

  // The live screen of the Team's running Browser task (ADR-0117, over KasmVNC), shown inline under the turn's progress
  // so the composer and Stop stay in reach. noVNC draws it on a bare canvas in view-only mode: nothing here can click
  // or type into the page. Watching stops when this view closes, the step changes, or the task ends. The client loads
  // only when a person watches.
  let { teamId, labels } = $props();
  let screen = $state();
  let status = $state('waiting');

  onMount(() => {
    const controller = new AbortController();
    import('@novnc/novnc')
      .then(({ default: RFB }) => watchBrowser(teamId, {
        signal: controller.signal,
        target: screen,
        RFB,
        onconnect() {
          if (!controller.signal.aborted) status = 'showing';
        },
      }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        status = error instanceof BrowserViewEndedError ? 'ended' : 'failed';
      });
    return () => controller.abort(new DOMException('The view closed.', 'AbortError'));
  });
</script>

<figure class="browser-view" aria-label={labels.title}>
  <div class="screen" bind:this={screen} role="img" aria-label={labels.alt}></div>
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

  /* noVNC fills this box and scales the screen to it; the page receives no pointer or focus from here. */
  .screen {
    width: 100%;
    aspect-ratio: 1280 / 800;
    overflow: hidden;
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
