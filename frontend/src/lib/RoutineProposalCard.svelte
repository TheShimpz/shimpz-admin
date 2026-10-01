<script>
  import { onMount } from 'svelte';

  import DialogAction from '$lib/DialogAction.svelte';
  import { locale } from '$lib/i18n.js';
  import {
    browserTimezone,
    confirmRoutine,
    fillRoutineCopy,
    instantWords,
    previewMatches,
    previewRoutine,
    RoutineError,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';
  import { loadTeamRoutines } from '$lib/routineContext.js';

  // A chat turn's one-use Routine proposal (ADR-0086). Nothing is scheduled until the Supervisor confirms here; the
  // card first asks Team whether the offer is still live, since a stored card may have expired or been used.
  let { teamId, proposal, copy } = $props();

  const id = $props.id();
  let phase = $state('loading');
  let preview = $state(null);
  let message = $state('');
  let timezone = $state('UTC');

  let cancel = $derived(proposal.op === 'cancel');

  onMount(() => {
    timezone = proposal.timezone ?? browserTimezone();
    previewRoutine(fetch, teamId, proposal.proposal_id, timezone).then(
      (value) => {
        // The card shows the saved request, so it confirms only a live proposal that is exactly that request.
        if (!previewMatches(proposal, value)) {
          message = routineErrorMessage(new RoutineError('routine-response-invalid'), copy.errors);
          phase = 'closed';
          return;
        }
        preview = value;
        phase = 'ready';
      },
      (error) => {
        message = routineErrorMessage(error, copy.errors);
        phase = 'closed';
      },
    );
  });

  async function confirm() {
    phase = 'working';
    try {
      const result = await confirmRoutine(fetch, teamId, proposal.proposal_id, timezone);
      // The sidebar's Routine tree reflects the change at once.
      loadTeamRoutines(fetch, teamId).catch(() => {});
      if (result.routine) {
        const next = instantWords(result.routine.next_run_at, $locale, result.routine.timezone);
        message = fillRoutineCopy(copy.card.confirmed, { next });
      } else {
        message = result.deleted ? copy.card.cancelled : copy.card.cancelPending;
      }
    } catch (error) {
      message = routineErrorMessage(error, copy.errors);
    }
    phase = 'closed';
  }

  function dismiss() {
    message = copy.card.dismissed;
    phase = 'closed';
  }
</script>

<section class="routine-card" aria-labelledby={`${id}-title`} aria-busy={phase === 'loading' || phase === 'working'}>
  <p class="label" id={`${id}-title`}>{cancel ? copy.card.cancelTitle : copy.card.label}</p>
  <blockquote class="quote">{proposal.quote}</blockquote>
  {#if phase === 'loading'}
    <p class="muted" role="status">{copy.card.loading}</p>
  {:else if phase === 'closed'}
    <p class="outcome" role="status">{message}</p>
  {:else if preview}
    {#if !cancel}
      <dl class="facts">
        <div>
          <dt>{copy.card.schedule}</dt>
          <dd>{scheduleWords(preview.schedule, copy.schedule, $locale)}</dd>
        </div>
        <div>
          <dt>{copy.card.timezone}</dt>
          <dd>{preview.timezone}</dd>
        </div>
        <div>
          <dt>{copy.card.nextRuns}</dt>
          <dd>
            <ul class="runs">
              {#each preview.next_runs as run (run)}
                <li>{instantWords(run, $locale, preview.timezone)}</li>
              {/each}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{copy.card.assistants}</dt>
          <dd>{preview.assistant_ids.join(', ')}</dd>
        </div>
      </dl>
      <p class={['budget', !preview.fits && 'over']}>
        {preview.fits
          ? fillRoutineCopy(copy.card.budget, { runs: preview.daily_runs, max: preview.max_daily_runs })
          : fillRoutineCopy(copy.card.overBudget, { max: preview.max_daily_runs })}
      </p>
      <p class="muted">{copy.card.authorizations}</p>
    {/if}
    <p class="muted">{copy.card.notScheduled}</p>
    <div class="actions">
      <DialogAction
        kind={cancel ? 'danger' : 'confirm'}
        size="sm"
        type="button"
        disabled={phase === 'working' || !preview.fits}
        onclick={confirm}
      >
        {phase === 'working' ? copy.card.working : cancel ? copy.card.cancelConfirm : copy.card.confirm}
      </DialogAction>
      <DialogAction kind="dismiss" size="sm" type="button" disabled={phase === 'working'} onclick={dismiss}>
        {copy.card.dismiss}
      </DialogAction>
    </div>
  {/if}
</section>

<style>
  .routine-card { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-2); padding: var(--shimpz-space-3); background: var(--shimpz-color-surface); border: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 35%, var(--shimpz-color-border)); }
  .label { margin: 0; color: var(--shimpz-color-cyan); font: 700 0.7rem/1 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
  .quote { margin: 0; color: var(--shimpz-color-text); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .facts { display: grid; gap: var(--shimpz-space-1); margin: 0; }
  .facts div { display: grid; grid-template-columns: minmax(7rem, auto) 1fr; gap: var(--shimpz-space-2); }
  .facts dt { color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  .facts dd { margin: 0; color: var(--shimpz-color-text); overflow-wrap: anywhere; }
  .runs { margin: 0; padding: 0; list-style: none; font-variant-numeric: tabular-nums; }
  .budget, .muted, .outcome { margin: 0; font-size: 0.8rem; line-height: 1.45; }
  .muted { color: var(--shimpz-color-text-muted); }
  .over { color: var(--shimpz-color-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); }
  @media (max-width: 30rem) { .facts div { grid-template-columns: 1fr; gap: 0; } }
</style>
