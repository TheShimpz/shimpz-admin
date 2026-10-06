<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { locale } from '$lib/i18n.js';
  import RoutineDetailsDialog from '$lib/RoutineDetailsDialog.svelte';
  import RoutineRunView from '$lib/RoutineRunView.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import { decisionWords, routineErrorMessage, routineNotice, routineStatus } from '$lib/routine.js';
  import { formatTaskUsage, formatTaskUsageDetail, taskUsageSummary } from '$lib/taskUsage.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as one line of an activity timeline: the notice's time on the timeline's rail, the Routine's name, a
  // status phrase colored by meaning, and the run's usage when its notice carries one, read by the chat's own usage
  // formatter. Consecutive notices share one thin rail through their times (`joinAbove`, `joinBelow`).
  // The name is only the one Team froze into this notice (ADR-0101), never the live Routine list and never a request,
  // so a reloaded transcript reads alike and a Routine's last notice, its removal, still names it. A completed run's
  // decision says what it decided in Team's escaped words, and a run that lost its secret-value protection says so.
  // A run's name opens the run in full instead of filling the timeline: the result it shows, when it shows one, and its
  // own step records with each step's parameters. A notice without a run keeps its name as text. It never carries an
  // Action's raw input or result, and it is not part of the Brain's conversation. Every name and value is plain text.
  // The entry decides nothing: while its run waits for the person, its other action opens that Routine's panel, which
  // is the decision itself.
  let { entry, copy, usageCopy, teamId, teamName, joinAbove = false, joinBelow = false } = $props();

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
  let opener = $state();
  let panel = $state(false);
  let viewing = $state(false);
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

  // Closing the run view returns focus to the name that opened it.
  async function closeView() {
    viewing = false;
    await tick();
    opener?.focus();
  }

  let routineName = $derived(entry.name);
  let decision = $derived(entry.detail.decision ? decisionWords(entry.detail.decision, copy) : '');
  let shown = $derived(routineNotice(entry, { copy, locale: $locale }));
  let usage = $derived(entry.usage ? taskUsageSummary(entry.usage) : null);
</script>

<div
  class={['routine-run', `tone-${shown.tone}`, joinAbove && 'join-above', joinBelow && 'join-below']}
  role="group"
  aria-label={routineName}
  tabindex="-1"
  bind:this={notice}
>
  <p class="head">
    {#if entry.runId}
      <Button class="name" size="sm" variant="ghost" type="button" aria-haspopup="dialog" bind:element={opener}
        onclick={() => (viewing = true)}>{routineName}</Button>
    {:else}
      <span class="name">{routineName}</span>
    {/if}
    <span class="status">{shown.status}</span>
    {#if usage}
      <span class="usage" title={usage.detail.length ? formatTaskUsageDetail(usage, $locale, usageCopy) : undefined}
        >{formatTaskUsage(usage, $locale, usageCopy)}</span>
    {/if}
  </p>
  {#if decision}<p class="decision">{decision}</p>{/if}
  {#if entry.protectionLost}<p class="lost">{copy.notice.protectionLost}</p>{/if}
  <time class="time" datetime={entry.createdAt}>{shown.time}</time>
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

{#if viewing && entry.runId}
  <RoutineRunView {teamId} {entry} {routine} name={routineName} status={shown.status} tone={shown.tone} {copy}
    onclose={closeView} />
{/if}

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
   * A timeline entry, never a card: the notice's time sits on a thin rail at the start, and the Routine's name, status,
   * and usage read as one line beside it. The rail is two hairline segments that stop short of the
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

  /* The name, status, and usage wrap as one phrase. */
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

  /* A run's name opens it in full and reads as a link: the name's own words, no frame, underlined on hover. */
  .head :global(.shimpz-button.name) {
    --button-color: var(--shimpz-color-text);
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-cyan);
    --button-hover-bg: transparent;
    max-width: 100%;
    min-height: 0;
    padding: 0;
    border-width: 0;
    font: 600 0.95rem/var(--head-line) var(--shimpz-font-sans);
    letter-spacing: 0;
    text-align: start;
    text-transform: none;
    text-underline-offset: 0.2em;
    vertical-align: baseline;
    clip-path: none;
  }

  .head :global(.shimpz-button.name:hover) {
    box-shadow: none;
    text-decoration: underline;
  }

  .head :global(.shimpz-button.name:focus-visible) { outline-offset: 2px; }

  .status {
    color: var(--tone);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .usage {
    color: var(--shimpz-color-text-dim);
    font: 500 0.68rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .usage::before { content: '· '; }

  .routine-run .wait,
  .routine-run .decision,
  .routine-run .lost,
  .routine-run .result {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    white-space: normal;
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
  .routine-run .decision { color: var(--shimpz-color-text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  .routine-run .lost { color: var(--shimpz-color-yellow); }

  @media (max-width: 40rem) {
    .routine-run .head,
    .head :global(.shimpz-button.name) { font-size: 0.9rem; }
  }
</style>
