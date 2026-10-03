<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import Markdown from '$lib/Markdown.svelte';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import { humanizeId, routineErrorMessage, routineNoticeMarkdown, routineStatus } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as an ordinary chat message: one or two sentences naming the Routine in bold. It never carries an
  // Action's raw input or result, and it is not part of the Brain's conversation. The message decides nothing: while
  // its run waits for the person, its one action opens that Routine's panel, which is the decision itself.
  let { entry, copy, teamId, teamName } = $props();

  let listed = $derived($routineContext.get(teamId));
  let routine = $derived(listed?.routines.find((item) => item.routine_id === entry.routineId && !item.deleting));
  // The run waits for the person while its Routine's panel shows its decision: a held or paused run until its
  // incident is settled, a frozen run until its approval is answered.
  let waiting = $derived.by(() => {
    if (!routine) return false;
    const status = routineStatus(routine, listed.runs, listed.incidents);
    if (entry.outcome === 'held' || entry.outcome === 'paused') return status === 'recovery';
    return entry.outcome === 'frozen' && status === 'waiting' &&
      listed.runs.some((run) => run.run_id === entry.runId && run.status === 'frozen');
  });

  let notice = $state();
  let panel = $state(false);
  let opening = $state(false);
  let result = $state('');

  // The panel opens on the Routine as Team lists it now; a run that stopped waiting meanwhile says so instead.
  async function openPanel() {
    opening = true;
    result = '';
    try {
      await loadTeamRoutines(fetch, teamId);
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
      return;
    } finally {
      opening = false;
    }
    if (waiting) panel = true;
    else result = copy.errors.ended;
  }

  // Closing the panel returns focus to the button that opened it, or to the notice once its run no longer waits.
  async function closePanel() {
    panel = false;
    await tick();
    (notice?.querySelector('.open') ?? notice)?.focus();
  }

  // Assistants are named in words: the catalog's title, or the humanized id until it is read.
  $effect(() => { void loadAssistantNames(fetch); });
  // The Routine's short name: as Team lists it now, as the notice defined it, or else its request.
  let routineName = $derived(
    listed?.routines.find((item) => item.routine_id === entry.routineId)?.name ?? entry.detail.name ?? entry.quote,
  );
  let message = $derived(routineNoticeMarkdown(entry, {
    name: routineName,
    copy,
    locale: $locale,
    assistantName: (id) => $assistantNames[id] ?? humanizeId(id),
    waiting,
  }));
</script>

<div class="routine-run" role="group" aria-label={routineName} tabindex="-1" bind:this={notice}>
  <Markdown markdown={message} variant="chat" />
  {#if result}<p class="result" role="status">{result}</p>{/if}
  <!-- The button stays while the panel is open, so closing it returns focus here. -->
  {#if waiting || panel}
    <Button class="open" size="sm" variant="ghost" type="button" aria-haspopup="dialog" disabled={opening}
      onclick={openPanel}>{copy.run.open}</Button>
  {/if}
</div>

{#if panel && routine}
  <RoutineDetailsDialog
    {teamId}
    {teamName}
    {routine}
    runs={listed.runs.filter((run) => run.routine_id === routine.routine_id)}
    incidents={listed.incidents.filter((item) => item.routine_id === routine.routine_id)}
    {copy}
    onclose={closePanel}
  />
{/if}

<style>
  /* A notice reads as a reply: the chat's own text, with its one action a quiet button below it. */
  .routine-run { display: grid; justify-items: start; gap: var(--shimpz-space-2); min-width: 0; }
  .result { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.85rem; line-height: 1.45; }
</style>
