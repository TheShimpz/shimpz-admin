<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { locale, t } from '$lib/i18n.js';
  import {
    deleteRoutine,
    fillRoutineCopy,
    instantWords,
    resolveRoutineRun,
    routineErrorMessage,
    scheduleWords,
    stopRoutineRun,
  } from '$lib/routine.js';
  import { dropTeamRoutine, loadTeamRoutines } from '$lib/routineContext.js';

  // One Team's Routines as a tree under its row (ADR-0086). A node opens in place with its schedule and runs in
  // progress; deleting a Routine and releasing an uncertain run each need an explicit confirmation here.
  let { teamId, routines = [], runs = [] } = $props();

  let copy = $derived($t('routine'));
  let open = $state('');
  let confirming = $state('');
  let busy = $state('');
  let error = $state('');
  let root = $state();

  async function act(key, action) {
    busy = key;
    error = '';
    try {
      await action();
      confirming = '';
      await loadTeamRoutines(fetch, teamId);
    } catch (failure) {
      error = routineErrorMessage(failure, copy.errors);
    } finally {
      busy = '';
    }
  }

  // A deletion Team confirms leaves the tree at once. Team answers false while a run is still ending; the Routine then
  // stays listed as deleting. Either way focus lands on the node now at that place, or on the Team's actions when the
  // tree is gone.
  async function remove(routineId) {
    const team = root.closest('li');
    const index = routines.findIndex((routine) => routine.routine_id === routineId);
    let answered = false;
    await act(routineId, async () => {
      const { deleted } = await deleteRoutine(fetch, teamId, routineId);
      answered = true;
      if (deleted) dropTeamRoutine(teamId, routineId);
    });
    if (!answered) return;
    await tick();
    const nodes = team.querySelectorAll('.node-toggle');
    (nodes[Math.min(index, nodes.length - 1)] ?? team.querySelector('.team-actions button'))?.focus();
  }

  function toggle(routineId) {
    open = open === routineId ? '' : routineId;
    confirming = '';
    error = '';
  }
</script>

