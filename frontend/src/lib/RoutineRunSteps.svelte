<script>
  import { Button } from '@shimpz/frontend';
  import { tick, untrack } from 'svelte';

  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { conditionWords, fillRoutineCopy, humanizeId, literalWords, needsPage, readRunSteps } from '$lib/routine.js';
  import { durationWords, visibleSteps } from '$lib/routineResult.js';

  // The steps of one Routine run as the run recorded them (ADR-0092 amendment, 2026-10-05, scale), numbered in order:
  // each step's Action and Assistant, what happened to it, how long its attempt took, the inputs that attempt was
  // given as Team's redacted previews, and the failed attempts Team recorded for it. A step with no record says plainly
  // that it did not run or that its record is unavailable. The records are read page by page for one snapshot of them,
  // bound to the revision the run carried out; a snapshot that changed meanwhile is read again from the newest. A long
  // run reveals its steps a few at a time. Every value is escaped text.
  let { teamId, runId, plan, attempts = null, copy, names = {}, locale, pageSize = 10 } = $props();

  const ICONS = {
    done: 'check', recovered: 'check', failed: 'failed', stopped: 'stop', waiting: 'approval', not_run: 'skip', unavailable: 'warning',
  };
  // A changed snapshot is read again from the newest this many times before the steps are said to be unavailable.
  const RESTARTS = 2;

  let steps = $state([]);
  let next = $state(0);
  let snapshot = 'latest';
  let pages = $state(1);
  let loading = $state(false);
  let failed = $state(false);
  let list = $state();
  // Only the newest read of this run may apply.
  let reading = 0;

  let shown = $derived(visibleSteps(steps, pages, pageSize));
  let remaining = $derived(plan.steps - shown.length);

  const assistantName = (assistant) => names[assistant] ?? humanizeId(assistant);
  const plural = (forms, count) => fillRoutineCopy(
    new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other,
    { count: new Intl.NumberFormat(locale).format(count) },
  );

  function restart() {
    steps = [];
    next = 0;
    snapshot = 'latest';
  }

  // Read pages of one snapshot until `wanted` steps are loaded or the run has no more.
  async function load(wanted) {
    const ticket = reading;
    loading = true;
    let restarts = 0;
    try {
      while (ticket === reading && needsPage(steps.length, wanted, next)) {
        let page;
        try {
          page = await readRunSteps(fetch, teamId, runId, plan, snapshot, next);
        } catch (error) {
          if (error?.code !== 'routine-run-changed' || restarts === RESTARTS) throw error;
          restarts += 1;
          if (ticket === reading) restart();
          continue;
        }
        if (ticket !== reading) return;
        steps = [...steps, ...page.steps];
        next = page.next;
        snapshot = page.snapshot;
      }
    } catch {
      if (ticket === reading) failed = true;
    } finally {
      if (ticket === reading) loading = false;
    }
  }

  $effect(() => {
    void `${teamId}:${runId}:${plan.plan_digest}`;
    untrack(() => {
      reading += 1;
      restart();
      pages = 1;
      failed = false;
      void load(pageSize);
    });
  });

  // Revealing more steps reads the pages they need, then moves focus to the first one revealed.
  async function more() {
    const first = shown.length;
    pages += 1;
    await load(pages * pageSize);
    await tick();
    list?.querySelectorAll(':scope > li')[first]?.focus();
  }
</script>

