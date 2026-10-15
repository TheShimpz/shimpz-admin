<script>
  import { locale } from '#lib/i18n/index.js';
  import RoutineModal from '#lib/routines/Modal.svelte';
  import RoutineResult from '#lib/routines/result/View.svelte';
  import RoutineRunSteps from '#lib/routines/run/Steps.svelte';
  import RoutineTag from '#lib/routines/Tag.svelte';
  import { MAX_ROUTINE_STEPS } from '#lib/routines/protocol.js';
  import { RunDiagnostics, entryBinding } from '#lib/routines/run/diagnostics.svelte.js';
  import { countWords, instantWords } from '#lib/routines/words.js';
  import { attemptsByStep, resultView } from '#lib/routines/reading.js';

  // One Routine run in full, over the whole screen (ADR-0092 amendment, 2026-10-05, output and scale): how it stands
  // and when its notice said so, the result it shows organized for reading when it shows one, and its own step records:
  // what happened to each step and the inputs its attempt was given, read page by page. Every run with a run id opens
  // here, whether it completed, failed, stopped, or was held. The failed attempts Team recorded for the run are read on
  // open for exactly this Team and run; a late answer for an earlier run is discarded. Every value is escaped text.
  // `status` and `tone` are the run's notice status phrase and tone.
  let { teamId, entry, routine, status, tone, copy, onclose } = $props();

  const TAGS = {
    healthy: { tone: 'neutral', icon: 'check' },
    danger: { tone: 'danger', icon: 'failed' },
    waiting: { tone: 'warning', icon: 'pause' },
    neutral: { tone: 'neutral', icon: 'stop' },
  };
  // A run still waiting for a person has not finished; its notice's instant is its last update.
  const WAITING = ['held', 'paused', 'frozen'];

  const id = $props.id();
  const reading = new RunDiagnostics();
  let copied = $state('');
  let copiedTimer;

  let output = $derived(entry.detail.output?.state === 'shown' ? entry.detail.output : null);
  let view = $derived(output ? resultView(output.value) : null);
  let binding = $derived(entryBinding(entry));
  let diagnostics = $derived(reading.value);
  let unavailable = $derived(reading.failure !== null);
  // A completed run's notice says how many steps its revision has; any other run's first page of records does.
  let total = $state(null);
  let steps = $derived(entry.detail.plan?.steps ?? total);
  let attempts = $derived(diagnostics ? attemptsByStep(diagnostics, steps ?? MAX_ROUTINE_STEPS) : null);
  let finished = $derived(instantWords(entry.createdAt, $locale, routine.timezone));
  let count = $derived(steps === null ? '' : countWords(copy.result.stepCount, steps, $locale));
  let badge = $derived(TAGS[tone] ?? TAGS.neutral);
  let label = $derived(status.charAt(0).toLocaleUpperCase($locale) + status.slice(1));

  $effect(() => reading.read(teamId, entry.runId));

  $effect(() => () => clearTimeout(copiedTimer));

  // A copied identifier is announced once, then the announcement clears.
  function announce(done) {
    clearTimeout(copiedTimer);
    copied = done ? copy.result.copied : copy.result.copyFailed;
    copiedTimer = setTimeout(() => (copied = ''), 2_000);
  }

</script>

<RoutineModal class="routine-run-view" full title={entry.name} {onclose}>
  {#snippet tag()}
    <RoutineTag {label} tone={badge.tone} icon={badge.icon} />
  {/snippet}
  <div class="content">
    <div class="sheet">
      <dl class="meta">
        <div>
          <dt>{WAITING.includes(entry.outcome) ? copy.result.updated : copy.result.finished}</dt>
          <dd><time datetime={entry.createdAt}>{finished}</time><span class="zone">{routine.timezone}</span></dd>
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
          <RoutineRunSteps {teamId} runId={entry.runId} {binding} {attempts} {copy}
            locale={$locale} bind:total />
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
    gap: var(--gap-panel);
    max-width: 90rem;
    margin-inline: auto;
    padding: var(--gap-panel) var(--gap-panel) var(--gap-region);
  }
  .meta { display: flex; flex-wrap: wrap; gap: var(--gap-group) var(--gap-panel); margin: 0; padding-block-end: var(--gap-group); border-block-end: 1px solid var(--shimpz-color-border-subtle); }
  .meta div { display: grid; gap: var(--gap-inside); }
  dt, h3 {
    margin: 0;
    color: var(--shimpz-color-text-dim);
    font: 600 0.62rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  dd { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--gap-item); margin: 0; color: var(--shimpz-color-text); font: 0.85rem/1.4 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; }
  .zone { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .columns { display: grid; gap: var(--gap-section); align-items: start; }
  section { display: grid; gap: var(--gap-item); min-width: 0; }
  h3 { color: var(--shimpz-color-cyan); font-size: 0.68rem; }
  .note { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.75rem; line-height: 1.5; }
  @media (min-width: 64rem) {
    .columns { grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem); }
    .steps { padding-inline-start: var(--gap-panel); border-inline-start: 1px solid var(--shimpz-color-border-subtle); border-radius: 0; }
    /* A run that shows no result reads its steps as the one column. */
    .columns--steps { grid-template-columns: minmax(0, 48rem); }
    .columns--steps .steps { padding-inline-start: 0; border-inline-start: 0; }
  }
  @media (max-width: 600px) {
    .sheet { padding: var(--gap-group) var(--gap-group) var(--gap-section); }
  }
</style>
