<script>
  import { Button, Disclosure } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import {
    fillRoutineCopy,
    humanizeId,
    minuteWords,
    OUTCOME_TONES,
    routineErrorMessage,
    routineStatus,
    scheduleWords,
  } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as one card: the Routine's name and a neutral badge, and the state in one sentence. It never carries
  // an Action's raw input or result, and it is not part of the Brain's conversation. The card decides nothing: while
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

  let card = $state();
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

  // Closing the panel returns focus to the button that opened it, or to the card once its run no longer waits.
  async function closePanel() {
    panel = false;
    await tick();
    (card?.querySelector('.open') ?? card)?.focus();
  }

  let detail = $derived(entry.detail);
  // Assistants and Actions are named in words: the catalog's title, or the humanized id until it is read.
  $effect(() => { void loadAssistantNames(fetch); });
  function assistantWords(assistant) {
    return $assistantNames[assistant] ?? humanizeId(assistant);
  }
  function stepWords(assistant, action) {
    return fillRoutineCopy(copy.plan.step, { assistant: assistantWords(assistant), action: humanizeId(action) });
  }
  let actions = $derived((detail.actions ?? []).map(([assistant, action]) => stepWords(assistant, action)).join(', '));
  // The Routine's short name: as Team lists it now, as the notice defined it, or else its request.
  let routineName = $derived(
    listed?.routines.find((item) => item.routine_id === entry.routineId)?.name ?? detail.name ?? entry.quote,
  );
  const BADGES = { 'user-skipped': 'userSkipped', 'scope-changed': 'scopeChanged' };
  let badge = $derived(copy.badge[BADGES[entry.outcome] ?? entry.outcome]);
  let summary = $derived.by(() => {
    const run = copy.run;
    switch (entry.outcome) {
      case 'done': return run.done;
      case 'recovered': return run.recovered;
      case 'user-skipped': return run.userSkipped[detail.choice];
      case 'failed': return fillRoutineCopy(run.failed, { code: detail.code });
      case 'denied': return run.denied;
      case 'stopped': return run.stopped;
      case 'skipped': return fillRoutineCopy(run.skipped, { missed: detail.missed });
      // What a waiting run waits for, in one plain sentence; the decision itself is in the Routine's panel.
      case 'held': return copy.card.heldLead;
      case 'paused': return fillRoutineCopy(run.paused, { reason: run.pauseReasons[detail.reason] ?? '' });
      case 'frozen':
        return fillRoutineCopy(detail.request_kind === 'human' ? run.frozenHuman : run.frozenIntegrations, {
          assistant: assistantWords(detail.assistant_id),
          action: humanizeId(detail.action),
        });
      // A minute's rollup is dated by the minute it covers, in the viewer's own time.
      case 'healthy': return fillRoutineCopy(run.healthy, { runs: detail.runs, minute: minuteWords(entry.createdAt, $locale) });
      case 'scope-changed': return fillRoutineCopy(run.scopeChanged, { assistants: detail.assistants.join(', ') });
      case 'created':
      case 'changed':
        return fillRoutineCopy(entry.outcome === 'created' ? run.created : run.changed, {
          name: detail.name,
          schedule: scheduleWords(detail.schedule, copy.schedule, $locale),
          timezone: detail.timezone,
        });
      default: return '';
    }
  });
  // The status tag's icon: state color lives only on these small icons.
  const TAG_ICONS = {
    held: 'warning', paused: 'pause', 'scope-changed': 'pause', done: 'check', recovered: 'check', failed: 'failed',
    denied: 'stop', stopped: 'stop', 'user-skipped': 'skip', skipped: 'skip', frozen: 'approval', created: 'plus',
    changed: 'edit', healthy: 'activity',
  };
  // The one mono line of a notice: what it changed or did, never a repeat of the name and badge in its header.
  let line = $derived.by(() => {
    if (entry.outcome === 'created' || entry.outcome === 'changed') {
      return `${scheduleWords(detail.schedule, copy.schedule, $locale)} · ${detail.timezone}`;
    }
    if ((entry.outcome === 'done' || entry.outcome === 'recovered') && actions) return actions.replaceAll(' · ', ' › ');
    return summary;
  });
  let actionsLine = $derived(line === summary && actions ? fillRoutineCopy(copy.run.actions, { actions }) : '');
  const id = $props.id();