{#snippet attempt(item, named)}
  <li class="attempt">
    <div class="attempt-head">
      <span class="mono">{named
        ? fillRoutineCopy(copy.details.attempt, { assistant: assistantName(item.assistant_id), action: humanizeId(item.action), attempt: item.attempt })
        : fillRoutineCopy(copy.result.attempt, { attempt: item.attempt })}</span>
      {#if item.failure?.http_status}<span class="mono">HTTP {item.failure.http_status}</span>{/if}
      {#if item.failure}<code>{item.failure.error_type}</code>{/if}
    </div>
    {#if item.failure}
      {#if item.failure.message}<div class="message">{item.failure.message}</div>{/if}
      {#if item.failure.redacted}<div class="dim">{copy.details.redacted}</div>{/if}
      {#if item.failure.truncated}<div class="dim">{copy.details.truncated}</div>{/if}
    {:else}
      <div class="message">{conditionWords(item.condition, copy.details)}</div>
    {/if}
  </li>
{/snippet}

<ol class="steps" bind:this={list}>
  {#each shown as step (step.position)}
    <li class={['step', `step--${step.status}`]} tabindex="-1">
      <span class="number" aria-hidden="true">{String(step.position).padStart(2, '0')}</span>
      <div class="body">
        {#if step.action}
          <div class="head">
            <span class="action">{humanizeId(step.action)}</span>
            <span class="assistant">{assistantName(step.assistant_id)}</span>
          </div>
        {/if}
        <div class="status">
          <RoutineIcon name={ICONS[step.status]} /><span class="word">{copy.result.status[step.status]}</span>
          {#if step.duration_ms !== null}<span class="when">{durationWords(step.duration_ms, locale)}</span>{/if}
          {#if step.attempt > 1}<span class="when">{fillRoutineCopy(copy.result.attempt, { attempt: step.attempt })}</span>{/if}
        </div>
        {#if step.action}
          {#if step.inputs === null}
            <div class="dim">{copy.result.inputsUnavailable}</div>
          {:else if step.inputs.length > 0}
            <dl class="inputs">
              {#each step.inputs as input (input.member)}
                <div>
                  <dt>{humanizeId(input.member)}</dt>
                  <dd>{input.value === null ? copy.notice.output.redacted : literalWords(input.value)}</dd>
                </div>
              {/each}
            </dl>
          {:else}
            <div class="dim">{copy.result.noInputs}</div>
          {/if}
        {/if}
        {#if attempts?.byStep.get(step.position)?.length}
          <div class="attempts">
            <div class="attempts-title">{plural(copy.result.attempts, attempts.byStep.get(step.position).length)}</div>
            <ul>{#each attempts.byStep.get(step.position) as item (`${item.operation_id}:${item.attempt}`)}{@render attempt(item, false)}{/each}</ul>
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
{#if failed}
  <div class="dim">{copy.result.stepsUnavailable}</div>
{:else if loading}
  <div class="dim" role="status">{copy.result.stepsLoading}</div>
{:else if remaining > 0}
  <Button class="more" variant="ghost" size="sm" type="button" onclick={more}>
    {plural(copy.result.more, Math.min(pageSize, remaining))}
  </Button>
{/if}
{#if attempts?.apart.length}
  <div class="attempts apart">
    <div class="attempts-title">{copy.result.attemptsApart}</div>
    <ul>{#each attempts.apart as item (`${item.operation_id}:${item.attempt}`)}{@render attempt(item, true)}{/each}</ul>
  </div>
{/if}

<style>
  /* Numbered rows joined by one hairline rail: a mono number, the Action with its Assistant, a quiet status, then
     the parameters as mono key and value pairs. */
  .steps { display: grid; margin: 0; padding: 0; list-style: none; }
  .step {
    position: relative;
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr);
    gap: var(--shimpz-space-3);
    padding-block: 0 var(--shimpz-space-4);
    outline-offset: 2px;
  }
  .step:not(:last-child)::before {
    position: absolute;
    inset-block: 1.6rem 0.4rem;
    inset-inline-start: 0.7rem;
    width: 1px;
    background: var(--shimpz-color-border-subtle);
    content: '';
  }
  .number { color: var(--shimpz-color-cyan); font: 600 0.75rem/1.6 var(--shimpz-font-mono); }
  .body { display: grid; gap: 0.35rem; min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1rem 0.6rem; }
  .action { color: var(--shimpz-color-text); font-weight: 600; overflow-wrap: anywhere; }
  .assistant { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .status { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; color: var(--shimpz-color-text-muted); font: 600 0.62rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .status .word { display: inline-flex; align-items: center; }
  .status .when { color: var(--shimpz-color-text-dim); font-weight: 400; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }
  .status :global(.routine-icon) { width: 0.8rem; height: 0.8rem; color: var(--shimpz-color-cyan); }
  .step--failed .status :global(.routine-icon) { color: var(--shimpz-color-danger); }
  .step--stopped .status :global(.routine-icon) { color: var(--shimpz-color-text-muted); }
  .step--waiting .status :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  .step--not_run .status :global(.routine-icon),
  .step--unavailable .status :global(.routine-icon) { color: var(--shimpz-color-text-dim); }
  .inputs { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.2rem 0.75rem; margin: 0.15rem 0 0; font-size: 0.78rem; }
  .inputs > div { display: contents; }
  dt { color: var(--shimpz-color-text-dim); }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.76rem; overflow-wrap: anywhere; }
  .dim { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .attempts { display: grid; gap: 0.35rem; margin-block-start: 0.25rem; padding: 0.5rem 0.65rem; border-inline-start: 2px solid var(--shimpz-color-border); background: rgb(255 255 255 / 0.015); }
  .attempts.apart { margin-block-start: var(--shimpz-space-2); }
  .attempts-title { color: var(--shimpz-color-text-muted); font-size: 0.75rem; }
  .attempts ul { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  .attempt { display: grid; gap: 0.15rem; font-size: 0.75rem; }
  .attempt-head { display: flex; flex-wrap: wrap; gap: 0.1rem 0.6rem; color: var(--shimpz-color-text-muted); }
  .mono, code { font: 0.72rem/1.5 var(--shimpz-font-mono); }
  code { color: var(--shimpz-color-text-dim); }
  .message { color: var(--shimpz-color-text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  :global(.shimpz-button.more) { justify-self: start; }
</style>
