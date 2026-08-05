<script>
  import { Disclosure } from '@shimpz/frontend';
  import {
    executionSteps,
    executionStepCount,
    formatExecutionDuration,
    localizedStepLabel,
  } from './executionProgress.js';

  let {
    events = [],
    label = '{count} execution stages completed',
    progressLabels = {},
    teamName = 'Team',
    assistantNames = new Map(),
  } = $props();
  let open = $state(false);
  let steps = $derived(open ? executionSteps(events) : []);
  let stepCount = $derived(executionStepCount(events));
  let summaryLabel = $derived(countLabelParts(label));

  function countLabelParts(template) {
    const token = '{count}';
    const position = template.indexOf(token);
    if (position === -1) return { before: '', after: ` ${template}` };
    return {
      before: template.slice(0, position),
      after: template.slice(position + token.length),
    };
  }
</script>

{#if events.length > 0}
  <Disclosure class="receipt" bind:open>
    {#snippet summary()}{summaryLabel.before}<span class="step-count">{stepCount}</span>{summaryLabel.after}{/snippet}
    {#if open}
      <ol>
        {#each steps as step, index (step.key)}
          <li>
            <span class="step-number" aria-hidden="true">{index + 1}</span>
            <span class="step-copy">{localizedStepLabel(step, progressLabels, { teamName, assistantNames })}</span>
            <time>{formatExecutionDuration(step.elapsed_ms)}</time>
          </li>
        {/each}
      </ol>
    {/if}
  </Disclosure>
{/if}

<style>
  :global(.receipt.shimpz-disclosure) {
    margin-block-start: 0.85rem;
    border-block-start: 0;
    padding-block-start: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
  }

  :global(.receipt [data-slot="disclosure-trigger"]) {
    width: fit-content;
    color: var(--text-dim);
    cursor: pointer;
    letter-spacing: 0.055em;
    text-transform: uppercase;
  }

  .step-count,
  .step-number {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  ol {
    display: grid;
    margin: 0.7rem 0 0;
    padding: 0;
    gap: 0.35rem;
    list-style: none;
  }

  li {
    display: grid;
    min-width: 0;
    grid-template-columns: 1.2rem minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 1rem;
  }

  .step-number { text-align: end; }

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