<div bind:this={root} class="routine-tree" role="group" aria-label={copy.list.open}>
<ul class="nodes">
  {#each routines as routine (routine.routine_id)}
    {@const expanded = open === routine.routine_id}
    {@const active = runs.filter((run) => run.routine_id === routine.routine_id)}
    <li class={['node', expanded && 'is-open']}>
      <Button
        class="node-toggle"
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        aria-controls={`routine-${routine.routine_id}`}
        onclick={() => toggle(routine.routine_id)}
      >
        <span class="quote">{routine.quote}</span>
        <span class="meta">{scheduleWords(routine.schedule, copy.schedule, $locale)}</span>
        {#if active.some((run) => run.status === 'uncertain')}
          <span class="flag bad">{copy.list.uncertain}</span>
        {:else if active.some((run) => run.status === 'frozen')}
          <span class="flag waiting">{copy.list.frozen}</span>
        {:else if active.length}
          <span class="flag">{copy.list.running}</span>
        {/if}
      </Button>
      <div class="detail" id={`routine-${routine.routine_id}`} hidden={!expanded}>
        <p class="meta">{routine.timezone}</p>
        {#if routine.deleting}
          <p class="meta">{copy.list.deleting}</p>
        {:else if routine.needs_reconfirm}
          <p class="warning">{copy.list.needsReconfirm}</p>
        {:else}
          <p class="meta">
            {fillRoutineCopy(copy.list.next, { next: instantWords(routine.next_run_at, $locale, routine.timezone) })}
          </p>
        {/if}
        {#each active as run (run.run_id)}
          {#if run.status === 'uncertain'}
            <p class="warning">{copy.list.uncertainLead}</p>
            {#if run.actions.length > 0}
              <p class="meta">{copy.list.uncertainActions}</p>
              <ul class="actions-list">
                {#each run.actions as [assistant, action], index (index)}
                  <li><code>{assistant}</code> · <code>{action}</code></li>
                {/each}
              </ul>
            {:else}
              <p class="warning">
                {fillRoutineCopy(copy.list.uncertainUnknown, { assistants: routine.assistant_ids.join(', ') })}
              </p>
            {/if}
            <div class="buttons">
              {#if confirming === run.run_id}
                <Button variant="danger" size="sm" type="button" disabled={busy !== ''}
                  onclick={() => act(run.run_id, () => resolveRoutineRun(fetch, teamId, run.run_id, run.batch_fingerprint))}
                >{copy.list.resolve}</Button>
                <Button variant="ghost" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = '')}>
                  {copy.list.cancel}
                </Button>
              {:else}
                <Button variant="secondary" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = run.run_id)}>
                  {copy.list.resolve}
                </Button>
              {/if}
            </div>
          {:else}
            <div class="buttons">
              <span class="meta">{run.status === 'frozen' ? copy.list.frozen : copy.list.running}</span>
              <Button variant="secondary" size="sm" type="button" disabled={busy !== ''}
                onclick={() => act(run.run_id, () => stopRoutineRun(fetch, teamId, run.run_id))}
              >{copy.list.stop}</Button>
            </div>
          {/if}
        {/each}
        {#if !routine.deleting}
          {#if confirming === routine.routine_id}
            <p class="warning">{copy.list.deleteConfirm}</p>
            <div class="buttons">
              <Button variant="danger" size="sm" type="button" disabled={busy !== ''}
                onclick={() => remove(routine.routine_id)}
              >{copy.list.delete}</Button>
              <Button variant="ghost" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = '')}>
                {copy.list.cancel}
              </Button>
            </div>
          {:else}
            <div class="buttons">
              <Button variant="ghost" size="sm" type="button" disabled={busy !== ''} onclick={() => (confirming = routine.routine_id)}>
                {copy.list.delete}
              </Button>
            </div>
          {/if}
        {/if}
        {#if error && expanded}<p class="warning" role="alert">{error}</p>{/if}
      </div>
    </li>
  {/each}
</ul>
</div>

<style>
  .routine-tree { margin-block-end: var(--shimpz-space-1); }
  .nodes { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .node { position: relative; display: grid; }
  /* Tree lines: a guide from the Team's monogram down the list, with one branch into each node. */
  .node::before { content: ""; position: absolute; inset-block: 0; inset-inline-start: var(--routine-guide); border-inline-start: 1px solid var(--shimpz-color-border); }
  .node:last-child::before { inset-block-end: auto; height: 1.35rem; }
  .node::after { content: ""; position: absolute; inset-block-start: 1.35rem; inset-inline-start: var(--routine-guide); width: calc(var(--routine-indent) - var(--routine-guide) - 0.35rem); border-block-start: 1px solid var(--shimpz-color-border); }
  /* The toggle is the shared Button with its chrome removed; hover, focus, and the open node answer with the Team row's
     chamfered scanline tint as a layer, so the keyboard focus ring is never clipped. */
  .nodes .node :global(.node-toggle) { position: relative; isolation: isolate; display: block; width: 100%; height: auto; min-height: 2.5rem; padding: 0.4rem var(--shimpz-space-3) 0.4rem var(--routine-indent); color: var(--shimpz-color-text-muted); background: transparent; border: 0; clip-path: none; box-shadow: none; text-align: start; text-transform: none; letter-spacing: normal; font: inherit; }
  .nodes .node :global(.node-toggle .button-content) { display: grid; justify-content: stretch; gap: 1px; min-width: 0; }
  .nodes .node :global(.node-toggle::before) { content: ""; position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); pointer-events: none; }
  .nodes .node :global(.node-toggle:hover), .nodes .node :global(.node-toggle:focus-visible), .nodes .is-open > :global(.node-toggle) { color: var(--shimpz-color-text); background: transparent; box-shadow: none; }
  .nodes .node :global(.node-toggle:hover::before), .nodes .node :global(.node-toggle:focus-visible::before), .nodes .is-open > :global(.node-toggle::before) { background: var(--team-scanlines), var(--team-hover-bg); }
  .nodes .node :global(.node-toggle:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; }
  .quote { overflow: hidden; font: 500 0.82rem/1.3 var(--shimpz-font-sans); text-overflow: ellipsis; white-space: nowrap; }
  .meta, .warning { margin: 0; font-size: 0.72rem; line-height: 1.4; overflow-wrap: anywhere; }
  .meta { color: var(--shimpz-color-text-dim); font-variant-numeric: tabular-nums; }
  .warning { color: var(--shimpz-color-danger); }
  .flag { justify-self: start; margin-block-start: 2px; color: var(--shimpz-color-cyan); font: 700 0.62rem/1 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .flag.waiting { color: var(--shimpz-color-yellow); }
  .flag.bad { color: var(--shimpz-color-danger); }
  .detail[hidden] { display: none; }
  .detail { display: grid; gap: var(--shimpz-space-1); padding: var(--shimpz-space-1) var(--shimpz-space-3) var(--shimpz-space-2) var(--routine-indent); }
  .actions-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: 0.72rem; overflow-wrap: anywhere; }
  .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: var(--shimpz-space-2); }
</style>
