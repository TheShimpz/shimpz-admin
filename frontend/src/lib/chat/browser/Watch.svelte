<script>
  import { onMount } from 'svelte';
  import { Button } from '@shimpz/frontend';
  import { BrowserViewEndedError, watchBrowser } from './view.js';

  // The live screen of the Team's running Browser task (ADR-0117, over KasmVNC), shown inline under the turn's progress
  // so the composer and Stop stay in reach. noVNC draws it on a bare canvas in view-only mode: nothing here can click
  // or type into the page. Watching stops when this view closes, the step changes, or the task ends. The client loads
  // only when a person watches.
  let { teamId, labels } = $props();
  let screen = $state();
  let stage = $state();
  let fullscreen = $state(false);
  let status = $state('waiting');

  /** Show the screen alone over the whole display, keeping its proportions; its own button or Esc returns it. */
  export function enterFullscreen() {
    stage?.requestFullscreen().catch(() => {});
  }

  function exitFullscreen() {
    document.exitFullscreen().catch(() => {});
  }

  onMount(() => {
    const follow = () => {
      fullscreen = document.fullscreenElement === stage;
    };
    document.addEventListener('fullscreenchange', follow);
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
    return () => {
      document.removeEventListener('fullscreenchange', follow);
      if (document.fullscreenElement === stage) exitFullscreen();
      controller.abort(new DOMException('The view closed.', 'AbortError'));
    };
  });
</script>

<figure class="browser-view" aria-label={labels.title}>
  <div class="stage" bind:this={stage}>
    <div class="screen" bind:this={screen} role="img" aria-label={labels.alt}></div>
    {#if fullscreen}
      <Button
        class="exit"
        variant="ghost"
        size="icon"
        type="button"
        onclick={exitFullscreen}
        aria-label={labels.exitFullscreen}
        title={labels.exitFullscreen}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"></path></svg>
      </Button>
    {/if}
  </div>
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

  /* noVNC fills this box and scales the screen to it; the page receives no pointer or focus from here. Until the
     first screen arrives, the box shows a soft diagonal blend. */
  .screen {
    width: 100%;
    aspect-ratio: 1280 / 800;
    overflow: hidden;
    border: 1px solid var(--border);
    background: linear-gradient(135deg, #f4f4f0 0%, #3c78dc 100%);
    pointer-events: none;
    user-select: none;
  }

  .stage {
    position: relative;
    min-width: 0;
  }

  /* Full screen shows the page alone on black, as large as the display allows with its proportions kept. */
  .stage:fullscreen {
    display: grid;
    place-items: center;
    background: #000;
  }

  .stage:fullscreen .screen {
    width: min(100vw, calc(100vh * 1280 / 800));
    border: 0;
  }

  .stage :global(.exit) {
    position: absolute;
    top: var(--gap-item);
    right: var(--gap-item);
  }

  .stage :global(.exit svg) {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .browser-view-status,
  figcaption {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }
</style>
