<script>
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import RoutineModal from '$lib/RoutineModal.svelte';
  import RoutineResult from '$lib/RoutineResult.svelte';
  import RoutineRunSteps from '$lib/RoutineRunSteps.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';
  import {
    displayZone, fillRoutineCopy, instantWords, MAX_DECISION_CALLS, MAX_ROUTINE_STEPS, readRunDiagnostics, runBinding,
  } from '$lib/routine.js';
  import { attemptsByStep, resultView } from '$lib/routineResult.js';

  // One Routine run in full, over the whole screen (ADR-0092 amendment, 2026-10-05, output and scale): how it stands
  // and when its notice said so, the result it shows organized for reading when it shows one, and its own step records:
  // what happened to each step and the inputs its attempt was given, read page by page. Every run with a run id opens
  // here, whether it completed, failed, stopped, or was held. The failed attempts Team recorded for the run are read on
  // open for exactly this Team and run; a late answer for an earlier run is discarded. Every value is escaped text.
  // `status` and `tone` are the run's notice status phrase and tone.
  let { teamId, entry, routine = null, name, status, tone, copy, onclose } = $props();

  const TAGS = {
    healthy: { tone: 'neutral', icon: 'check' },
    danger: { tone: 'danger', icon: 'failed' },
    waiting: { tone: 'warning', icon: 'pause' },
    neutral: { tone: 'neutral', icon: 'stop' },
  };
  // A run still waiting for a person has not finished; its notice's instant is its last update.
  const WAITING = ['held', 'paused', 'frozen'];

  const id = $props.id();
  let dialog = $state();
  let diagnostics = $state(null);
  let unavailable = $state(false);
  let copied = $state('');
  let copiedTimer;

  let output = $derived(entry.detail.output?.state === 'shown' ? entry.detail.output : null);
  let view = $derived(output ? resultView(output.value) : null);
  let binding = $derived(runBinding(entry.routineId, entry.detail.plan ?? null));
  // A completed run's notice says how many replay steps its revision has; any other run's first page of records does,
  // with how many entries the run recorded, its replay steps and then its decision calls.
  let replay = $state(null);
  let total = $state(null);
  let steps = $derived(entry.detail.plan?.steps ?? replay);
  let attempts = $derived(diagnostics ? attemptsByStep(
    diagnostics, steps ?? MAX_ROUTINE_STEPS, total ?? (steps ?? MAX_ROUTINE_STEPS) + MAX_DECISION_CALLS,
  ) : null);
  let finished = $derived(instantWords(entry.createdAt, $locale, routine ? displayZone(routine) : undefined));
  let count = $derived(steps === null ? '' : fillRoutineCopy(
    new Intl.PluralRules($locale).select(steps) === 'one' ? copy.result.stepCount.one : copy.result.stepCount.other,
    { count: new Intl.NumberFormat($locale).format(steps) },
  ));
  let badge = $derived(TAGS[tone] ?? TAGS.neutral);
  let label = $derived(status.charAt(0).toLocaleUpperCase($locale) + status.slice(1));

  $effect(() => { void loadAssistantNames(fetch); });

  $effect(() => {
    const runId = entry.runId;
    const team = teamId;
    let current = true;
    diagnostics = null;
    unavailable = false;
    readRunDiagnostics(fetch, team, runId)
      .then((value) => { if (current) diagnostics = value; })
      .catch(() => { if (current) unavailable = true; });
    return () => { current = false; };
  });

  $effect(() => () => clearTimeout(copiedTimer));

  // A copied identifier is announced once, then the announcement clears.
  function announce(done) {
    clearTimeout(copiedTimer);
    copied = done ? copy.result.copied : copy.result.copyFailed;
    copiedTimer = setTimeout(() => (copied = ''), 2_000);
  }

  function close(event) {
    event?.preventDefault();
    dialog?.close();
    onclose();
  }
</script>

<RoutineModal bind:dialog class="routine-run-view" full title={name} oncancel={close} onclose={close}>
  {#snippet tag()}
    <RoutineTag {label} tone={badge.tone} icon={badge.icon} />
  {/snippet}
  <div class="content">
    <div class="sheet">
      <dl class="meta">
        <div>
          <dt>{WAITING.includes(entry.outcome) ? copy.result.updated : copy.result.finished}</dt>
          <dd><time datetime={entry.createdAt}>{finished}</time>{#if routine}<span class="zone">{routine.timezone}</span>{/if}</dd>
        </div>
        {#if count}<div><dt>{copy.result.steps}</dt><dd>{count}</dd></div>{/if}
      </dl>

      <div class={['columns', !output && 'columns--steps']}>
        {#if output}
          <section class="response" aria-labelledby={`${id}-response`}>
            <h3 id={`${id}-response`}>{copy.result.response}</h3>
            {#if output.truncated}<div class="note">{copy.notice.output.truncated}</div>{/if}
            <RoutineResult {view} copy={copy.notice.output} resultCopy={copy.result} locale={$locale} oncopy={announce} />
          </section>
        {/if}

        <section class="steps" aria-labelledby={`${id}-steps`}>
          <h3 id={`${id}-steps`}>{copy.result.steps}</h3>
          <div class="note">{copy.result.recordsNote}</div>
          <RoutineRunSteps {teamId} runId={entry.runId} {binding} {attempts} {copy} names={$assistantNames}
            locale={$locale} bind:replay bind:total />
          {#if unavailable}
            <div class="note">{copy.result.attemptsUnavailable}</div>
          {:else if diagnostics === null}
            <div class="note" role="status">{copy.result.attemptsLoading}</div>
          {/if}
        </section>
      </div>
    </div>
    <div class="sr-only" role="status">{copied}</div>
  </div>
</RoutineModal>

<style>
  /* The sheet centers a readable measure in the full screen: a meta strip, then the response as the wide main column
     and the steps beside it, stacked on narrow screens. Neutral greys, cyan only for numbers, headings, and focus. */
  .content { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .sheet {
    display: grid;
    gap: var(--shimpz-space-6);
    max-width: 90rem;
    margin-inline: auto;
    padding: var(--shimpz-space-6) var(--shimpz-space-6) var(--shimpz-space-10);
  }
  .meta { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-3) var(--shimpz-space-8); margin: 0; padding-block-end: var(--shimpz-space-4); border-block-end: 1px solid var(--shimpz-color-border-subtle); }
  .meta div { display: grid; gap: 0.2rem; }
  dt, h3 {
    margin: 0;
    color: var(--shimpz-color-text-dim);
    font: 600 0.62rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  dd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; margin: 0; color: var(--shimpz-color-text); font: 0.85rem/1.4 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; }
  .zone { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .columns { display: grid; gap: var(--shimpz-space-8); align-items: start; }
  section { display: grid; gap: var(--shimpz-space-4); min-width: 0; }
  h3 { color: var(--shimpz-color-cyan); font-size: 0.68rem; }
  .note { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.75rem; line-height: 1.5; }
  @media (min-width: 64rem) {
    .columns { grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem); }
    .steps { padding-inline-start: var(--shimpz-space-6); border-inline-start: 1px solid var(--shimpz-color-border-subtle); }
    /* A run that shows no result reads its steps as the one column. */
    .columns--steps { grid-template-columns: minmax(0, 48rem); }
    .columns--steps .steps { padding-inline-start: 0; border-inline-start: 0; }
  }
  @media (max-width: 600px) {
    .sheet { padding: var(--shimpz-space-4) var(--shimpz-space-4) var(--shimpz-space-8); }
  }
</style>
