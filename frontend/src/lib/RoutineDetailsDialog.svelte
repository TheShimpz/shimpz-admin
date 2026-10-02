<script>
  import { Button, DialogFrame, Modal, Notice } from '@shimpz/frontend';

  import { listChatHistory } from '$lib/chatHistory.js';
  import DialogAction from '$lib/DialogAction.svelte';
  import { locale } from '$lib/i18n.js';
  import { listAssistantCatalog } from '$lib/localApi.js';
  import {
    ATTENTION_STATUSES,
    deleteRoutine,
    fillRoutineCopy,
    instantWords,
    pauseRoutine,
    resumeRoutine,
    routineErrorMessage,
    routineStatus,
    scheduleWords,
    stopRoutineRun,
  } from '$lib/routine.js';
  import { dropTeamRoutine, loadTeamRoutines } from '$lib/routineContext.js';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import RoutineStatusMark from '$lib/RoutineStatusMark.svelte';

  // One Routine in full (ADR-0086, ADR-0092): what it does, when, how it stands, its recent runs with their execution
  // details, and one action per button: Pause or Resume, Stop a run going now, and Delete after a confirmation.
  let { teamId, routine, runs = [], incidents = [], copy, onclose, ondeleted } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let names = $state({});
  let recent = $state(null);
  let recentFailed = $state(false);
  let detailsRun = $state('');

  let status = $derived(routineStatus(routine, runs, incidents));
  let live = $derived(runs.filter((run) => run.routine_id === routine.routine_id));
  let held = $derived(status === 'recovery');

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  // Assistant names and this Routine's recent runs are read once, when the panel opens; neither is ever required.
  $effect(() => {
    let current = true;
    listAssistantCatalog(fetch)
      .then((catalog) => { if (current) names = Object.fromEntries(catalog.map((item) => [item.id, item.name])); })
      .catch(() => {});
    listChatHistory(fetch, teamId)
      .then(({ entries }) => {
        if (!current) return;
        recent = entries
          .filter((entry) => entry.kind === 'routine-run' && entry.routineId === routine.routine_id && entry.runId)
          .slice(-5)
          .reverse();
      })
      .catch(() => { if (current) recentFailed = true; });
    return () => { current = false; };
  });

  function outcomeWords(entry) {
    const run = copy.run;
    return {
      done: run.done,
      recovered: run.recovered,
      failed: fillRoutineCopy(run.failed, { code: entry.detail.code ?? '' }),
      denied: run.denied,
      stopped: run.stopped,
      'user-skipped': copy.panel.skipped,
      held: copy.status.recovery,
      paused: copy.status.paused,
      frozen: copy.status.waiting,
    }[entry.outcome] ?? entry.outcome;
  }

  async function act(action) {
    busy = true;
    error = '';
    try {
      await action();
      await loadTeamRoutines(fetch, teamId);
    } catch (failure) {
      error = routineErrorMessage(failure, copy.errors);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    busy = true;
    error = '';
    try {
      const { deleted } = await deleteRoutine(fetch, teamId, routine.routine_id);
      if (deleted) {
        dropTeamRoutine(teamId, routine.routine_id);
        close();
        ondeleted?.();
        return;
      }
      // A run is still ending: Team keeps the Routine as being deleted until it has.
      confirming = false;
      await loadTeamRoutines(fetch, teamId).catch(() => {});
    } catch (failure) {
      error = routineErrorMessage(failure, copy.errors);
    } finally {
      busy = false;
    }
  }

  function close(event) {
    event?.preventDefault();
    dialog?.close();
    onclose();
  }
</script>

<Modal bind:element={dialog} class="routine-panel" size="lg" labelledBy={`${id}-title`} oncancel={close}>
  <DialogFrame kicker={copy.list.open} title={routine.name} titleId={`${id}-title`}>
    <div class="panel">
      <p class="quote"><span class="label">{copy.panel.request}</span> {routine.quote}</p>
      <dl class="facts">
        <div><dt>{copy.panel.status}</dt><dd class="status"><RoutineStatusMark {status} />{copy.status[status]}</dd></div>
        <div><dt>{copy.panel.schedule}</dt><dd>{scheduleWords(routine.schedule, copy.schedule, $locale)}</dd></div>
        <div><dt>{copy.panel.timezone}</dt><dd>{routine.timezone}</dd></div>
        {#if !ATTENTION_STATUSES.includes(status)}
          <div><dt>{copy.panel.next}</dt><dd>{instantWords(routine.next_run_at, $locale, routine.timezone)}</dd></div>
        {/if}
      </dl>
      {#if held}<Notice variant="warning">{copy.panel.heldNote}</Notice>{/if}
      {#if status === 'reconfirm'}<Notice variant="warning">{copy.list.needsReconfirm}</Notice>{/if}

      <section aria-labelledby={`${id}-steps`}>
        <h3 id={`${id}-steps`}>{copy.plan.title}</h3>
        <RoutinePlan steps={routine.steps} copy={copy.plan} {names} />
      </section>

      <section aria-labelledby={`${id}-runs`}>
        <h3 id={`${id}-runs`}>{copy.panel.runs}</h3>
        {#each live as run (run.run_id)}
          <div class="run">
            <span>{run.status === 'frozen' ? copy.status.waiting : run.status === 'held' ? copy.status.recovery : copy.status.running}</span>
            {#if run.status !== 'held'}
              <Button variant="secondary" size="sm" type="button" disabled={busy}
                onclick={() => act(() => stopRoutineRun(fetch, teamId, run.run_id))}>{copy.list.stop}</Button>
            {/if}
          </div>
        {/each}
        {#if recentFailed}
          <p class="muted">{copy.panel.runsUnavailable}</p>
        {:else if recent === null}
          <p class="muted" role="status">{copy.list.loading}</p>
        {:else if recent.length === 0 && live.length === 0}
          <p class="muted">{copy.panel.noRuns}</p>
        {:else}
          <ul class="runs">
            {#each recent as entry (entry.id)}
              <li class="run">
                <span>{outcomeWords(entry)} · <span class="muted">{instantWords(entry.createdAt, $locale, routine.timezone)}</span></span>
                <Button variant="ghost" size="sm" type="button" onclick={() => (detailsRun = entry.runId)}>{copy.details.open}</Button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if confirming}<Notice variant="warning">{copy.list.deleteConfirm}</Notice>{/if}
      {#if error}<Notice variant="error">{error}</Notice>{/if}
    </div>
    {#snippet footer()}
      {#if confirming}
        <DialogAction kind="cancel" type="button" disabled={busy} onclick={() => (confirming = false)}>{copy.list.cancel}</DialogAction>
        <DialogAction kind="danger" type="button" disabled={busy} onclick={remove}>{copy.list.delete}</DialogAction>
      {:else}
        {#if !routine.deleting}
          <DialogAction kind="danger" variant="ghost" type="button" disabled={busy} onclick={() => (confirming = true)}>
            {copy.list.delete}
          </DialogAction>
          {#if routine.paused}
            <Button variant="secondary" type="button" disabled={busy}
              onclick={() => act(() => resumeRoutine(fetch, teamId, routine.routine_id))}>{copy.list.resume}</Button>
          {:else}
            <Button variant="secondary" type="button" disabled={busy}
              onclick={() => act(() => pauseRoutine(fetch, teamId, routine.routine_id))}>{copy.panel.pause}</Button>
          {/if}
        {/if}
        <DialogAction kind="cancel" type="button" onclick={close}>{copy.list.close}</DialogAction>
      {/if}
    {/snippet}
  </DialogFrame>
</Modal>

{#if detailsRun}
  <RoutineRunDetails {teamId} runId={detailsRun} copy={copy.details} errors={copy.errors} onclose={() => (detailsRun = '')} />
{/if}

<style>
  .panel { display: grid; gap: var(--shimpz-space-4); min-width: 0; }
  .quote { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; line-height: 1.45; overflow-wrap: break-word; }
  .label { color: var(--shimpz-color-text-dim); font: 700 0.65rem/1 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--shimpz-space-1) var(--shimpz-space-4); margin: 0; font-size: 0.85rem; }
  .facts > div { display: contents; }
  dt { color: var(--shimpz-color-text-muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: break-word; }
  .status { display: flex; align-items: center; gap: var(--shimpz-space-2); }
  section { display: grid; gap: var(--shimpz-space-2); min-width: 0; }
  h3 { margin: 0; color: var(--shimpz-color-cyan); font: 700 0.7rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .runs { display: grid; gap: var(--shimpz-space-1); margin: 0; padding: 0; list-style: none; }
  .run { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--shimpz-space-2); font-size: 0.8rem; }
  .muted { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  /* On a phone the panel is a full-screen sheet. */
  @media (max-width: 600px) {
    :global(dialog.shimpz-modal.routine-panel) { width: 100dvw; max-width: none; height: 100dvh; max-height: none; margin: 0; }
    :global(dialog.shimpz-modal.routine-panel .shimpz-dialog-frame) { min-height: 100dvh; max-height: 100dvh; clip-path: none; }
  }
</style>
