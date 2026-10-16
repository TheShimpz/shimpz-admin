<script>
  import { untrack } from 'svelte';

  import { call } from '#lib/session/socket.js';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import RoutineStep from '#lib/routines/Step.svelte';
  import Paging from '#lib/routines/Paging.svelte';
  import { fill } from '#lib/i18n/fill.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { humanizeId } from '#lib/ids.js';
  import { PAGE_SIZE, PagedList } from '#lib/routines/paging.svelte.js';
  import { pageBinding, readRunSteps } from '#lib/routines/protocol.js';
  import { attemptWords, conditionWords, countWords, literalWords } from '#lib/routines/words.js';
  import { durationWords } from '#lib/routines/reading.js';

  // The steps of one Routine run as the run recorded them (ADR-0092 amendment, 2026-10-05, scale), each laid out as a
  // Routine card lists it (`Step.svelte`): its Assistant and Action, what happened to it, how long its attempt took, the
  // inputs that attempt was
  // given as Team's redacted previews in the plan's own words (a hidden value as a lock chip), and the failed attempts
  // Team recorded for it. A step with no record says plainly that it did not run or that its record is unavailable.
  // The records are read page by page for one snapshot of them, bound to the run's historical `binding`
  // (`runBinding`): every page must match it, and the first page binds what it left unknown; a snapshot that changed
  // meanwhile is read again from the newest. A long run reveals its steps a few at a time; `total` reports how many
  // steps it has once that is known. Every value is escaped text.
  let {
    teamId, runId, binding, attempts = null, copy, locale,
    total = $bindable(null),
  } = $props();

  const ICONS = {
    done: 'check', recovered: 'check', failed: 'failed', stopped: 'stop', waiting: 'approval',
    not_run: 'skip', unavailable: 'warning',
  };
  // A changed snapshot is read again from the newest this many times before the steps are said to be unavailable.
  const RESTARTS = 2;

  // Only the newest read of this run may apply.
  const paging = new PagedList();
  let bound = $state(null);
  let snapshot = 'latest';
  let list = $state();

  let remaining = $derived((total ?? 0) - paging.shown.length);

  // An input whose value Team hid, named without it.
  function hidden(member) {
    const name = humanizeId(member);
    return { name, label: `${name}: ${copy.notice.output.redacted}` };
  }

  function restart() {
    paging.restart();
    snapshot = 'latest';
  }

  // Read pages of one snapshot until `wanted` steps are loaded or the run has no more; a snapshot that changed is read
  // again from the newest, at most RESTARTS times in one load.
  function load(wanted) {
    let restarts = 0;
    async function read(ticket) {
      for (;;) {
        try {
          const page = await readRunSteps(call, teamId, runId, bound, snapshot, paging.next);
          return { ...page, items: page.steps };
        } catch (error) {
          if (error?.code !== 'routine-run-changed' || restarts === RESTARTS) throw error;
          restarts += 1;
          if (paging.current(ticket)) restart();
        }
      }
    }
    return paging.load(wanted, read, {
      onPage: (page) => {
        snapshot = page.snapshot;
        // Every later page, and a restart from the newest records, must match the run the first page named.
        bound = pageBinding(page);
        total = page.total;
      },
      onError: () => (paging.failed = true),
    });
  }

  $effect(() => {
    void `${teamId}:${runId}:${binding.plan_digest}`;
    untrack(() => {
      paging.reset();
      bound = binding;
      total = null;
      snapshot = 'latest';
      void load(PAGE_SIZE);
    });
  });
</script>

