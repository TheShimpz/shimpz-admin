<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { conditionWords, fillRoutineCopy, humanizeId, inputWords } from '$lib/routine.js';
  import { visibleSteps } from '$lib/routineResult.js';

  // The steps of one Routine run (ADR-0092), numbered in order: each step's Action and Assistant, what happened to it,
  // the parameters of its Routine's current plan when Team lists them, its saved keys by name only, and the failed
  // attempts Team recorded for it. A long run reveals its steps a page at a time. Every value is escaped text.
  let { steps, status, attempts = null, copy, names = {}, locale, pageSize = 10 } = $props();

  let pages = $state(1);
  let list = $state();
  let shown = $derived(visibleSteps(steps, pages, pageSize));
  let remaining = $derived(steps.length - shown.length);
  let positions = $derived(new Map(steps.filter((step) => step.id).map((step) => [step.id, step.n])));

  const assistantName = (assistant) => names[assistant] ?? humanizeId(assistant);
  const plural = (forms, count) => fillRoutineCopy(
    new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other,
    { count: new Intl.NumberFormat(locale).format(count) },
  );

  // Revealing more steps moves focus to the first one revealed, so the person keeps their place.
  async function more() {
    const first = shown.length;
    pages += 1;
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
  {#each shown as step (step.n)}
    <li class="step" tabindex="-1">
      <span class="number" aria-hidden="true">{String(step.n).padStart(2, '0')}</span>
      <div class="body">
        <div class="head">
          <span class="action">{humanizeId(step.action)}</span>
          <span class="assistant">{assistantName(step.assistant)}</span>
        </div>
        <div class="status"><RoutineIcon name="check" />{status}</div>
        {#if step.inputs !== null}
          {#if step.inputs.length > 0 || step.stored.length > 0}
            <dl class="inputs">
              {#each step.inputs as input (input.member)}
                <div><dt>{humanizeId(input.member)}</dt><dd>{inputWords(input, positions, copy.plan)}</dd></div>
              {/each}
              {#each step.stored as name (name)}
                <div class="stored">
                  <dt><RoutineIcon name="lock" /><span class="sr-only">{fillRoutineCopy(copy.plan.storedInput, { name })}</span></dt>
                  <dd aria-hidden="true">{name}</dd>
                </div>
              {/each}
            </dl>
          {:else}
            <div class="dim">{copy.result.noInputs}</div>
          {/if}
        {/if}
        {#if attempts?.byStep[step.n - 1]?.length}
          <div class="attempts">
            <div class="attempts-title">{plural(copy.result.attempts, attempts.byStep[step.n - 1].length)}</div>
            <ul>{#each attempts.byStep[step.n - 1] as item (`${item.operation_id}:${item.attempt}`)}{@render attempt(item, false)}{/each}</ul>
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
{#if remaining > 0}
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
  .status { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--shimpz-color-text-muted); font: 600 0.62rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .status :global(.routine-icon) { width: 0.8rem; height: 0.8rem; color: var(--shimpz-color-cyan); }
  .inputs { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.2rem 0.75rem; margin: 0.15rem 0 0; font-size: 0.78rem; }
  .inputs > div { display: contents; }
  dt { color: var(--shimpz-color-text-dim); }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.76rem; overflow-wrap: anywhere; }
  .stored dt { display: inline-flex; align-items: center; justify-self: end; }
  .stored :global(.routine-icon) { width: 0.75rem; height: 0.75rem; }
  .stored dd { color: var(--shimpz-color-text-muted); }
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
