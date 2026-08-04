<script>
  import {
    executionSteps,
    executionStepCount,
    formatExecutionDuration,
    localizedStepLabel,
  } from './executionProgress.js';

  let {
    events = [],
    label = 'Execution stages',
    progressLabels = {},
    teamName = 'Team',
    assistantNames = new Map(),
  } = $props();
  let open = $state(false);
  let steps = $derived(open ? executionSteps(events) : []);
  let stepCount = $derived(executionStepCount(events));
</script>

{#if events.length > 0}
  <details class="receipt" bind:open>
    <summary>{label} <span>{stepCount}</span></summary>
    {#if open}
      <ol>
        {#each steps as step (step.key)}
          <li>
            <span class="step-copy">{localizedStepLabel(step, progressLabels, { teamName, assistantNames })}</span>
            <time>{formatExecutionDuration(step.elapsed_ms)}</time>
          </li>
        {/each}
      </ol>
    {/if}
  </details>
{/if}

<style>
  .receipt {
    margin-block-start: 0.85rem;
    border-block-start: 1px solid var(--admin-divider);
    padding-block-start: 0.65rem;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
  }

  summary {
    width: fit-content;
    color: var(--text-dim);
    cursor: pointer;
    letter-spacing: 0.055em;
    text-transform: uppercase;
  }

  summary span { color: var(--accent); }

  ol {
    display: grid;
    margin: 0.7rem 0 0;
    padding: 0;
    gap: 0.35rem;
    list-style: none;
  }

  li {
    display: flex;
    min-width: 0;
    justify-content: space-between;
    gap: 1rem;
  }

  .step-copy {
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  time {
    flex: 0 0 auto;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
</style>
