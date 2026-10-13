<script>
  import { Disclosure } from '@shimpz/frontend';
  import {
    formatExecutionDuration,
    localizedStepLabel,
    receiptSteps,
  } from './projection.js';

  let {
    events = [],
    label = 'Execution stages recorded: {count}',
    progressLabels = {},
    teamName = 'Team',
    assistantNames = new Map(),
    // The reply's usage line: when given, it is the visible summary and the step count is announced after it.
    line = undefined,
    // Team's measured duration of the turn, which the receipt's rows add up to exactly.
    durationMs = undefined,
  } = $props();
  let open = $state(false);
  let steps = $derived(receiptSteps(events, durationMs));
  let stepCount = $derived(steps.length);
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

{#if stepCount > 0}
  <Disclosure class="receipt" bind:open>
    {#snippet summary()}
      {#if line}
        {@render line()}<span class="sr-only"> · {summaryLabel.before}{stepCount}{summaryLabel.after}</span>
      {:else}
        {summaryLabel.before}<span class="step-count">{stepCount}</span>{summaryLabel.after}
      {/if}
    {/snippet}
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
    margin-block-start: var(--gap-group);
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
    margin: var(--gap-item) 0 0;
    padding: 0;
    gap: var(--gap-item);
    list-style: none;
  }

  li {
    display: grid;
    min-width: 0;
    grid-template-columns: 1.2rem minmax(0, 1fr) auto;
    align-items: baseline;
    gap: var(--gap-item);
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
