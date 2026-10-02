<script>
  import { Button, Modal, Notice } from '@shimpz/frontend';

  import { listChatHistory } from '$lib/chatHistory.js';
  import DialogAction from '$lib/DialogAction.svelte';
  import { locale } from '$lib/i18n.js';
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
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
  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // One Routine in full (ADR-0086, ADR-0092): what it does, when, how it stands, its recent runs with their execution
  // details, and one action per button: Pause or Resume, Stop a run going now, and Delete after a confirmation.
  let { teamId, routine, runs = [], incidents = [], copy, onclose, ondeleted } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let recent = $state(null);
  let recentFailed = $state(false);
  let detailsRun = $state('');

  let status = $derived(routineStatus(routine, runs, incidents));
  let live = $derived(runs.filter((run) => run.routine_id === routine.routine_id));
  let held = $derived(status === 'recovery');
  const STATUS_ICONS = {
    recovery: 'warning', reconfirm: 'warning', waiting: 'warning', deleting: 'warning', paused: 'pause',
    running: 'spinner', continuous: 'activity', healthy: 'clock',
  };

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  // Assistant names and this Routine's recent runs are read once, when the panel opens; neither is ever required.
  $effect(() => {
    let current = true;
    void loadAssistantNames(fetch);
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

  const RUN_ICONS = {
    done: 'check', recovered: 'check', failed: 'failed', denied: 'stop', stopped: 'stop', 'user-skipped': 'skip',
    held: 'warning', paused: 'pause', frozen: 'approval',
  };

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
  <div class="frame">
    <header class="head">
      <RoutineIcon name="clock" />
      <h2 id={`${id}-title`}>{routine.name}</h2>
      <span class={['tag', `tag--${STATUS_ICONS[status]}`]}><RoutineIcon name={STATUS_ICONS[status]} />{copy.status[status]}</span>
      <Button class="close" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.list.close} title={copy.list.close} onclick={close}>
        <RoutineIcon name="close" />
      </Button>
    </header>

    <div class="content">
      <p class="quote"><span class="label">{copy.panel.request}</span><span>{routine.quote}</span></p>
      {#if held}<p class="note"><RoutineIcon name="warning" />{copy.panel.heldNote}</p>{/if}
      {#if status === 'reconfirm'}<p class="note"><RoutineIcon name="warning" />{copy.list.needsReconfirm}</p>{/if}

      <div class="facts">
        <section aria-labelledby={`${id}-schedule`}>
          <h3 class="label" id={`${id}-schedule`}>{copy.panel.schedule}</h3>
          <p class="value">{scheduleWords(routine.schedule, copy.schedule, $locale)}</p>
          <p class="sub">{routine.timezone}</p>
        </section>
        {#if !ATTENTION_STATUSES.includes(status)}
          <section aria-labelledby={`${id}-next`}>
            <h3 class="label" id={`${id}-next`}>{copy.panel.next}</h3>
            <p class="value">{instantWords(routine.next_run_at, $locale, routine.timezone)}</p>
          </section>
        {/if}
      </div>

      <section aria-labelledby={`${id}-steps`}>
        <h3 class="label" id={`${id}-steps`}>{copy.plan.title}</h3>
        <RoutinePlan steps={routine.steps} copy={copy.plan} names={$assistantNames} />
      </section>

      <section aria-labelledby={`${id}-runs`}>
        <h3 class="label" id={`${id}-runs`}>{copy.panel.runs}</h3>
        <ul class="runs">
          {#each live as run (run.run_id)}
            <li>
              <RoutineIcon name={run.status === 'held' ? 'warning' : run.status === 'frozen' ? 'approval' : 'spinner'} />
              <span class="run-what">{run.status === 'frozen' ? copy.status.waiting : run.status === 'held' ? copy.status.recovery : copy.status.running}</span>
              {#if run.status !== 'held'}
                <Button variant="ghost" size="sm" type="button" disabled={busy}
                  onclick={() => act(() => stopRoutineRun(fetch, teamId, run.run_id))}>
                  {#snippet icon()}<RoutineIcon name="stop" />{/snippet}{copy.list.stop}
                </Button>
              {/if}
            </li>
          {/each}
          {#if recentFailed}
            <li class="sub">{copy.panel.runsUnavailable}</li>
          {:else if recent === null}
            <li class="sub" role="status">{copy.list.loading}</li>
          {:else if recent.length === 0 && live.length === 0}
            <li class="sub">{copy.panel.noRuns}</li>
          {:else}
            {#each recent as entry (entry.id)}
              <li>
                <RoutineIcon name={RUN_ICONS[entry.outcome] ?? 'clock'} />
                <span class="run-what">{outcomeWords(entry)}</span>
                <span class="when">{instantWords(entry.createdAt, $locale, routine.timezone)}</span>
                <Button class="run-details" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.details.open} title={copy.details.open}
                  onclick={() => (detailsRun = entry.runId)}><RoutineIcon name="terminal" /></Button>
              </li>
            {/each}
          {/if}
        </ul>
      </section>

      {#if confirming}<Notice variant="warning">{copy.list.deleteConfirm}</Notice>{/if}
      {#if error}<Notice variant="error">{error}</Notice>{/if}
    </div>

    <footer class="foot">
      {#if confirming}
        <DialogAction kind="cancel" type="button" disabled={busy} onclick={() => (confirming = false)}>{copy.list.cancel}</DialogAction>
        <DialogAction kind="danger" type="button" disabled={busy} onclick={remove}>{copy.list.delete}</DialogAction>
      {:else if !routine.deleting}
        <DialogAction kind="danger" variant="ghost" type="button" disabled={busy} onclick={() => (confirming = true)}>
          {copy.list.delete}
        </DialogAction>
        {#if routine.paused}
          <Button variant="secondary" type="button" disabled={busy}
            onclick={() => act(() => resumeRoutine(fetch, teamId, routine.routine_id))}>
            {#snippet icon()}<RoutineIcon name="play" />{/snippet}{copy.list.resume}
          </Button>
        {:else}
          <Button variant="secondary" type="button" disabled={busy}
            onclick={() => act(() => pauseRoutine(fetch, teamId, routine.routine_id))}>
            {#snippet icon()}<RoutineIcon name="pause" />{/snippet}{copy.panel.pause}
          </Button>
        {/if}
      {/if}
    </footer>
  </div>
</Modal>

{#if detailsRun}
  <RoutineRunDetails {teamId} runId={detailsRun} copy={copy.details} errors={copy.errors} onclose={() => (detailsRun = '')} />
{/if}

<style>
  /* The panel speaks the card's language: a scanline header strip, mono section labels, neutral tags, cyan only on
     the one primary action. */
  .frame {
    display: grid;
    max-height: calc(100dvh - 2rem);
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    color: var(--shimpz-color-text);
    background: var(--shimpz-color-surface);
    border: 1px solid var(--shimpz-color-border);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, 0 100%);
    box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 68%);
  }
  :global([dir="rtl"]) .frame { clip-path: polygon(var(--shimpz-cut-lg) 0, 100% 0, 100% 100%, 0 100%, 0 var(--shimpz-cut-lg)); }
  .head {
    display: flex;
    align-items: center;
    gap: var(--shimpz-space-2);
    min-height: 3rem;
    padding: 0.4rem var(--shimpz-space-2) 0.4rem var(--shimpz-space-4);
    color: var(--shimpz-color-text-dim);
    background: repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 4%, transparent) 2px 3px);
    border-block-end: 1px solid var(--shimpz-color-border);
  }
  h2 { flex: 1 1 auto; min-width: 0; margin: 0; overflow: hidden; font: 600 1rem/1.3 var(--shimpz-font-sans); text-overflow: ellipsis; white-space: nowrap; color: var(--shimpz-color-text); }
  .tag { display: inline-flex; flex: none; align-items: center; gap: 0.35rem; padding: 0.2rem 0.45rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font: 600 0.62rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
  .tag :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
  .tag--warning :global(.routine-icon), .note :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  .head :global(.close) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  .content { display: grid; gap: var(--shimpz-space-4); min-width: 0; padding: var(--shimpz-space-4); overflow: auto; }
  .label { margin: 0 0 0.35rem; color: var(--shimpz-color-text-dim); font: 600 0.62rem/1.3 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
  .quote { display: grid; gap: 0.25rem; margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.84rem; line-height: 1.5; overflow-wrap: break-word; }
  .quote .label { margin: 0; }
  .note { display: flex; align-items: flex-start; gap: 0.5rem; margin: 0; padding: 0.55rem 0.7rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.8rem; line-height: 1.45; }
  .note :global(.routine-icon) { margin-block-start: 0.15rem; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--shimpz-space-4); }
  section { min-width: 0; }
  .value { margin: 0; font: 400 0.84rem/1.45 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .sub { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
  .runs { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
  .runs li { display: flex; align-items: center; gap: 0.6rem; min-height: 2.25rem; padding: 0.25rem 0.25rem 0.25rem 0.5rem; border-block-end: 1px solid var(--shimpz-color-border-subtle); font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  .runs li :global(.routine-icon) { color: var(--shimpz-color-text-dim); width: 0.9rem; height: 0.9rem; }
  .runs li :global(.routine-icon--failed) { color: var(--shimpz-color-danger); }
  .runs li :global(.routine-icon--warning) { color: var(--shimpz-color-yellow); }
  .run-what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .when { flex: none; color: var(--shimpz-color-text-dim); font-size: 0.72rem; }
  .runs :global(.run-details) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  @media (max-width: 600px) { .when { display: none; } }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--shimpz-space-2); padding: var(--shimpz-space-3) var(--shimpz-space-4); border-block-start: 1px solid var(--shimpz-color-border); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
  /* On a phone the panel is a full-screen sheet. */
  @media (max-width: 600px) {
    .head { flex-wrap: wrap; }
    h2 { flex-basis: 8rem; }
    .tag { order: 4; margin-inline-start: calc(1rem + var(--shimpz-space-2)); }
    .head :global(.close) { order: 3; }
    :global(dialog.shimpz-modal.routine-panel) { width: 100dvw; max-width: none; height: 100dvh; max-height: none; margin: 0; }
    .frame { height: 100dvh; max-height: 100dvh; clip-path: none; }
  }
  @media (forced-colors: active) { .frame, .tag, .note { border-color: CanvasText; } }
</style>
