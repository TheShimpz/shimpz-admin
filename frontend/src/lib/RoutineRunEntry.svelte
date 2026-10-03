<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import { humanizeId, routineErrorMessage, routineNotice, routineStatus } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as one entry of an activity timeline: the notice's time on the timeline's rail, the Routine's name and a
  // status phrase colored by meaning, then one quiet line of detail. Consecutive notices share one thin rail through
  // their times (`joinAbove`, `joinBelow`).
  // It never carries an Action's raw input or result, and it is not part of the Brain's conversation. Every name and
  // value is plain text. The entry decides nothing: while its run waits for the person, its one action opens that
  // Routine's panel, which is the decision itself.
  let { entry, copy, teamId, teamName, joinAbove = false, joinBelow = false } = $props();

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
  let shown = $derived(routineNotice(entry, {
    copy,
    locale: $locale,
    assistantName: (id) => $assistantNames[id] ?? humanizeId(id),
    steps: routine?.steps ?? [],
  }));
  let details = $derived(shown.lines.length || !shown.code ? shown.lines : ['']);
</script>

<div
  class={['routine-run', `tone-${shown.tone}`, joinAbove && 'join-above', joinBelow && 'join-below']}
  role="group"
  aria-label={routineName}
  tabindex="-1"
  bind:this={notice}
>
  <p class="head"><span class="name">{routineName}</span> <span class="status">{shown.status}</span></p>
  <time class="time" datetime={entry.createdAt}>{shown.time}</time>
  {#each details as line, index (index)}
    <p class="detail">
      {line}{#if shown.code && index === details.length - 1}{line ? ' ' : ''}<code class="code">{shown.code}</code>{/if}
    </p>
  {/each}
  <!-- The button stays while the panel is open, so closing it returns focus here. -->
  {#if waiting || panel}
    <p class="wait">
      {#if waiting}<span class="waiting">{copy.notice.waiting}</span>{/if}
      <Button class="open" size="sm" variant="ghost" type="button" aria-haspopup="dialog" disabled={opening}
        onclick={openPanel}>{copy.run.open}<span class="chevron" aria-hidden="true">›</span></Button>
    </p>
  {/if}
  {#if result}<p class="result" role="status">{result}</p>{/if}
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
  /*
   * A timeline entry, never a card: the notice's time sits on a thin rail at the start, the Routine's name and status
   * read as one phrase beside it, and quieter detail follows. The rail is two hairline segments that stop short of the
   * time, so consecutive notices read as one thread; the segment above reaches back across the gap between transcript
   * exchanges.
   */
  .routine-run {
    --tone: var(--shimpz-color-text-dim);
    --time-column: 3.5rem;
    --head-line: 1.5rem;
    --rail-clearance: 0.1rem;
    position: relative;
    display: grid;
    justify-items: start;
    gap: 0.125rem;
    min-width: 0;
    padding-inline-start: calc(var(--time-column) + var(--shimpz-space-3));
    outline-offset: 4px;
  }

  .tone-healthy { --tone: var(--shimpz-color-cyan); }
  .tone-danger { --tone: var(--shimpz-color-danger); }
  .tone-waiting { --tone: var(--shimpz-color-yellow); }

  .time {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    width: var(--time-column);
    color: var(--shimpz-color-text-dim);
    font: 0.72rem/var(--head-line) var(--shimpz-font-mono);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .join-above::before,
  .join-below::after {
    position: absolute;
    inset-inline-start: calc(var(--time-column) / 2);
    width: 1px;
    background: var(--shimpz-color-border);
    content: '';
  }

  /* Up to the previous notice, across the exchange gap; down to this entry's own bottom edge. */
  .join-above::before {
    inset-block-start: calc(-1 * var(--routine-rail-gap, 1.1rem));
    height: calc(var(--routine-rail-gap, 1.1rem) + var(--rail-clearance));
  }

  .join-below::after {
    inset-block: calc(var(--head-line) - var(--rail-clearance)) 0;
  }

  /* The name and status wrap as one phrase. */
  .routine-run .head {
    width: 100%;
    margin: 0;
    color: var(--shimpz-color-text);
    white-space: normal;
    font-size: 0.95rem;
    line-height: var(--head-line);
    overflow-wrap: anywhere;
  }

  .name { font-weight: 600; }

  .status {
    color: var(--tone);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .routine-run .detail,
  .routine-run .wait,
  .routine-run .result {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    white-space: normal;
  }

  .routine-run .detail {
    color: var(--shimpz-color-text-muted);
    overflow-wrap: anywhere;
  }

  .code {
    display: inline-block;
    padding: 0 0.375rem;
    color: var(--shimpz-color-text-muted);
    font: 0.72rem/1.45 var(--shimpz-font-mono);
    vertical-align: 0.05em;
    border: 1px solid var(--shimpz-color-border);
    border-radius: 3px;
  }

  .routine-run .wait {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: var(--shimpz-space-3);
    margin-block-start: 0.125rem;
  }

  .waiting { color: var(--shimpz-color-yellow); }

  /* The one action reads as a link: cyan words and a chevron, no frame. */
  .wait :global(.shimpz-button.open) {
    --button-color: var(--shimpz-color-cyan);
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: transparent;
    --button-content-gap: 0.3em;
    min-height: 1.5rem;
    padding-inline: 0;
    font: 500 0.85rem/1.5 var(--shimpz-font-sans);
    letter-spacing: 0;
    text-transform: none;
    clip-path: none;
  }

  .wait :global(.shimpz-button.open:focus-visible) { outline-offset: 2px; }

  :global([dir='rtl']) .chevron { display: inline-block; transform: scaleX(-1); }

  .routine-run .result { color: var(--shimpz-color-text-dim); }

  @media (max-width: 40rem) {
    .routine-run .head { font-size: 0.9rem; }
  }
</style>
