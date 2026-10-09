<script>
  import { Button } from '@shimpz/frontend';
  import { tick, untrack } from 'svelte';

  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import {
    dispositionWords,
    fillRoutineCopy,
    humanizeId,
    inputWords,
    needsPage,
    readPlanSteps,
    summaryChain,
  } from '$lib/routine.js';
  import { visibleSteps } from '$lib/routineResult.js';

  // A Routine plan's safe projection (ADR-0092) in words. Its revision's summary shows at once: how many steps, their
  // Actions in order, and what each run does with its result. The steps themselves are read page by page for exactly
  // that revision (ADR-0092 amendment, 2026-10-05, scale) and revealed a few at a time: numbered steps naming the
  // Assistant and its Action, each input as a friendly key and value, references to an earlier step's result as a path,
  // and the saved keys an Action uses by name only. A revision that changed while it was read is never mixed with the
  // new one: `onchanged` reads the Routine again, which brings its new summary. Every value is Team's escaped preview,
  // rendered as text, never as Markdown or HTML.
  let { teamId, routine, copy, names = {}, locale, onchanged = () => {}, pageSize = 10 } = $props();

  let steps = $state([]);
  let next = $state(0);
  let pages = $state(1);
  let loading = $state(false);
  let failed = $state(false);
  let list = $state();
  // Only the newest read of the newest revision may apply.
  let reading = 0;

  const assistantName = (id) => names[id] ?? humanizeId(id);
  let plan = $derived(routine.plan);
  let shown = $derived(visibleSteps(steps, pages, pageSize));
  let remaining = $derived(plan.steps - shown.length);
  let summary = $derived(summaryChain(plan, assistantName, copy.notice, locale));
  const plural = (forms, count) => fillRoutineCopy(
    new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other,
    { count: new Intl.NumberFormat(locale).format(count) },
  );

  // Read pages until `wanted` steps are loaded or the plan has no more.
  async function load(wanted) {
    const ticket = reading;
    loading = true;
    try {
      while (ticket === reading && needsPage(steps.length, wanted, next)) {
        const page = await readPlanSteps(fetch, teamId, routine.routine_id, plan, next);
        if (ticket !== reading) return;
        steps = [...steps, ...page.steps];
        next = page.next;
      }
    } catch (error) {
      if (ticket !== reading) return;
      if (error?.code === 'routine-revision-changed') onchanged();
      else failed = true;
    } finally {
      if (ticket === reading) loading = false;
    }
  }

  // A new Routine or revision starts again from its first page. The Routine is read again in the background, which
  // hands in an equal object; the steps already read and revealed stay as they are for the same revision, and a read
  // of it that failed resumes where it stopped.
  let readFor = '';
  $effect(() => {
    const revision = `${routine.routine_id}:${plan.revision}:${plan.plan_digest}`;
    untrack(() => {
      if (revision === readFor) {
        if (failed && !loading) {
          failed = false;
          void load(pages * pageSize);
        }
        return;
      }
      readFor = revision;
      reading += 1;
      steps = [];
      next = 0;
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

<p class="overview">{plural(copy.result.stepCount, plan.steps)} · {summary}</p>
<ol class="plan" aria-label={copy.plan.title} bind:this={list}>
  {#each shown as step (step.position)}
    <li tabindex="-1">
      <span class="number" aria-hidden="true">{String(step.position).padStart(2, '0')}</span>
      <div class="step">
        <p class="head">
          <span class="action">{humanizeId(step.action)}</span>
          <span class="assistant">{assistantName(step.assistant)}</span>
        </p>
        {#if step.inputs.length > 0 || step.stored_inputs.length > 0}
          <div class="meta">
            {#if step.inputs.length > 0}
              <dl class="inputs">
                {#each step.inputs as input (input.member)}
                  <div><dt>{humanizeId(input.member)}</dt><dd>{inputWords(input, copy.plan)}</dd></div>
                {/each}
              </dl>
            {/if}
            {#each step.stored_inputs as name (name)}
              <p class="stored" title={fillRoutineCopy(copy.plan.storedInput, { name })}>
                <RoutineIcon name="lock" /><span class="sr-only">{fillRoutineCopy(copy.plan.storedInput, { name })}</span><span aria-hidden="true">{name}</span>
              </p>
            {/each}
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
{#if failed}
  <p class="note">{copy.plan.unavailable}</p>
{:else if loading}
  <p class="note" role="status">{copy.plan.loading}</p>
{:else if remaining > 0}
  <Button class="more" variant="ghost" size="sm" type="button" onclick={more}>
    {plural(copy.result.more, Math.min(pageSize, remaining))}
  </Button>
{/if}
<p class="disposition">{dispositionWords(routine.output, copy.plan)}</p>

<style>
  /* Steps as plain rows without rules: a mono number, the Action with its Assistant beside it, and one quiet line of what it uses. */
  .overview { margin: 0 0 var(--gap-item); color: var(--shimpz-color-text-muted); font-size: 0.78rem; overflow-wrap: anywhere; }
  .plan { display: grid; margin: 0; padding: 0; list-style: none; font-size: 0.82rem; line-height: 1.45; }
  li { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr); gap: var(--gap-item); padding-block: var(--gap-item); outline-offset: 2px; }
  li:first-child { padding-block-start: 0; }
  .number { color: var(--shimpz-color-cyan); font: 600 0.72rem/1.6 var(--shimpz-font-mono); }
  .step { display: grid; gap: var(--gap-inside); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--gap-inside) var(--gap-item); margin: 0; }
  .action { color: var(--shimpz-color-text); font-weight: 600; overflow-wrap: anywhere; }
  .assistant { color: var(--shimpz-color-text-dim); font-size: 0.74rem; }
  .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--gap-inside) var(--gap-group); color: var(--shimpz-color-text-muted); font-size: 0.76rem; }
  .inputs { display: contents; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-inside); min-width: 0; }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.74rem; overflow-wrap: anywhere; }
  .stored { display: inline-flex; align-items: center; gap: var(--gap-inside); margin: 0; font-family: var(--shimpz-font-mono); font-size: 0.74rem; }
  .stored :global(.routine-icon) { width: 0.75rem; height: 0.75rem; }
  .note { margin: var(--gap-inside) 0 0; color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .disposition { margin: var(--gap-inside) 0 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
  :global(.shimpz-button.more) { justify-self: start; }
</style>
