<script>
  import { Button, Notice } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import ChoiceBrowser from '$lib/ChoiceBrowser.svelte';
  import { locale, t } from '$lib/i18n.js';
  import { fillRoutineCopy, routineStatus, scheduleWords, STATUS_TAGS, STATUS_WORDS } from '$lib/routine.js';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import RoutineModal from '$lib/RoutineModal.svelte';
  import { loadTeamRoutines } from '$lib/routineContext.js';

  // One Team's Routines as a choice modal (ADR-0086): each its clock tinted by its status, its name, and when it runs;
  // the status is said in words only to assistive technology. Choosing one turns the modal into that Routine's panel,
  // whose Back (or Escape) returns to the list on the same Routine. `onclose` hears when the person leaves, or when the
  // Team has no Routine left to list. While the Team's newest listing `failed`, the list says so above what it last knew
  // and offers to read it again.
  let { teamName, teamId, routines = [], runs = [], incidents = [], failed = false, onclose } = $props();

  let copy = $derived($t('routine'));
  let dialog = $state();
  let open = $state('');
  // The Routine the list puts focus on when it opens again.
  let last = $state('');
  let retrying = $state(false);
  let opened = $derived(routines.find((routine) => routine.routine_id === open));

  let items = $derived(routines.map((routine) => {
    const word = STATUS_WORDS[routineStatus(routine, runs, incidents)];
    return {
      id: routine.routine_id,
      icon: 'clock',
      tone: STATUS_TAGS[word]?.tone,
      label: routine.name,
      description: scheduleWords(routine.schedule, copy.schedule, $locale),
      status: word ? copy.status[word] : '',
    };
  }));

  $effect(() => {
    if (routines.length === 0 && !failed) onclose();
  });

  async function focusList() {
    await tick();
    const row = dialog?.querySelector(`[data-choice="${last}"]`) ?? dialog?.querySelector('[data-choice]') ??
      dialog?.querySelector('.retry');
    row?.focus();
  }

  // A retry that fails again keeps the error; one that succeeds replaces it with the list, or closes an empty one.
  async function retry() {
    retrying = true;
    try {
      await loadTeamRoutines(fetch, teamId);
    } catch {
      // The Team's listing stays marked as failed.
    } finally {
      retrying = false;
    }
  }

  function choose(routineId) {
    last = routineId;
    dialog?.close();
    open = routineId;
  }

  function close(event) {
    event?.preventDefault();
    dialog?.close();
    onclose();
  }
</script>

{#if opened}
  <RoutineDetailsDialog
    {teamId}
    {teamName}
    routine={opened}
    runs={runs.filter((run) => run.routine_id === opened.routine_id)}
    incidents={incidents.filter((item) => item.routine_id === opened.routine_id)}
    {copy}
    onback={() => (open = '')}
    onclose={() => onclose()}
    ondeleted={() => (routines.length === 0 ? onclose() : (open = ''))}
  />
{:else}
  <RoutineModal bind:dialog class="routine-list" size="md" open title={fillRoutineCopy(copy.list.title, { team: teamName })}
    oncancel={close} onclose={close} onopen={focusList}>
    <div class="body">
      {#if failed}
        <div class="failed">
          <Notice variant="error">{copy.errors.unavailable}</Notice>
          <Button class="retry" variant="ghost" size="sm" type="button" disabled={retrying} onclick={retry}>{copy.list.retry}</Button>
        </div>
      {/if}
      {#if routines.length > 0}
        <ChoiceBrowser label={copy.list.open} {items} copy={copy.list} initial={last} onchoose={choose} />
      {/if}
    </div>
  </RoutineModal>
{/if}

<style>
  /* The search, the list, and its pages sit under the header that asks the question; the list reaches the frame's
     edges and scrolls inside the modal when it is long. */
  .body {
    --choice-inline: var(--shimpz-space-4);
    --choice-ask-align: center;
    --choice-rule: 0;
    --choice-list-border: 1px solid var(--shimpz-color-border);
    min-height: 0;
    padding-inline: var(--choice-inline);
    padding-block: 0 var(--shimpz-space-4);
    overflow: auto;
  }
  .failed { display: grid; justify-items: start; gap: var(--shimpz-space-2); padding-block: var(--shimpz-space-2); }
</style>
