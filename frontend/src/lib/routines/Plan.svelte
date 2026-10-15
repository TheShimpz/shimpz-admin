<script>
  import { untrack } from 'svelte';

  import { call } from '#lib/session/socket.js';
  import Inputs from '#lib/routines/Inputs.svelte';
  import Paging from '#lib/routines/Paging.svelte';
  import { fill } from '#lib/i18n/fill.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { humanizeId } from '#lib/ids.js';
  import { PAGE_SIZE, PagedSteps } from '#lib/routines/paging.svelte.js';
  import { readPlanSteps } from '#lib/routines/protocol.js';
  import { countWords, dispositionWords, inputWords, summaryChain } from '#lib/routines/words.js';

  // A Routine plan's safe projection (ADR-0092) in words. Its revision's summary shows at once: how many steps, their
  // Actions in order, and what each run does with its result. The steps themselves are read page by page for exactly
  // that revision (ADR-0092 amendment, 2026-10-05, scale) and revealed a few at a time: numbered steps naming the
  // Assistant and its Action, each input as a friendly key and value, references to an earlier step's result as a path,
  // and the saved keys an Action uses by name only. A revision that changed while it was read is never mixed with the
  // new one: `onchanged` reads the Routine again, which brings its new summary. Every value is Team's escaped preview,
  // rendered as text, never as Markdown or HTML.
  let { teamId, routine, copy, locale, onchanged = () => {} } = $props();

  // Only the newest read of the newest revision may apply.
  const paging = new PagedSteps();
  let list = $state();

  let plan = $derived(routine.plan);
  let remaining = $derived(plan.steps - paging.shown.length);
  let summary = $derived(summaryChain(plan, $assistantName, copy.notice, locale));

  // Read pages until `wanted` steps are loaded or the plan has no more.
  function load(wanted) {
    return paging.load(wanted, () => readPlanSteps(call, teamId, routine.routine_id, plan, paging.next), {
      onError: (error) => {
        if (error?.code === 'routine-revision-changed') onchanged();
        else paging.failed = true;
      },
    });
  }

  // A new Routine or revision starts again from its first page. The Routine is read again in the background, which
  // hands in an equal object; the steps already read and revealed stay as they are for the same revision, and a read
  // of it that failed resumes where it stopped.
  let readFor = '';
  $effect(() => {
    const revision = `${routine.routine_id}:${plan.revision}:${plan.plan_digest}`;
    untrack(() => {
      if (revision === readFor) {
        if (paging.failed && !paging.loading) {
          paging.failed = false;
          void load(paging.pages * PAGE_SIZE);
        }
        return;
      }
      readFor = revision;
      paging.reset();
      void load(PAGE_SIZE);
    });
  });
</script>

<p class="overview">{countWords(copy.result.stepCount, plan.steps, locale)} · {summary}</p>
<ol class="plan" aria-label={copy.plan.title} bind:this={list}>
  {#each paging.shown as step (step.position)}
    <li tabindex="-1">
      <span class="number" aria-hidden="true">{String(step.position).padStart(2, '0')}</span>
      <div class="step">
        <p class="head">
          <span class="action">{humanizeId(step.action)}</span>
          <span class="assistant">{$assistantName(step.assistant)}</span>
        </p>
        {#if step.inputs.length > 0 || step.stored_inputs.length > 0}
          <div class="meta">
            <Inputs inputs={step.inputs} words={(input) => inputWords(input, copy.plan)}
              locked={step.stored_inputs.map((name) => ({ name, label: fill(copy.plan.storedInput, { name }) }))} />
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
<Paging {paging} {remaining} unavailable={copy.plan.unavailable} loading={copy.plan.loading} more={copy.result.more} {locale}
  onmore={() => paging.more(list, load)} />
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
  .disposition { margin: var(--gap-inside) 0 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
</style>