</script>

<div class="routine-run" role="group" aria-labelledby={`${id}-name`} tabindex="-1" bind:this={card}>
  <header class="head">
    <RoutineIcon name="clock" />
    <!-- The card's name labels its group; a heading here would skip a level inside the chat. -->
    <p class="name" id={`${id}-name`} title={entry.quote}>{routineName}</p>
    <RoutineTag label={badge} icon={TAG_ICONS[entry.outcome]} tone={OUTCOME_TONES[entry.outcome] ?? 'neutral'} />
  </header>

  <div class="body">
    <p class="line"><span class="prompt" aria-hidden="true">&gt;</span><span class="value">{line}</span></p>
    {#if actionsLine}<p class="line muted">{actionsLine}</p>{/if}
    {#if entry.outcome === 'created' || entry.outcome === 'changed'}
      <Disclosure class="steps">
        {#snippet summary()}<span class="steps-summary"><RoutineIcon name="chevron" />{copy.plan.title} · {detail.steps.length}</span>{/snippet}
        <RoutinePlan steps={detail.steps} copy={copy.plan} names={$assistantNames} />
      </Disclosure>
    {/if}
    {#if result}<p class="result" role="status">{result}</p>{/if}
  </div>

  <!-- The button stays while the panel is open, so closing it returns focus here. -->
  {#if waiting || panel}
    <div class="actions">
      <Button class="open" size="sm" variant="secondary" type="button" aria-haspopup="dialog" disabled={opening}
        onclick={openPanel}>{copy.run.open}</Button>
    </div>
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
  /* One chamfered shell in neutrals: state color lives on small icons. */
  .routine-run {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    max-width: 44rem;
    color: var(--shimpz-color-text);
    background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, 0 100%);
  }
  :global([dir="rtl"]) .routine-run { clip-path: polygon(var(--shimpz-cut-lg) 0, 100% 0, 100% 100%, 0 100%, 0 var(--shimpz-cut-lg)); }
  .head {
    display: flex;
    align-items: center;
    gap: var(--shimpz-space-2);
    min-height: 2.6rem;
    padding: 0.35rem var(--shimpz-space-2) 0.35rem var(--shimpz-space-4);
    color: var(--shimpz-color-text-dim);
    background: repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 4%, transparent) 2px 3px);
    border-block-end: 1px solid var(--shimpz-color-border);
  }
  .head { flex-wrap: wrap; }
  .name { flex: 1 1 8rem; min-width: 0; margin: 0; overflow: hidden; color: var(--shimpz-color-text); font: 500 0.9rem/1.3 var(--shimpz-font-sans); text-overflow: ellipsis; white-space: nowrap; }
  .body { display: grid; gap: 0.4rem; padding: var(--shimpz-space-3) var(--shimpz-space-4); min-width: 0; }
  /* Terminal lines flow as text, so a narrow card wraps words, never whole pieces of the line. */
  .line { margin: 0; font: 400 0.78rem/1.55 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .line > * + * { margin-inline-start: 0.5em; }
  .line.muted { color: var(--shimpz-color-text-muted); }
  .prompt { color: var(--shimpz-color-cyan); }
  .value { color: var(--shimpz-color-text); }
  .result { margin: 0; color: var(--shimpz-color-text); font-size: 0.85rem; line-height: 1.45; }
  .body :global(.steps) { border-block-start: 0; padding-block-start: 0.25rem; }
  .body :global(.steps summary) { list-style: none; }
  .body :global(.steps summary::-webkit-details-marker) { display: none; }
  .steps-summary { display: inline-flex; align-items: center; gap: 0.35rem; }
  .steps-summary :global(.routine-icon) { width: 0.8rem; height: 0.8rem; transition: transform var(--shimpz-duration-fast) var(--shimpz-ease); }
  :global([dir="rtl"]) .steps-summary :global(.routine-icon) { transform: scaleX(-1); }
  .body :global(.steps[open] .routine-icon) { transform: rotate(90deg); }

  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); padding: 0 var(--shimpz-space-4) var(--shimpz-space-4); }
  .head :global(.tag--neutral.tag) :global(.routine-icon--failed) { color: var(--shimpz-color-danger); }
  @media (forced-colors: active) { .routine-run { border-color: CanvasText; } }
</style>
