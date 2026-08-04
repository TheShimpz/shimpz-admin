<script>
  import { onMount } from 'svelte';
  import {
    executionSteps,
    formatExecutionDuration,
    localizedStepLabel,
  } from './executionProgress.js';

  let {
    label = 'Your Team is thinking…',
    events = [],
    elapsedText = 'Elapsed time',
    stagesText = 'Execution stages',
    progressLabels = {},
    teamName = 'Team',
    assistantNames = new Map(),
  } = $props();
  let elapsed = $state(0);

  let steps = $derived(executionSteps(events));
  let visibleSteps = $derived(steps.slice(-32));
  let current = $derived(steps.findLast((step) => step.elapsed_ms === null));
  let formattedElapsed = $derived(elapsedLabel(elapsed));

  function elapsedLabel(value) {
    const minutes = Math.floor(value / 60);
    const seconds = String(value % 60).padStart(2, '0');
    return `${String(minutes).padStart(2, '0')}:${seconds}`;
  }

  onMount(() => {
    const startedAt = Date.now();
    const update = () => { elapsed = Math.floor((Date.now() - startedAt) / 1000); };
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="thinking" role="group" aria-label={label}>
  <div class="summary">
    <span class="signal" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="copy">
      <strong>{label}</strong>
      <span class="step-copy">{current ? localizedStepLabel(current, progressLabels, { teamName, assistantNames }) : (progressLabels.awaiting ?? 'Waiting for execution')}</span>
    </span>
    <span class="elapsed" aria-hidden="true">{elapsedText} · {formattedElapsed}</span>
  </div>

  {#if visibleSteps.length > 0}
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
  {/if}
</div>

<style>
  .thinking {
    display: grid;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    gap: 0.9rem;
    margin-inline: auto;
    padding: 1rem 0;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  .summary {
    display: grid;
    min-width: 0;
    align-items: center;
    grid-template-columns: 2.7rem minmax(0, 1fr) auto;
    gap: 0.8rem;
  }

  .signal {
    display: flex;
    height: 2rem;
    align-items: center;
    justify-content: center;
    gap: 0.16rem;
    border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
    clip-path: polygon(0.4rem 0, 100% 0, 100% calc(100% - 0.4rem), calc(100% - 0.4rem) 100%, 0 100%, 0 0.4rem);
  }

  .signal i {
    width: 0.14rem;
    height: 0.3rem;
    background: var(--accent);
    box-shadow: 0 0 0.4rem color-mix(in srgb, var(--accent) 72%, transparent);
    animation: signal 1.1s ease-in-out infinite;
  }

  .signal i:nth-child(2) { animation-delay: 0.12s; }
  .signal i:nth-child(3) { animation-delay: 0.24s; }
  .signal i:nth-child(4) { animation-delay: 0.36s; }

  .copy {
    display: grid;
    min-width: 0;
    gap: 0.2rem;
  }

  .copy strong {
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.045em;
  }

  .copy .step-copy,
  .elapsed {
    color: var(--text-dim);
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }

  .elapsed {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .ledger {
    display: grid;
    min-width: 0;
    margin: 0;
    padding: 0;
    gap: 0.45rem;
    list-style: none;
  }

  .ledger li {
    display: grid;
    min-width: 0;
    grid-template-columns: 0.55rem minmax(0, 1fr) minmax(4rem, 20%);
    align-items: center;
    gap: 0.65rem;
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
    0%, 100% { height: 0.3rem; opacity: 0.35; }
    50% { height: 1rem; opacity: 1; }
  }

  @keyframes travel {
    from { transform: translateX(-110%); }
    to { transform: translateX(365%); }
  }

  @media (max-width: 520px) {
    .summary { grid-template-columns: 2.5rem minmax(0, 1fr); }
    .elapsed { grid-column: 2; }
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