{#snippet attempt(item, named)}
  <li class="attempt">
    <div class="attempt-head">
      <span class="mono">{named
        ? attemptWords(item, copy.details.attempt, { assistant: $assistantName, action: humanizeId })
        : fill(copy.result.attempt, { attempt: item.attempt })}</span>
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
  {#each paging.shown as step (step.position)}
    {@const shown = step.action && step.inputs?.length ? step.inputs : []}
    <RoutineStep {teamId} class={`step--${step.status}`} position={step.position} assistant={step.assistant_id}
      action={step.action} inputs={shown.filter((input) => input.value !== null)} words={(input) => literalWords(input.value)}
      locked={shown.filter((input) => input.value === null).map((input) => hidden(input.member))} copy={copy.proposal}>
      {#snippet status()}
        <div class="status">
          <RoutineIcon name={ICONS[step.status]} /><span class="word">{copy.result.status[step.status]}</span>
          {#if step.duration_ms !== null}<span class="when">{durationWords(step.duration_ms, locale)}</span>{/if}
          {#if step.attempt > 1}<span class="when">{fill(copy.result.attempt, { attempt: step.attempt })}</span>{/if}
        </div>
      {/snippet}
      {#if step.action && step.inputs === null}
        <div class="dim">{copy.result.inputsUnavailable}</div>
      {:else if step.action && step.inputs.length === 0}
        <div class="dim">{copy.result.noInputs}</div>
      {/if}
      {#if attempts?.byStep.get(step.position)?.length}
        <div class="attempts">
          <div class="attempts-title">{countWords(copy.result.attempts, attempts.byStep.get(step.position).length, locale)}</div>
          <ul>{#each attempts.byStep.get(step.position) as item (`${item.operation_id}:${item.attempt}`)}{@render attempt(item, false)}{/each}</ul>
        </div>
      {/if}
    </RoutineStep>
  {/each}
</ol>
<Paging {paging} {remaining} unavailable={copy.result.stepsUnavailable} loading={copy.result.stepsLoading}
  more={copy.result.more} {locale} onmore={() => paging.more(list, load)} />
{#if attempts?.apart.length}
  <div class="attempts apart">
    <div class="attempts-title">{copy.result.attemptsApart}</div>
    <ul>{#each attempts.apart as item (`${item.operation_id}:${item.attempt}`)}{@render attempt(item, true)}{/each}</ul>
  </div>
{/if}

<style>
  /* Each step is a shared Routine step row; under it, its status in a quiet mono line, then its inputs and attempts. */
  .steps { display: grid; margin: 0; padding: 0; list-style: none; }
  .status { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--gap-inside) var(--gap-item); color: var(--shimpz-color-text-muted); font: 600 0.62rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .status .word { display: inline-flex; align-items: center; }
  .status .when { color: var(--shimpz-color-text-dim); font-weight: 400; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }
  .status :global(.routine-icon) { width: 0.8rem; height: 0.8rem; color: var(--shimpz-color-cyan); }
  :global(.step--failed) .status :global(.routine-icon) { color: var(--shimpz-color-danger); }
  :global(.step--stopped) .status :global(.routine-icon) { color: var(--shimpz-color-text-muted); }
  :global(.step--waiting) .status :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  :global(.step--not_run) .status :global(.routine-icon),
  :global(.step--unavailable) .status :global(.routine-icon) { color: var(--shimpz-color-text-dim); }
  .dim { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .attempts { display: grid; gap: var(--gap-item); margin-block-start: var(--gap-inside); padding: var(--gap-item) var(--gap-group); border-inline-start: 2px solid var(--shimpz-color-border); border-radius: 0; background: rgb(255 255 255 / 0.015); }
  .attempts.apart { margin-block-start: var(--gap-item); }
  .attempts-title { color: var(--shimpz-color-text-muted); font-size: 0.75rem; }
  .attempts ul { display: grid; gap: var(--gap-item); margin: 0; padding: 0; list-style: none; }
  .attempt { display: grid; gap: var(--gap-inside); font-size: 0.75rem; }
  .attempt-head { display: flex; flex-wrap: wrap; gap: var(--gap-inside) var(--gap-item); color: var(--shimpz-color-text-muted); }
  .mono, code { font: 0.72rem/1.5 var(--shimpz-font-mono); }
  code { color: var(--shimpz-color-text-dim); }
  .message { color: var(--shimpz-color-text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
