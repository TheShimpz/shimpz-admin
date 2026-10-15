<script>
  import { onMount } from 'svelte';
  import { assistantName } from '#lib/assistants/names.js';
  import { localizedStepLabel } from './projection.js';

  let {
    label,
    steps,
    currentIndex,
    elapsedText,
    progressLabels,
    // When the turn started (ms since the epoch): the turn owns it, so the count survives this view being shown again.
    startedAt,
  } = $props();
  let elapsed = $state(0);

  let current = $derived(currentIndex >= 0 ? steps[currentIndex] : null);
  // The seconds since the turn started, counting, right after the signal bars; the time's name is only its hover title.
  let formattedElapsed = $derived(`${elapsed} s`);

  onMount(() => {
    const update = () => { elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="thinking" role="group" aria-label={label}>
  <div class="summary">
    <span class="signal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="elapsed" title={elapsedText} aria-hidden="true">{formattedElapsed} ·</span>
    <span class="step-copy">{current ? localizedStepLabel(current, progressLabels, { assistantName: $assistantName }) : progressLabels.awaiting}</span>
  </div>
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
    grid-template-columns: auto auto minmax(0, auto);
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

  @keyframes signal {
    0%, 100% { transform: scaleY(1); opacity: 0.35; }
    50% { transform: scaleY(calc(10 / 3)); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .signal i { animation: none; }
  }
</style>
