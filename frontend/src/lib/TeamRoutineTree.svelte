<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { locale, t } from '$lib/i18n.js';
  import { routineStatus, scheduleWords, STATUS_TONES } from '$lib/routine.js';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';

  // One Team's Routines as a compact, monochrome list under its row (ADR-0086): each a neutral status mark, its short
  // name, and when it runs. Words for its status appear only when it needs the person; the only accent is the dot on
  // the Team's Routines button. Opening a Routine shows it in full in a panel.
  let { teamId, routines = [], runs = [], incidents = [] } = $props();

  let copy = $derived($t('routine'));
  let open = $state('');
  let root = $state();
  let opened = $derived(routines.find((routine) => routine.routine_id === open));

  // Focus returns to the Routine the panel was opened from, or after a deletion to the Team's Routines button.
  async function closed(deleted = false) {
    const routineId = open;
    // The Team row is found before the list re-renders: deleting the last Routine removes this list itself.
    const team = root?.closest('li');
    open = '';
    await tick();
    const item = team?.querySelector(`[data-routine="${routineId}"]`);
    const fallback = team?.querySelector('.routines-action') ?? team?.querySelector('.team-actions button');
    (deleted || !item ? fallback : item)?.focus();
  }
</script>

<div bind:this={root} class="routine-list" role="group" aria-label={copy.list.open}>
  <ul>
    {#each routines as routine (routine.routine_id)}
      {@const status = routineStatus(routine, runs, incidents)}
      {@const tone = STATUS_TONES[status]}
      <li>
        <Button
          class="routine-item"
          data-routine={routine.routine_id}
          variant="ghost"
          type="button"
          aria-haspopup="dialog"
          onclick={() => (open = routine.routine_id)}
        >
          <span class={['mark', tone && `mark--${tone}`]} aria-hidden="true"><RoutineIcon name="clock" /></span>
          <span class="text">
            <span class="name">{routine.name}</span>
            <span class="meta">{scheduleWords(routine.schedule, copy.schedule, $locale)}</span>
            {#if tone}
              <span class="flag"><RoutineTag label={copy.status[status]} {tone} size="xs" /></span>
            {:else}
              <span class="sr-only">{copy.status[status]}</span>
            {/if}
          </span>
        </Button>
      </li>
    {/each}
  </ul>
</div>

{#if opened}
  <RoutineDetailsDialog
    {teamId}
    routine={opened}
    runs={runs.filter((run) => run.routine_id === opened.routine_id)}
    incidents={incidents.filter((item) => item.routine_id === opened.routine_id)}
    {copy}
    onclose={() => closed()}
    ondeleted={() => closed(true)}
  />
{/if}

<style>
  .routine-list { margin-block-end: var(--shimpz-space-1); }
  ul { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
  /* The item is the shared Button with its chrome removed; hover and focus answer with the Team row's tint. */
  ul :global(.routine-item) { position: relative; isolation: isolate; display: flex; width: 100%; height: auto; min-height: 2.5rem; align-items: flex-start; justify-content: flex-start; gap: var(--shimpz-space-2); padding: 0.4rem var(--shimpz-space-3) 0.4rem var(--routine-indent); color: var(--shimpz-color-text-muted); background: transparent; border: 0; clip-path: none; box-shadow: none; text-align: start; text-transform: none; letter-spacing: normal; font: inherit; }
  /* A fixed 16px status column, then the name, schedule, and any attention tag on one shared left edge. */
  ul :global(.routine-item .button-content) { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: start; gap: 0 var(--shimpz-space-2); width: 100%; min-width: 0; }
  /* Every row leads with the Team's clock glyph, smaller, faintly tinted by its status. */
  .mark { display: inline-grid; width: 16px; height: 16px; margin-block-start: 1px; place-items: center; color: var(--shimpz-color-text-dim); }
  .mark :global(.routine-icon) { width: 13px; height: 13px; }
  .mark--danger { color: color-mix(in srgb, var(--shimpz-color-danger) 60%, var(--shimpz-color-text-dim)); }
  .mark--warning { color: color-mix(in srgb, var(--shimpz-color-yellow) 55%, var(--shimpz-color-text-dim)); }
  .mark--accent { color: color-mix(in srgb, var(--shimpz-color-cyan) 60%, var(--shimpz-color-text-dim)); }
  .mark--waiting { color: color-mix(in srgb, var(--shimpz-color-magenta) 60%, var(--shimpz-color-text-dim)); }
  ul :global(.routine-item::before) { content: ""; position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); pointer-events: none; }
  ul :global(.routine-item:hover), ul :global(.routine-item:focus-visible) { color: var(--shimpz-color-text); background: transparent; box-shadow: none; }
  ul :global(.routine-item:hover::before), ul :global(.routine-item:focus-visible::before) { background: var(--team-scanlines), var(--team-hover-bg); }
  ul :global(.routine-item:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; }
  .text { display: grid; min-width: 0; gap: 2px; }
  .name { overflow: hidden; color: var(--shimpz-color-text); font: 500 0.82rem/1.3 var(--shimpz-font-sans); text-overflow: ellipsis; white-space: nowrap; }
  .meta { overflow: hidden; color: var(--shimpz-color-text-dim); font-size: 0.72rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
  .flag { justify-self: start; margin-block-start: 0.2rem; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
