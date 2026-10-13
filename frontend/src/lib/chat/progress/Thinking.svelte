<script>
  import { Disclosure } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import {
    formatExecutionDuration,
    localizedStepLabel,
  } from './projection.js';

  let {
    label = 'I’m processing…',
    steps = [],
    currentIndex = -1,
    elapsedText = 'Elapsed time',
    stagesText = 'Execution stages',
    progressLabels = {},
    teamName = 'Team',
    assistantNames = new Map(),
    // When the turn started (ms since the epoch): the turn owns it, so the count survives this view being shown again.
    startedAt = Date.now(),
  } = $props();
  let elapsed = $state(0);

  let visibleSteps = $derived(steps.slice(-32));
  let current = $derived(currentIndex >= 0 ? steps[currentIndex] : null);
  // The seconds since the turn started, counting, beside the stage count; the time's name is only its hover title.
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
    <span class="step-copy">{current ? localizedStepLabel(current, progressLabels, { teamName, assistantNames }) : (progressLabels.awaiting ?? label)}</span>
  </div>

  {#if visibleSteps.length === 0}
    <span class="elapsed" title={elapsedText} aria-hidden="true">{formattedElapsed}</span>
  {:else}
    <Disclosure class="ledger-details">
      <!-- The triangle, the count, and the counting seconds are enough to see; the stages' name is announced, not shown. -->
      {#snippet summary()}<span class="sr-only">{stagesText} </span><span class="count">{visibleSteps.length}</span><span class="elapsed beside" title={elapsedText} aria-hidden="true">· {formattedElapsed}</span>{/snippet}
      <ol class="ledger" aria-label={stagesText}>
        {#each visibleSteps as step (step.key)}
          <li class:active={step.elapsed_ms === null} class:complete={step.elapsed_ms !== null}>
            <i aria-hidden="true"></i>
            <span class="step-copy">{localizedStepLabel(step, progressLabels, { teamName, assistantNames })}</span>
            {#if step.elapsed_ms === null}
              <span class="activity" aria-hidden="true"></span>
            {:else}
              <time>{formatExecutionDuration(step.elapsed_ms)}</time>
            {/if}
          </li>
        {/each}
      </ol>
    </Disclosure>
  {/if}
</div>

<style>
  .thinking {
    display: grid;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    gap: var(--gap-inside);
    margin-inline: auto;
    padding: var(--gap-group) 0;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  .summary {
    display: grid;
    min-width: 0;
    align-items: center;
    grid-template-columns: auto minmax(0, 1fr);
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

  .summary .step-copy,
  .elapsed {
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }

  .elapsed {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    text-transform: none;
  }

  .elapsed.beside { margin-inline-start: 0.5em; }

  :global(.ledger-details.shimpz-disclosure) {
    min-width: 0;
    border-block-start: 0;
    padding-block-start: 0;
  }

  :global(.ledger-details [data-slot="disclosure-trigger"]) {
    width: fit-content;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.58rem;
    letter-spacing: 0.055em;
    text-transform: uppercase;
  }

  .count {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .ledger {
    display: grid;
    min-width: 0;
    margin: var(--gap-item) 0 0;
    padding: 0;
    gap: var(--gap-item);
    list-style: none;
  }

  .ledger li {
    display: grid;
    min-width: 0;
    grid-template-columns: 0.55rem minmax(0, 1fr) minmax(4rem, 20%);
    align-items: center;
    gap: var(--gap-item);
    color: var(--text-faint);
  }

  .ledger li > i {
    width: 0.45rem;
    height: 0.45rem;
    border: 1px solid var(--admin-divider);
    border-radius: 50%;
    background: var(--surface-1);
  }

  .ledger .step-copy,
  .ledger time {
    min-width: 0;
    font-size: 0.56rem;
    letter-spacing: 0.045em;
    overflow-wrap: anywhere;
  }

  .ledger time {
    justify-self: end;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .ledger li.complete > i,
  .ledger li.active > i {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 0.38rem color-mix(in srgb, var(--accent) 65%, transparent);
  }

  .activity {
    position: relative;
    height: 1px;
    overflow: hidden;
    background: var(--admin-divider);
  }

  .activity::after {
    position: absolute;
    inset: 0 auto 0 0;
    width: 38%;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    content: '';
    animation: travel 1.2s ease-in-out infinite;
  }

  @keyframes signal {
    0%, 100% { transform: scaleY(1); opacity: 0.35; }
    50% { transform: scaleY(calc(10 / 3)); opacity: 1; }
  }

  @keyframes travel {
    from { transform: translateX(-110%); }
    to { transform: translateX(365%); }
  }

  @media (max-width: 520px) {
    .ledger li { grid-template-columns: 0.55rem minmax(0, 1fr) 3.5rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .signal i,
    .activity::after {
      animation: none;
    }

    .activity::after { width: 100%; opacity: 0.7; }
  }
</style>
