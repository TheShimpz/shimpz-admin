<script>
  import { Button, Disclosure } from '@shimpz/frontend';

  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import RoutineDecision from '$lib/RoutineDecision.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import {
    fillRoutineCopy,
    humanizeId,
    minuteWords,
    OUTCOME_TONES,
    resumeRoutine,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as one card: the Routine's name and a neutral badge, the state in one sentence, and its actions. It
  // never carries an Action's raw input or result, and it is not part of the Brain's conversation. A held, paused, or
  // frozen run carries the decision it waits for, the same one its Routine's panel offers.
  let { entry, copy, teamId, teamName } = $props();

  const DECISIONS = ['held', 'paused', 'frozen'];
  let working = $state(false);
  let result = $state('');
  // The run's execution details are read from Team only when the person opens them.
  let details = $state(false);

  // A row that left its Routine paused offers Resume while Team still lists the Routine as paused and no unresolved
  // incident holds it; a held run is settled through its card first, and resuming never bypasses that (ADR-0092).
  let listed = $derived($routineContext.get(teamId));
  let resumable = $derived(
    ['paused', 'user-skipped', 'failed'].includes(entry.outcome) &&
      Boolean(listed?.routines.some((routine) => routine.routine_id === entry.routineId && routine.paused &&
        !routine.deleting && !routine.needs_reconfirm)) &&
      !listed.incidents.some((incident) => incident.routine_id === entry.routineId),
  );

  async function resume() {
    working = true;
    result = '';
    try {
      await resumeRoutine(fetch, teamId, entry.routineId);
      result = copy.run.resumed;
      await loadTeamRoutines(fetch, teamId);
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
    } finally {
      working = false;
    }
  }
  let detail = $derived(entry.detail);
  // Assistants and Actions are named in words: the catalog's title, or the humanized id until it is read.
  $effect(() => { void loadAssistantNames(fetch); });
  function stepWords(assistant, action) {
    return fillRoutineCopy(copy.plan.step, { assistant: $assistantNames[assistant] ?? humanizeId(assistant), action: humanizeId(action) });
  }
  let actions = $derived((detail.actions ?? []).map(([assistant, action]) => stepWords(assistant, action)).join(', '));
  // The Routine's short name: as Team lists it now, as the notice defined it, or else its request.
  let routineName = $derived(
    listed?.routines.find((routine) => routine.routine_id === entry.routineId)?.name ?? detail.name ?? entry.quote,
  );
  const BADGES = { 'user-skipped': 'userSkipped', 'scope-changed': 'scopeChanged' };
  let badge = $derived(copy.badge[BADGES[entry.outcome] ?? entry.outcome]);
  let summary = $derived.by(() => {
    const run = copy.run;
    switch (entry.outcome) {
      case 'done': return run.done;
      case 'recovered': return run.recovered;
      case 'user-skipped': return run.userSkipped;
      case 'failed': return fillRoutineCopy(run.failed, { code: detail.code });
      case 'denied': return run.denied;
      case 'stopped': return run.stopped;
      case 'skipped': return fillRoutineCopy(run.skipped, { missed: detail.missed });
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

<div class="routine-run" role="group" aria-labelledby={`${id}-name`}>
  <header class="head">
    <RoutineIcon name="clock" />
    <!-- The card's name labels its group; a heading here would skip a level inside the chat. -->
    <p class="name" id={`${id}-name`} title={entry.quote}>{routineName}</p>
    <RoutineTag label={badge} icon={TAG_ICONS[entry.outcome]} tone={OUTCOME_TONES[entry.outcome] ?? 'neutral'} />
    {#if entry.runId}
      <Button
        class="details"
        variant="ghost"
        size="sm"
        iconOnly
        type="button"
        aria-label={copy.details.open}
        title={copy.details.open}
        onclick={() => (details = true)}
      ><RoutineIcon name="terminal" /></Button>
    {/if}
  </header>

  <div class="body">
    {#if DECISIONS.includes(entry.outcome)}
      <RoutineDecision {teamId} {teamName} runId={entry.runId} routineId={entry.routineId} outcome={entry.outcome} {detail} {copy} />
    {:else}
      <p class="line"><span class="prompt" aria-hidden="true">&gt;</span><span class="value">{line}</span></p>
      {#if actionsLine}<p class="line muted">{actionsLine}</p>{/if}
    {/if}
    {#if entry.outcome === 'created' || entry.outcome === 'changed'}
      <Disclosure class="steps">
        {#snippet summary()}<span class="steps-summary"><RoutineIcon name="chevron" />{copy.plan.title} · {detail.steps.length}</span>{/snippet}
        <RoutinePlan steps={detail.steps} copy={copy.plan} names={$assistantNames} />
      </Disclosure>
    {/if}
    {#if result}<p class="result" role="status">{result}</p>{/if}
  </div>

  {#if resumable}
    <div class="actions">
      <Button size="sm" variant="secondary" type="button" disabled={working} onclick={resume}>
        {#snippet icon()}<RoutineIcon name="play" />{/snippet}{copy.list.resume}
      </Button>
    </div>
  {/if}
</div>

{#if details}
  <RoutineRunDetails {teamId} runId={entry.runId} copy={copy.details} errors={copy.errors} onclose={() => (details = false)} />
{/if}

<style>
  /* One chamfered shell in neutrals: state color lives on small icons. */
  .routine-run {
    container-type: inline-size;
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
  .head :global(.details) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  @container (max-width: 30rem) {
    .head :global(.tag) { order: 4; margin-inline-start: calc(1rem + var(--shimpz-space-2)); }
    .head :global(.details) { order: 3; }
  }
  .body { display: grid; gap: 0.4rem; padding: var(--shimpz-space-3) var(--shimpz-space-4); min-width: 0; }
  /* A decision's choice group closes the card along its bottom edge. */
  .body:has(:global(.choices)) { padding-block-end: 0; }
  .body { --decision-inline: var(--shimpz-space-4); }
  /* Terminal lines flow as text, so a narrow card wraps words, never whole pieces of the line. */
  .line { margin: 0; font: 400 0.78rem/1.55 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .line > * + * { margin-inline-start: 0.5em; }
  .line :global(.routine-icon) { width: 0.85rem; height: 0.85rem; margin-inline-end: 0.5em; vertical-align: -0.15em; }
  .line.muted { color: var(--shimpz-color-text-muted); }
  .prompt { color: var(--shimpz-color-cyan); }
  .value { color: var(--shimpz-color-text); }
  .muted { color: var(--shimpz-color-text-muted); }
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
