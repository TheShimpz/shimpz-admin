<script>
  import { Button, Modal, Notice } from '@shimpz/frontend';

  import { listChatHistory } from '$lib/chatHistory.js';
  import DialogAction from '$lib/DialogAction.svelte';
  import { locale } from '$lib/i18n.js';
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import {
    ATTENTION_STATUSES,
    deleteRoutine,
    fillParts,
    fillRoutineCopy,
    instantWords,
    pauseRoutine,
    resumeRoutine,
    routineErrorMessage,
    routineStatus,
    STATUS_TAGS,
    STATUS_WORDS,
    stopRoutineRun,
    untilWords,
  } from '$lib/routine.js';
  import { dropTeamRoutine, loadTeamRoutines } from '$lib/routineContext.js';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';

  // One Routine in full (ADR-0086, ADR-0092), as three pages behind a tab menu: its summary (what was asked, when it
  // runs, and why it stopped), its steps, and its runs with their execution details. The menu's far end keeps one icon
  // per action on every page: Pause or Resume, and Delete, which asks for a confirmation first.
  let { teamId, routine, runs = [], incidents = [], copy, onclose, ondeleted } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let recent = $state(null);
  let recentFailed = $state(false);
  let detailsRun = $state('');
  let page = $state('summary');
  // The summary says the time now in the Routine's timezone, kept to the minute while the panel is open.
  let now = $state(Date.now());
  const PAGES = [
    { id: 'summary', icon: 'clock' },
    { id: 'steps', icon: 'step' },
    { id: 'runs', icon: 'terminal' },
  ];

  let status = $derived(routineStatus(routine, runs, incidents));
  let live = $derived(runs.filter((run) => run.routine_id === routine.routine_id));
  let word = $derived(STATUS_WORDS[status]);
  // Why a paused or failed Routine stopped, said once on its summary page.
  let reason = $derived({
    recovery: copy.panel.heldNote,
    reconfirm: copy.list.needsReconfirm,
    waiting: copy.panel.waitingNote,
    deleting: copy.status.deleting,
  }[status]);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 20_000);
    return () => clearInterval(timer);
  });

  let summary = $derived(fillParts(copy.panel.summaryLine, {
    request: routine.quote.replace(/[\s.。．!！]+$/u, ''),
    timezone: routine.timezone,
    now: instantWords(now, $locale, routine.timezone),
  }));
  let until = $derived(untilWords(routine.next_run_at, now, $locale));

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
      held: copy.status.failed,
      paused: copy.status.paused,
      frozen: copy.panel.waitingApproval,
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

  // The tab menu follows the ARIA tabs pattern: arrow keys, Home, and End move between pages and select them.
  function moveTab(event) {
    const last = PAGES.length - 1;
    const index = PAGES.findIndex((item) => item.id === page);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = {
      [rtl ? 'ArrowLeft' : 'ArrowRight']: (index + 1) % PAGES.length,
      [rtl ? 'ArrowRight' : 'ArrowLeft']: (index + last) % PAGES.length,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    page = PAGES[next].id;
    document.getElementById(`${id}-tab-${page}`)?.focus();
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
      <h2 id={`${id}-title`}>{routine.name}</h2>
      {#if word}<RoutineTag label={copy.status[word]} icon={STATUS_TAGS[word].icon} tone={STATUS_TAGS[word].tone} />{/if}
      <Button class="close" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.list.close} title={copy.list.close} onclick={close}>
        <RoutineIcon name="close" />
      </Button>
    </header>

    <div class="bar">
    <div class="tabs" role="tablist" aria-label={copy.panel.pages}>
      {#each PAGES as item (item.id)}
        <Button id={`${id}-tab-${item.id}`} class="tab" variant="ghost" size="sm" type="button" role="tab"
          aria-selected={page === item.id} aria-controls={`${id}-page`} tabindex={page === item.id ? 0 : -1}
          onclick={() => (page = item.id)} onkeydown={moveTab}>
          {#snippet icon()}<RoutineIcon name={item.icon} />{/snippet}{copy.panel[item.id]}
        </Button>
      {/each}
    </div>
    <!-- Pause or Resume and Delete as one icon each at the menu's far end; Delete still asks first. -->
    {#if !routine.deleting && !confirming}
      <div class="actions">
        {#if routine.paused}
          <Button class="act act--resume" variant="ghost" size="sm" iconOnly type="button" disabled={busy}
            aria-label={copy.list.resume} title={copy.list.resume}
            onclick={() => act(() => resumeRoutine(fetch, teamId, routine.routine_id))}><RoutineIcon name="play" /></Button>
        {:else}
          <Button class="act act--pause" variant="ghost" size="sm" iconOnly type="button" disabled={busy}
            aria-label={copy.panel.pause} title={copy.panel.pause}
            onclick={() => act(() => pauseRoutine(fetch, teamId, routine.routine_id))}><RoutineIcon name="pause" /></Button>
        {/if}
        <Button class="act act--delete" variant="ghost" size="sm" iconOnly type="button" disabled={busy}
          aria-label={copy.list.delete} title={copy.list.delete} onclick={() => (confirming = true)}><RoutineIcon name="trash" /></Button>
      </div>
    {/if}
    </div>

    <div class="content" id={`${id}-page`} role="tabpanel" aria-labelledby={`${id}-tab-${page}`} tabindex="0">
      {#if page === 'summary'}
        {#if reason}<p class="note"><RoutineIcon name="warning" />{reason}</p>{/if}
        <p class="summary">
          {#each summary as part, index (index)}<span class={part.key && `part part--${part.key}`}>{part.text}</span>{/each}
        </p>
        {#if !ATTENTION_STATUSES.includes(status)}
          <p class="next">
            <RoutineIcon name="step" />
            <span class="next-label">{copy.panel.next}</span>
            <time datetime={routine.next_run_at}>{instantWords(routine.next_run_at, $locale, routine.timezone)}</time>
            {#if until}<span class="until">[{until}]</span>{/if}
          </p>
        {/if}
      {:else if page === 'steps'}
        <RoutinePlan steps={routine.steps} copy={copy.plan} names={$assistantNames} />
      {:else}
        <ul class="runs" aria-label={copy.panel.runs}>
          {#each live as run (run.run_id)}
            <li>
              <RoutineIcon name={run.status === 'held' ? 'warning' : run.status === 'frozen' ? 'approval' : 'spinner'} />
              <span class="run-what">{run.status === 'frozen' ? copy.panel.waitingApproval : run.status === 'held' ? copy.status.failed : copy.panel.runningNow}</span>
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
      {/if}

      {#if confirming}<Notice variant="warning">{copy.list.deleteConfirm}</Notice>{/if}
      {#if error}<Notice variant="error">{error}</Notice>{/if}
    </div>

    {#if confirming}
      <footer class="foot">
        <DialogAction kind="cancel" type="button" disabled={busy} onclick={() => (confirming = false)}>{copy.list.cancel}</DialogAction>
        <DialogAction kind="danger" type="button" disabled={busy} onclick={remove}>{copy.list.delete}</DialogAction>
      </footer>
    {/if}
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
    grid-template-rows: auto auto minmax(0, 1fr) auto;
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
  .note :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  .head :global(.close) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  /* The page menu: mono labels on one rule, the selected page underlined in the panel's one accent. */
  /* The page menu starts at the panel's edge; the Routine's actions sit at its far end. */
  .bar { display: flex; align-items: center; gap: var(--shimpz-space-2); padding-inline-end: var(--shimpz-space-2); border-block-end: 1px solid var(--shimpz-color-border); }
  .tabs { display: flex; flex: 1 1 auto; min-width: 0; padding-block-start: 0.3rem; overflow-x: auto; }
  .actions { display: flex; flex: none; gap: 0.15rem; }
  .actions :global(.act.act) { --button-border: transparent; --button-color: var(--shimpz-color-cyan); --button-hover-color: var(--shimpz-color-cyan); }
  .actions :global(.act.act--delete) { --button-color: var(--shimpz-color-danger); --button-hover-color: var(--shimpz-color-danger); }
  .actions :global(.act.act--delete:hover:not(:disabled)) { box-shadow: none; }
  .tabs :global(.tab) {
    --button-color: var(--shimpz-color-text-dim);
    --button-border: transparent;
    --button-hover-bg: transparent;
    clip-path: none;
    box-shadow: none;
  }
  .tabs :global(.tab:hover:not(:disabled)) { color: var(--shimpz-color-text); border-color: transparent; box-shadow: none; }
  .tabs :global(.tab[aria-selected="true"]) { --button-color: var(--shimpz-color-cyan); box-shadow: inset 0 -2px 0 var(--shimpz-color-cyan); }
  .tabs :global(.tab[aria-selected="true"]:hover) { color: var(--shimpz-color-cyan); box-shadow: inset 0 -2px 0 var(--shimpz-color-cyan); }
  .tabs :global(.tab:focus-visible) { outline: 2px solid var(--shimpz-color-cyan); outline-offset: -2px; }
  /* Every page keeps one height so switching tabs does not resize the panel. */
  .content { align-content: start; min-height: min(17rem, 50dvh); display: grid; gap: var(--shimpz-space-4); min-width: 0; padding: var(--shimpz-space-4); overflow: auto; }
  /* One paragraph in the person's own words; the timezone and the time now read as data. */
  .summary { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; overflow-wrap: break-word; }
  .part { font-family: var(--shimpz-font-mono); font-size: 0.82rem; color: var(--shimpz-color-text-muted); }
  .part--request { font: inherit; color: inherit; }
  /* The next run on one rule-topped line: a cyan step mark, a mono label, the instant, and how far off it is. */
  .next { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; margin: 0; padding-block-start: var(--shimpz-space-3); border-block-start: 1px dashed var(--shimpz-color-border); font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  .next :global(.routine-icon) { width: 0.9rem; height: 0.9rem; color: var(--shimpz-color-cyan); }
  .next-label { color: var(--shimpz-color-text-dim); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
  .next time { color: var(--shimpz-color-cyan); }
  .until { color: var(--shimpz-color-text-dim); }
  .note { display: flex; align-items: flex-start; gap: 0.5rem; margin: 0; padding: 0.55rem 0.7rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.8rem; line-height: 1.45; }
  .note :global(.routine-icon) { margin-block-start: 0.15rem; }
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
  @media (forced-colors: active) { .bar { border-color: CanvasText; } }
  /* On a phone the panel is a full-screen sheet. */
  @media (max-width: 600px) {
    .head { flex-wrap: wrap; }
    h2 { flex-basis: 8rem; }
    .head :global(.tag) { order: 4; margin-inline-start: calc(1rem + var(--shimpz-space-2)); }
    .head :global(.close) { order: 3; }
    :global(dialog.shimpz-modal.routine-panel) { width: 100dvw; max-width: none; height: 100dvh; max-height: none; margin: 0; }
    .frame { height: 100dvh; max-height: 100dvh; clip-path: none; }
  }
  @media (forced-colors: active) {
    .frame, .note { border-color: CanvasText; }
    .tabs :global(.tab[aria-selected="true"]) { border-block-end: 2px solid Highlight; }
  }
</style>
