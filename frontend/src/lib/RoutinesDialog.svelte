<script>
  import { Button, DialogFrame, Modal, Notice } from '@shimpz/frontend';

  import { locale, t } from '$lib/i18n.js';
  import {
    deleteRoutine,
    fillRoutineCopy,
    instantWords,
    listRoutines,
    resolveRoutineRun,
    routineErrorMessage,
    scheduleWords,
    stopRoutineRun,
  } from '$lib/routine.js';

  // A Team's Routines and its runs in progress (ADR-0086). Deleting a Routine and releasing an uncertain run are
  // separate, explicit Supervisor decisions; nothing here runs a Routine.
  let { onsettled = () => {} } = $props();

  let dialog = $state();
  let team = $state(null);
  let routines = $state([]);
  let runs = $state([]);
  let phase = $state('idle');
  let error = $state('');
  let busy = $state('');
  let confirming = $state('');
  // Each load is fenced by its Team and generation, so a late answer never shows one Team's Routines under another.
  let generation = 0;

  let copy = $derived($t('routine'));
  let quotes = $derived(Object.fromEntries(routines.map((item) => [item.routine_id, item.quote])));
  let assistants = $derived(Object.fromEntries(routines.map((item) => [item.routine_id, item.assistant_ids.join(', ')])));

  export function open(target) {
    team = target;
    routines = [];
    runs = [];
    confirming = '';
    if (!dialog?.open) dialog?.showModal();
    refresh();
  }

  async function refresh() {
    const current = ++generation;
    const teamId = team.id;
    phase = 'loading';
    error = '';
    try {
      const listed = await listRoutines(fetch, teamId);
      if (current !== generation || team?.id !== teamId) return;
      ({ routines, runs } = listed);
      phase = 'ready';
    } catch (failure) {
      if (current !== generation || team?.id !== teamId) return;
      routines = [];
      runs = [];
      error = routineErrorMessage(failure, copy.errors);
      phase = 'error';
    }
  }

  async function act(key, action) {
    busy = key;
    error = '';
    try {
      await action();
      confirming = '';
      await refresh();
    } catch (failure) {
      error = routineErrorMessage(failure, copy.errors);
    } finally {
      busy = '';
    }
  }

  function close() {
    if (busy) return;
    dialog?.close();
    onsettled();
  }

  function cancel(event) {
    event.preventDefault();
    close();
  }
</script>

<Modal bind:element={dialog} labelledBy="routines-title" oncancel={cancel}>
  <DialogFrame title={fillRoutineCopy(copy.list.title, { team: team?.name ?? '' })} titleId="routines-title">
    {#if phase === 'loading'}
      <p class="muted" role="status">{copy.list.loading}</p>
    {:else if phase === 'ready' && routines.length === 0 && runs.length === 0}
      <p class="muted">{copy.list.empty}</p>
    {/if}
    {#if error}
      <Notice variant="error">
        <strong>{error}</strong>
        {#if phase === 'error'}
          <Button variant="secondary" size="sm" type="button" onclick={refresh}>{copy.list.retry}</Button>
        {/if}
      </Notice>
    {/if}
    {#if routines.length > 0}
      <ul class="items" aria-label={copy.list.open}>
        {#each routines as routine (routine.routine_id)}
          <li class="item">
            <p class="quote">{routine.quote}</p>
            <p class="meta">
              {scheduleWords(routine.schedule, copy.schedule, $locale)} · {routine.timezone}
            </p>
            {#if routine.deleting}
              <p class="meta">{copy.list.deleting}</p>
            {:else if routine.needs_reconfirm}
              <p class="warning">{copy.list.needsReconfirm}</p>
            {:else}
              <p class="meta">
                {fillRoutineCopy(copy.list.next, { next: instantWords(routine.next_run_at, $locale, routine.timezone) })}
              </p>
            {/if}
            {#if !routine.deleting}
              {#if confirming === routine.routine_id}
                <p class="warning">{copy.list.deleteConfirm}</p>
                <div class="actions">
                  <Button
                    variant="danger"
                    size="sm"
                    type="button"
                    disabled={busy !== ''}
                    onclick={() => act(routine.routine_id, () => deleteRoutine(fetch, team.id, routine.routine_id))}
                  >{copy.list.delete}</Button>
                  <Button variant="ghost" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = '')}>
                    {copy.list.cancel}
                  </Button>
                </div>
              {:else}
                <div class="actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={busy !== ''}
                    onclick={() => (confirming = routine.routine_id)}
                  >{copy.list.delete}</Button>
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if runs.length > 0}
      <h3 class="heading">{copy.list.runs}</h3>
      <ul class="items" aria-label={copy.list.runs}>
        {#each runs as run (run.run_id)}
          <li class="item">
            <p class="quote">{quotes[run.routine_id] ?? ''}</p>
            <p class={run.status === 'uncertain' ? 'warning' : 'meta'}>
              {run.status === 'leased' ? copy.list.running : run.status === 'frozen' ? copy.list.frozen : copy.list.uncertain}
            </p>
            {#if run.status === 'uncertain'}
              <p class="muted">{copy.list.uncertainLead}</p>
              {#if run.actions.length > 0}
                <p class="muted">{copy.list.uncertainActions}</p>
                <ul class="actions-list">
                  {#each run.actions as [assistant, action], index (index)}
                    <li><code>{assistant}</code> · <code>{action}</code></li>
                  {/each}
                </ul>
              {:else}
                <p class="warning">
                  {fillRoutineCopy(copy.list.uncertainUnknown, { assistants: assistants[run.routine_id] ?? '' })}
                </p>
              {/if}
              {#if confirming === run.run_id}
                <div class="actions">
                  <Button
                    variant="danger"
                    size="sm"
                    type="button"
                    disabled={busy !== ''}
                    onclick={() => act(run.run_id, () => resolveRoutineRun(fetch, team.id, run.run_id, run.batch_fingerprint))}
                  >{copy.list.resolve}</Button>
                  <Button variant="ghost" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = '')}>
                    {copy.list.cancel}
                  </Button>
                </div>
              {:else}
                <div class="actions">
                  <Button variant="secondary" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = run.run_id)}>
                    {copy.list.resolve}
                  </Button>
                </div>
              {/if}
            {:else}
              <div class="actions">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={busy !== ''}
                  onclick={() => act(run.run_id, () => stopRoutineRun(fetch, team.id, run.run_id))}
                >{copy.list.stop}</Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#snippet footer()}
      <Button variant="secondary" type="button" onclick={close} disabled={busy !== ''}>{copy.list.close}</Button>
    {/snippet}
  </DialogFrame>
</Modal>

<style>
  .items { display: grid; gap: var(--shimpz-space-2); margin: 0; padding: 0; list-style: none; }
  .item { display: grid; gap: var(--shimpz-space-1); padding: var(--shimpz-space-3); background: var(--shimpz-color-surface); border: 1px solid var(--shimpz-color-border); }
  .quote { margin: 0; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .meta, .muted, .warning { margin: 0; font-size: 0.8rem; line-height: 1.45; }
  .meta { color: var(--shimpz-color-text-muted); font-variant-numeric: tabular-nums; }
  .muted { color: var(--shimpz-color-text-muted); }
  .warning { color: var(--shimpz-color-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-1); }
  .actions-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: 0.8rem; overflow-wrap: anywhere; }
  .heading { margin: var(--shimpz-space-3) 0 0; font: 700 0.72rem/1 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--shimpz-color-text-muted); }
</style>
