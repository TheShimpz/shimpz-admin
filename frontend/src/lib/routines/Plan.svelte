<script>
  import { untrack } from 'svelte';

  import { call } from '#lib/session/socket.js';
  import Paging from '#lib/routines/Paging.svelte';
  import RoutineStep from '#lib/routines/Step.svelte';
  import { fill } from '#lib/i18n/fill.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { PAGE_SIZE, PagedList } from '#lib/routines/paging.svelte.js';
  import { readPlanSteps } from '#lib/routines/protocol.js';
  import { countWords, dispositionWords, inputWords, summaryChain } from '#lib/routines/words.js';

  // A Routine plan's safe projection (ADR-0092) in words. Its revision's summary shows at once: how many steps, their
  // Actions in order, and what each run does with its result. The steps themselves are read page by page for exactly
  // that revision (ADR-0092 amendment, 2026-10-05, scale) and revealed a few at a time, each laid out as the card lists
  // it (`Step.svelte`): its Assistant and Action and whether it reads or writes, each input as a friendly key and value,
  // references to an earlier step's result as a path, and the saved keys an Action uses by name only. A revision that
  // changed while it was read is never mixed with the new one: `onchanged` reads the Routine again, which brings its
  // new summary. Every value is Team's escaped preview, rendered as text, never as Markdown or HTML.
  let { teamId, routine, copy, locale, onchanged } = $props();

  // Only the newest read of the newest revision may apply.
  const paging = new PagedList();
  let list = $state();

  let plan = $derived(routine.plan);
  let remaining = $derived(plan.steps - paging.shown.length);
  let summary = $derived(summaryChain(plan, $assistantName, copy.notice, locale));

  // Read pages until `wanted` steps are loaded or the plan has no more.
  function load(wanted) {
    return paging.load(wanted, async () => {
      const page = await readPlanSteps(call, teamId, routine.routine_id, plan, paging.next);
      return { items: page.steps, next: page.next };
    }, {
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
    <RoutineStep {teamId} position={step.position} assistant={step.assistant} action={step.action}
      readOnly={step.read_only} inputs={step.inputs} words={(input) => inputWords(input, copy.plan)}
      locked={step.stored_inputs.map((name) => ({ name, label: fill(copy.plan.storedInput, { name }) }))}
      copy={copy.proposal} />
  {/each}
</ol>
<Paging {paging} {remaining} unavailable={copy.plan.unavailable} loading={copy.plan.loading} more={copy.result.more} {locale}
  onmore={() => paging.more(list, load)} />
<p class="disposition">{dispositionWords(routine.output, copy.plan)}</p>

<style>
  .overview { margin: 0 0 var(--gap-item); color: var(--shimpz-color-text-muted); font-size: 0.78rem; overflow-wrap: anywhere; }
  .plan { display: grid; margin: 0; padding: 0; list-style: none; }
  .disposition { margin: var(--gap-inside) 0 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
</style>
