<script>
  import { onMount, tick } from 'svelte';
  import { Button } from '@shimpz/frontend';
  import { assistantName } from '#lib/assistants/names.js';
  import BrowserWatch from '#lib/chat/browser/Watch.svelte';
  import { localizedStepLabel } from './projection.js';

  let {
    label,
    steps,
    currentIndex,
    elapsedText,
    progressLabels,
    // When the turn started (ms since the epoch): the turn owns it, so the count survives this view being shown again.
    startedAt,
    // The Team the turn runs in: while its Browser task runs, its screen shows here (ADR-0117).
    teamId = '',
    // The turn's place in the Space's chat queue while it waits, or null once it runs (ADR-0119).
    queuePosition = null,
  } = $props();
  let elapsed = $state(0);
  let watch = $state();
  let root = $state();

  let current = $derived(currentIndex >= 0 ? steps[currentIndex] : null);
  // The screen shows for as long as the turn's current step is its Browser task, and closes with it.
  let browsing = $derived(current?.phase === 'browser' && Boolean(teamId));
  // The seconds since the turn started, counting, right after the signal bars; the time's name is only its hover title.
  let formattedElapsed = $derived(`${elapsed} s`);

  // A screen that opens is brought to the top of the transcript, as a sent message is, so the reader follows the task
  // from its progress line without scrolling by hand.
  $effect(() => {
    if (!browsing) return;
    void tick().then(() => {
      if (!root?.isConnected) return;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      root.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    });
  });

  onMount(() => {
    const update = () => { elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  });
</script>

<div bind:this={root} class="thinking" role="group" aria-label={label}>
  <div class="summary">
    <span class="signal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="elapsed" title={elapsedText} aria-hidden="true">{formattedElapsed} ·</span>
    <span class="step-copy">{queuePosition !== null
      ? progressLabels.queued.replace('{position}', String(queuePosition))
      : current ? localizedStepLabel(current, progressLabels, { assistantName: $assistantName }) : progressLabels.awaiting}</span>
    {#if browsing}
      <Button
        class="fullscreen"
        variant="ghost"
        size="icon"
        type="button"
        onclick={() => watch?.enterFullscreen()}
        aria-label={progressLabels.watch.fullscreen}
        title={progressLabels.watch.fullscreen}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path></svg>
      </Button>
    {/if}
  </div>
  {#if browsing}
    <BrowserWatch bind:this={watch} {teamId} labels={progressLabels.watch} />
  {/if}
</div>

<style>
  .thinking {
    display: grid;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin-inline: auto;
    padding: var(--gap-group) 0;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  .summary {
    display: grid;
    min-width: 0;
    align-items: center;
    grid-template-columns: auto auto minmax(0, auto) auto;
    justify-content: start;
    gap: var(--gap-item);
  }

  /* Only the bars, the height of the line they lead. */
  .signal {
    display: flex;
    height: 1em;
    align-items: center;
    gap: 0.12rem; /* the signal bars' own geometry, not rhythm */
    font-size: 0.62rem;
  }

  .signal i {
    width: 0.12rem;
    height: 0.3em;
    border-radius: 0;
    background: var(--accent);
    box-shadow: 0 0 0.4rem color-mix(in srgb, var(--accent) 72%, transparent);
    animation: signal 1.1s ease-in-out infinite;
  }

  .signal i:nth-child(2) { animation-delay: 0.12s; }
  .signal i:nth-child(3) { animation-delay: 0.24s; }
  .signal i:nth-child(4) { animation-delay: 0.36s; }

  .step-copy,
  .elapsed {
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }

  .step-copy { min-width: 0; overflow-wrap: anywhere; }

  .elapsed {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* The icon alone, in the accent colour, so it stands out from the progress line; its box hugs the icon, keeping a
     24px target. */
  .summary :global(.fullscreen.fullscreen) {
    --button-border: transparent;
    --button-color: var(--shimpz-color-cyan);
    --button-hover-color: var(--shimpz-color-cyan);
    --button-height: 1.5rem;
    --button-padding-inline: 0.25rem;
  }

  .summary :global(.fullscreen svg) {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  @keyframes signal {
    0%, 100% { transform: scaleY(1); opacity: 0.35; }
    50% { transform: scaleY(calc(10 / 3)); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .signal i { animation: none; }
  }
</style>
