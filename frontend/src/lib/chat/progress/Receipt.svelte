<script>
  import { Disclosure } from '@shimpz/frontend';
  import { fill } from '#lib/i18n/fill.js';
  import { formatExecutionDuration, localizedStepLabel } from './projection.js';

  let {
    // The reply's receipt rows (chat/turns.js shownUsage), which add up to Team's measured duration of the turn.
    steps,
    // The announced step count, a template with `{count}`.
    label,
    progressLabels,
    teamName,
    assistantNames,
    // The reply's usage line, the visible summary; the step count is announced after it.
    line,
  } = $props();
  let open = $state(false);
</script>

<Disclosure class="receipt" bind:open>
  {#snippet summary()}
    {@render line()}<span class="sr-only"> · {fill(label, { count: steps.length })}</span>
  {/snippet}
  {#if open}
    <ol>
      {#each steps as step (step.key)}
        <li>
          <span class="tip">
            <span class="step-copy">{localizedStepLabel(step, progressLabels, { teamName, assistantNames })}</span>
            <time>{formatExecutionDuration(step.elapsed_ms)}</time>
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</Disclosure>

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

  /* The steps read like the Store's terminal tree, at the receipt's own size: a drawn trunk with a branch into each
     step at the middle of its line, and each step one readout in neutral ink with cut corners, its time last. */
  ol {
    margin: var(--gap-item) 0 0;
    padding: 0;
    list-style: none;
  }

  li {
    --tree: 2.4em;
    --trunk: 1.2em;
    /* The middle of a step's line: the readout's top padding plus half its line height. */
    --pad: 0.2em;
    --line: 1.4;
    --elbow: calc(var(--pad) + var(--line) * 0.5em);
    position: relative;
    display: grid;
    grid-template-columns: var(--tree) minmax(0, 1fr);
    align-items: start;
    padding-block-end: 0.15em;
  }

  li:last-child { padding-block-end: 0; }

  li::before,
  li::after {
    position: absolute;
    inset-inline-start: var(--trunk);
    background: color-mix(in oklab, var(--shimpz-color-text-dim) 38%, transparent);
    content: '';
  }

  li::before { top: 0; bottom: 0; width: 0.5px; }
  li:first-child::before { top: calc(-1 * var(--gap-item)); }
  li:last-child::before { bottom: auto; height: var(--elbow); }
  li:only-child::before { height: calc(var(--elbow) + var(--gap-item)); }
  li::after { top: var(--elbow); width: calc(var(--tree) - var(--trunk) - 2px); height: 0.5px; }

  .tip {
    --cut: 0.4rem;
    display: flex;
    grid-column: 2;
    align-items: baseline;
    justify-self: start;
    gap: var(--gap-item);
    max-width: 100%;
    padding: var(--pad) var(--gap-item);
    background: color-mix(in oklab, var(--shimpz-color-bg) 95%, var(--shimpz-color-text));
    line-height: var(--line);
    clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut)));
  }

  .step-copy {
    min-width: 0;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  time {
    flex: 0 0 auto;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
</style>
