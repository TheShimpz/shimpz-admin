<script>
  import { Button, Notice } from '@shimpz/frontend';
  import { tick, untrack } from 'svelte';

  import {
    historyHead,
    MAX_ARRIVED_RUNS,
    mergedRoutineRuns,
    routineRuns,
  } from '#lib/chat/history.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { pauseRoutine, resumeRoutine } from '#lib/routines/protocol.js';
  import {
    ATTENTION_STATUSES,
    clockWords,
    countWords,
    fillParts,
    instantWords,
    routineFailureWords,
    routineNotice,
    routineStatus,
    scheduleWords,
    STATUS_TAGS,
    STATUS_WORDS,
    untilWords,
  } from '#lib/routines/words.js';
  import { refreshTeamRoutines } from '#lib/routines/context.js';
  import { call, commandsReady } from '#lib/session/socket.js';
  import RoutineDecision from '#lib/routines/Decision.svelte';
  import RoutineDeletion from '#lib/routines/Deletion.svelte';
  import RoutinePlan from '#lib/routines/Plan.svelte';
  import RoutineRunDetails from '#lib/routines/run/Details.svelte';
  import RoutineRunView from '#lib/routines/run/View.svelte';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import RoutineModal from '#lib/routines/Modal.svelte';
  import Paging from '#lib/routines/Paging.svelte';
  import { PAGE_SIZE, PagedList } from '#lib/routines/paging.svelte.js';
  import RoutineTag from '#lib/routines/Tag.svelte';
  import { formatRunUsage } from '#lib/chat/usage.js';

  // One Routine in full (ADR-0086, ADR-0092). While a run waits for the person, the whole panel is that decision and
  // nothing else: a held run's recovery choices or a frozen run's approval, with what it needs to decide. Once it is
  // answered the panel returns to its usual pages and actions. Otherwise it shows three pages
  // behind a tab menu: its summary (what was asked, when it runs, and why it stopped), its steps, and its history: each
  // run, healthy rollup, and missed run with its outcome, usage, and time. A run's outcome opens the run in
  // full (the result it shows and its step records), and its icon its execution details. The menu's far end keeps one icon
  // per action on every page: Pause or Resume, and Delete, which turns the whole panel into its confirmation: the
  // Supervisor's password and a second factor, and nothing else until it is deleted or canceled.
  // `runs` and `incidents` are the Team's, which the panel reads for this Routine only. `onback` adds a Back control that
  // returns to the list the panel was opened from; Escape then goes back as well.
  let { teamId, teamName, routine, runs = [], incidents = [], copy, onclose, ondeleted, onback = null } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let deleting = $state(false);
  let deleteButton = $state();
  // The Routine's history, revealed PAGE_SIZE entries at a time: its newest page once read, then its older pages from
  // the cursor where it ends (`next`, null once there are none). Only the newest reading's older reads apply.
  const runPages = new PagedList();
  let runsRead = $state(false);
  let runList = $state();
  let detailsRun = $state(null);
  // The run open in full, and the outcome that opened it, which takes focus back when it closes.
  let viewedRun = $state(null);
  let viewOpener = null;
  let page = $state('summary');
  // The summary says the time now in the Routine's timezone, kept to the second while the panel is open.
  let now = $state(Date.now());
  const PAGES = [
    { id: 'summary', icon: 'clock' },
    { id: 'steps', icon: 'step' },
    { id: 'runs', icon: 'terminal' },
  ];

  let status = $derived(routineStatus(routine, runs, incidents));
  let live = $derived(runs.filter((run) => run.routine_id === routine.routine_id));
  let word = $derived(STATUS_WORDS[status]);
  // Why a paused Routine waits for the chat or is going away, said once on its summary page.
  let reason = $derived({ reconfirm: copy.list.needsReconfirm, deleting: copy.status.deleting }[status]);
  // The run that waits for the person: a held run is its incident (the incident and the run share one id), which names
  // the step it was held at by position, a frozen run its approval. A held run Team lists before its incident names no
  // step until its card does.
  let decision = $derived.by(() => {
    if (status === 'recovery') {
      const incident = incidents.find((item) => item.routine_id === routine.routine_id);
      const held = live.find((run) => run.status === 'held');
      const source = incident ?? { ...held, position: null, steps: null };
      return source.run_id ? {
        runId: source.run_id,
        outcome: 'held',
        detail: { assistant_id: source.assistant_id, action: source.action, position: source.position, steps: source.steps },
      } : null;
    }
    const frozen = status === 'waiting' ? live.find((run) => run.status === 'frozen') : null;
    return frozen
      ? { runId: frozen.run_id, outcome: 'frozen', detail: { request_kind: frozen.request_kind, assistant_id: frozen.assistant_id, action: frozen.action } }
      : null;
  });
  // What the person's last answer did, kept on the page that follows it. An answered decision stays dismissed while its
  // run waits the same way, as a paused one does; a run held again opens a fresh decision.
  let decided = $state('');
  let dismissed = $state('');
  let round = $state(0);
  let decisionKey = $derived(decision ? `${decision.runId}:${decision.outcome}` : '');
  let pending = $derived(decision && decisionKey !== dismissed ? decision : null);

  async function settled(words, heldAgain) {
    decided = words;
    if (heldAgain) round += 1;
    else dismissed = decisionKey;
    page = 'summary';
    await refreshTeamRoutines(teamId);
  }

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(timer);
  });

  // A Routine given no timezone runs in UTC, and says so without claiming the person chose it (ADR-0101).
  let summary = $derived(fillParts(
    routine.timezone_source === 'none' ? copy.panel.summaryLineFallback : copy.panel.summaryLine,
    {
      schedule: scheduleWords(routine.schedule, copy.schedule, $locale),
      timezone: routine.timezone,
      now: clockWords(now, $locale, routine.timezone),
    },
  ));
  let until = $derived(untilWords(routine.next_run_at, now, $locale));

  // The Routine's id alone: a refresh that replaces the Routine's details neither restarts nor discards its runs.
  let routineId = $derived(routine.routine_id);

  // How many runs that ended while the panel was open joined the list since it last read its newest page.
  let arrived = 0;

  // This Routine's own history head (`historyHead`) reads its newest page when the panel opens, then the runs written
  // since whenever Admin says the Team's history changed: they join the list at the top, and the cursor to older runs
  // keeps its place. When more ended than the list takes, or more was written than one refresh reads, the list starts
  // again from the newest page instead, so no run is ever left between the list and the cursor to older runs. The runs
  // are never required: a refusal says the list is unavailable, and the next change Admin announces tries again.
  function applyRuns(head, value) {
    if (value.restart) {
      runPages.reset();
      runPages.items = [...value.entries].reverse();
      runPages.next = value.before;
      runsRead = true;
      arrived = 0;
      void loadRuns();
      return;
    }
    if (!runsRead) return;
    const merged = mergedRoutineRuns(runPages.items, value.entries, routineId);
    const added = merged.length - runPages.items.length;
    if (arrived + added > MAX_ARRIVED_RUNS) {
      void head.restart();
      return;
    }
    runPages.items = merged;
    arrived += added;
    if (runPages.failed && !runPages.loading) {
      runPages.failed = false;
      void loadRuns();
    }
  }

  $effect(() => {
    const head = historyHead(teamId, { routine: routineId });
    let applied = null;
    return head.subscribe((state) => untrack(() => {
      if (state.status === 'error' && !runsRead) runPages.failed = true;
      if (state.status !== 'ready' || state.value === applied) return;
      applied = state.value;
      applyRuns(head, state.value);
    }));
  });

  // Older pages are read one page ahead of what the list reveals, so its footer counts exactly how many more one press
  // shows. A new reading of the newest page discards an older read it overtook; that reading's cursor reaches its runs.
  function loadRuns() {
    return runPages.load((runPages.pages + 1) * PAGE_SIZE, async () => {
      const found = await routineRuns(call, teamId, routineId, { before: runPages.next });
      return { items: found.runs, next: found.before };
    }, { onError: () => (runPages.failed = true) });
  }

  const RUN_ICONS = {
    done: 'check', recovered: 'check', healthy: 'check', failed: 'failed', denied: 'stop', stopped: 'stop', 'user-skipped': 'skip',
    held: 'warning', paused: 'pause', frozen: 'approval', skipped: 'skip', 'streak-paused': 'pause',
  };

  function viewRun(entry, opener) {
    viewOpener = opener;
    viewedRun = entry;
  }

  async function closeRun() {
    viewedRun = null;
    await tick();
    viewOpener?.focus();
  }

  function outcomeWords(entry) {
    const run = copy.run;
    return {
      done: run.done,
      recovered: run.recovered,
      failed: fill(run.failed, { code: entry.detail.code ?? '' }),
      denied: run.denied,
      stopped: run.stopped,
      'user-skipped': copy.panel.skipped,
      held: copy.status.failed,
      paused: fill(run.paused, { reason: run.pauseReasons[entry.detail.reason] }),
      frozen: entry.detail.request_kind === 'integrations' ? copy.panel.waitingConnection : copy.panel.waitingApproval,
      healthy: countWords(copy.panel.healthyRuns, entry.detail.runs, $locale),
      skipped: countWords(copy.panel.missedRuns, entry.detail.missed, $locale),
      'streak-paused': countWords(copy.panel.streakPaused, entry.detail.failures, $locale),
    }[entry.outcome];
  }

  async function act(action) {
    busy = true;
    error = '';
    try {
      await action();
      await refreshTeamRoutines(teamId);
    } catch (failure) {
      error = routineFailureWords(failure, copy.errors, $t('shell.outcomeUnknown'));
    } finally {
      busy = false;
    }
  }

  async function removed(deleted) {
    if (deleted) {
      // The deleted Routine leaves the list with the read after its deletion, which the panel waits for.
      await refreshTeamRoutines(teamId);
      dialog?.close();
      (ondeleted ?? onclose)();
      return;
    }
    // A run is still ending: Team keeps the Routine as being deleted until it has.
    confirming = false;
    await refreshTeamRoutines(teamId);
  }

  // Canceling returns to the panel, or to the decision it was opened from, with focus on the Delete it came from.
  async function keep() {
    confirming = false;
    await tick();
    (deleteButton ?? dialog?.querySelector('[data-choice="delete"]'))?.focus();
  }

  // Escape leaves the confirmation for the panel, and does nothing while the deletion is being confirmed; from the
  // panel it goes back to the list it was opened from, if any, or closes it.
  function stay(event) {
    event?.preventDefault();
    if (!deleting) void keep();
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

  function back(event) {
    event?.preventDefault();
    dialog?.close();
    onback();
  }
</script>

<RoutineModal bind:dialog class="routine-panel"
  title={confirming ? fill(copy.deletion.title, { name: routine.name }) : routine.name}
  frameClass={[confirming && 'frame--deletion', Boolean(pending) && !confirming && 'frame--deciding']}
  open={Boolean(pending) && !confirming}
  closable={!confirming} onback={onback && !confirming ? back : null}
  oncancel={confirming ? stay : onback ? back : undefined} {onclose}>
    {#snippet tag()}
      {#if !confirming && word}<RoutineTag label={copy.status[word]} icon={STATUS_TAGS[word].icon} tone={STATUS_TAGS[word].tone} />{/if}
    {/snippet}

    <!-- A pending decision is the only thing the panel offers: no pages and no other action until it is answered. -->
    {#if !pending && !confirming}
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
    {#if !routine.deleting}
      <div class="actions">
        {#if routine.state === 'paused'}
          <Button class="act act--resume" variant="ghost" size="sm" iconOnly type="button" disabled={busy || !$commandsReady}
            aria-label={copy.list.resume} title={copy.list.resume}
            onclick={() => act(() => resumeRoutine(call, teamId, routine.routine_id))}><RoutineIcon name="play" /></Button>
        {:else}
          <Button class="act act--pause" variant="ghost" size="sm" iconOnly type="button" disabled={busy || !$commandsReady}
            aria-label={copy.panel.pause} title={copy.panel.pause}
            onclick={() => act(() => pauseRoutine(call, teamId, routine.routine_id))}><RoutineIcon name="pause" /></Button>
        {/if}
        <Button class="act act--delete" variant="ghost" size="sm" iconOnly type="button" disabled={busy} bind:element={deleteButton}
          aria-label={copy.list.delete} title={copy.list.delete} onclick={() => (confirming = true)}><RoutineIcon name="trash" /></Button>
      </div>
    {/if}
    </div>
    {/if}

    {#if confirming}
      <RoutineDeletion {teamId} routineId={routine.routine_id} copy={copy.deletion} errors={copy.errors}
        bind:busy={deleting} ondone={removed} oncancel={keep} />
    {/if}
    <!-- A decision stays mounted, hidden, under its own deletion confirmation, so Cancel returns to the same card. -->
    {#if pending}
      <div class="content decide" hidden={confirming}>
        {#if decided}<p class="note" role="status"><RoutineIcon name="check" />{decided}</p>{/if}
        {#key `${decisionKey}:${round}`}
          <RoutineDecision {teamId} {teamName} runId={pending.runId}
            outcome={pending.outcome} detail={pending.detail} {copy} onsettled={settled}
            ondelete={() => (confirming = true)}
            onunavailable={() => refreshTeamRoutines(teamId)} />
        {/key}
      </div>
    {:else if !confirming}
    <div class="content" id={`${id}-page`} role="tabpanel" aria-labelledby={`${id}-tab-${page}`} tabindex="0">
      {#if page === 'summary'}
        {#if decided}<p class="note" role="status"><RoutineIcon name="check" />{decided}</p>{/if}
        {#if reason}<p class="note"><RoutineIcon name="warning" />{reason}</p>{/if}
        <p class="summary">
          {#each summary as part, index (index)}<span class={part.key && `part part--${part.key}`}>{part.text}</span>{/each}
        </p>
        {#if !ATTENTION_STATUSES.includes(status)}
          <p class="next">
            <span class="next-label">{copy.panel.next}</span>
            <span><time datetime={routine.next_run_at}>{clockWords(routine.next_run_at, $locale, routine.timezone)}</time>
              {#if until}<span class="until">[{until}]</span>{/if}</span>
          </p>
        {/if}
      {:else if page === 'steps'}
        <RoutinePlan {teamId} {routine} {copy} locale={$locale}
          onchanged={() => refreshTeamRoutines(teamId)} />
      {:else}
        <ul class="runs" aria-label={copy.panel.runs} bind:this={runList}>
          {#each live as run (run.run_id)}
            <li>
              <!-- A held or frozen live run reads as its run notice does; a leased one is running now. -->
              <RoutineIcon name={RUN_ICONS[run.status] ?? 'spinner'} />
              <span class="run-what">{run.status === 'leased' ? copy.panel.runningNow : outcomeWords({ outcome: run.status, detail: run })}</span>
            </li>
          {/each}
          {#if !runsRead}
            {#if !runPages.failed}<li class="sub" role="status">{copy.list.loading}</li>{/if}
          {:else if runPages.items.length === 0 && live.length === 0 && runPages.next === null}
            <li class="sub">{copy.panel.noRuns}</li>
          {:else}
            {#each runPages.shown as entry (entry.id)}
              <li class="run" tabindex="-1">
                <div class="run-line">
                  <RoutineIcon name={RUN_ICONS[entry.outcome]} />
                  <!-- A rollup of healthy runs or of missed runs is no run of its own, so it opens nothing. -->
                  {#if entry.runId}
                    <Button class="run-what run-open" variant="ghost" size="sm" type="button" aria-haspopup="dialog"
                      onclick={(event) => viewRun(entry, event.currentTarget)}>{outcomeWords(entry)}</Button>
                  {:else}
                    <span class="run-what">{outcomeWords(entry)}</span>
                  {/if}
                  {#if entry.usage}<span class="usage">{formatRunUsage(entry.usage, $locale)}</span>{/if}
                  <time class="when" datetime={entry.createdAt}>{instantWords(entry.createdAt, $locale, routine.timezone)}</time>
                  {#if entry.runId}
                    <Button class="run-details" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.details.open} title={copy.details.open}
                      onclick={() => (detailsRun = entry)}><RoutineIcon name="terminal" /></Button>
                  {/if}
                </div>
                {#if entry.protectionLost}<p class="run-note run-note--lost">{copy.notice.protectionLost}</p>{/if}
              </li>
            {/each}
          {/if}
        </ul>
        <Paging paging={runPages} remaining={runPages.items.length - runPages.shown.length}
          unavailable={copy.panel.runsUnavailable} loading={copy.list.loading} more={copy.panel.moreRuns} locale={$locale}
          onmore={() => runPages.more(runList, loadRuns)} />
      {/if}

      {#if error}<Notice variant="error">{error}</Notice>{/if}
    </div>
    {/if}
</RoutineModal>

{#if viewedRun}
  {@const shown = routineNotice(viewedRun, copy)}
  <RoutineRunView {teamId} entry={viewedRun} {routine} status={shown.status} tone={shown.tone} {copy}
    onclose={closeRun} />
{/if}

{#if detailsRun}
  <RoutineRunDetails {teamId} entry={detailsRun} {copy} onclose={() => (detailsRun = null)} />
{/if}

<style>
  /* The panel's frame and header are the shared Routine modal's; its pages keep mono labels, neutral tags, and cyan
     only on the one primary action. The deletion confirmation is the header and one form that fills the rest. */
  :global(.routine-frame.frame.frame--deletion > .deletion) { flex: 1 1 auto; }
  .note :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  /* The page menu: mono labels on one rule, the selected page underlined in the panel's one accent. */
  /* The page menu starts at the panel's edge; the Routine's actions sit at its far end. */
  .bar { display: flex; align-items: center; gap: var(--gap-item); min-height: 2.5rem; padding-inline-end: var(--gap-item); border-block-end: 1px solid var(--shimpz-color-border); border-radius: 0; }
  .tabs { display: flex; flex: 1 1 auto; min-width: 0; padding-block-start: var(--gap-inside); overflow-x: auto; }
  .actions { display: flex; flex: none; gap: var(--gap-inside); margin-inline-start: auto; }
  .actions :global(.act.act) { --button-border: transparent; --button-color: var(--shimpz-color-cyan); --button-hover-color: var(--shimpz-color-cyan); }
  .actions :global(.act.act--delete) { --button-color: var(--shimpz-color-danger); --button-hover-color: var(--shimpz-color-danger); }
  .actions :global(.act.act--delete:hover:not(:disabled)) { box-shadow: none; }
  .tabs :global(.tab) {
    --button-color: var(--shimpz-color-text-dim);
    --button-border: transparent;
    --button-hover-bg: transparent;
    clip-path: none;
    box-shadow: none;
    /* Square corners, so the selected tab's underline runs straight to its edges. */
    border-radius: 0 !important;
  }
  .tabs :global(.tab:hover:not(:disabled)) { color: var(--shimpz-color-text); border-color: transparent; box-shadow: none; }
  .tabs :global(.tab[aria-selected="true"]) { --button-color: var(--shimpz-color-cyan); box-shadow: inset 0 -2px 0 var(--shimpz-color-cyan); }
  .tabs :global(.tab[aria-selected="true"]:hover) { color: var(--shimpz-color-cyan); box-shadow: inset 0 -2px 0 var(--shimpz-color-cyan); }
  .tabs :global(.tab:focus-visible) { outline: 2px solid var(--shimpz-color-cyan); outline-offset: -2px; }
  /* A decision fills the panel, and its choice group closes the panel's frame along its bottom edge. */
  .content.decide {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    padding-block-start: 0;
  }
  /* A decision narrows the panel to about 80%, and its answers span that same width below the message. */
  :global(dialog.shimpz-modal.routine-panel:has(.frame--deciding)) { --modal-max-width: calc(var(--shimpz-dialog-lg) * 0.805); }
  /* Every page keeps one height so switching tabs does not resize the panel. */
  .content { flex: 1 1 auto; align-content: start; min-height: min(17rem, 50dvh); display: grid; gap: var(--gap-group); min-width: 0; padding: var(--gap-panel); overflow: auto; }
  /* A decision kept mounted under its deletion confirmation takes no room and is not shown. */
  .content.decide[hidden] { display: none; }
  /* One paragraph in the person's own words; the timezone and the time now stand out in bold. */
  .summary { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; overflow-wrap: break-word; }
  .part { font-weight: 700; }
  .part--schedule { font-weight: inherit; }
  /* The next run: a mono label over the instant, then how far off it is. */
  .next { display: grid; justify-items: start; gap: var(--gap-inside); margin: 0; font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  .next-label { color: var(--shimpz-color-text-dim); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
  .next time { color: var(--shimpz-color-cyan); }
  .until { color: var(--shimpz-color-text-dim); }
  .note { display: flex; align-items: flex-start; gap: var(--gap-inside); margin: 0; padding: var(--gap-item) var(--gap-group); color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.8rem; line-height: 1.45; }
  .note :global(.routine-icon) { margin-block-start: 0.15rem; } /* optical: centres the icon on the first text line */
  .note :global(.routine-icon--check) { color: var(--shimpz-color-cyan); }
  .sub { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
  .runs { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; } /* a hairline seam, not rhythm */
  .runs li { display: flex; align-items: center; gap: var(--gap-item); min-height: 2.25rem; padding-block: var(--gap-inside); font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  /* A run's line wraps on a narrow screen rather than hiding its time; its notes read below it. */
  .runs li.run { display: grid; gap: var(--gap-inside); }
  .run-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap-inside) var(--gap-item); min-width: 0; }
  .runs li :global(.routine-icon) { color: var(--shimpz-color-text-dim); width: 0.9rem; height: 0.9rem; }
  .runs li :global(.routine-icon--failed) { color: var(--shimpz-color-danger); }
  .runs li :global(.routine-icon--warning) { color: var(--shimpz-color-yellow); }
  .run-what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .runs :global(.run-open.run-open) { --button-border: transparent; justify-content: flex-start; height: auto; min-height: 0; padding-inline: 0; font: inherit; text-align: start; clip-path: none; }
  .usage, .when { flex: none; color: var(--shimpz-color-text-dim); font-size: 0.72rem; }
  /* Under the run's text: past its 0.9rem icon and the line's gap. */
  .run-note { margin: 0; padding-inline-start: calc(0.9rem + var(--gap-item)); color: var(--shimpz-color-text-muted); font: 400 0.78rem/1.45 var(--shimpz-font-sans); overflow-wrap: anywhere; white-space: pre-wrap; }
  .run-note--lost { color: var(--shimpz-color-yellow); }
  .runs :global(.run-details) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  @media (forced-colors: active) {
    .bar { border-color: CanvasText; }
    .note { border-color: CanvasText; }
    .tabs :global(.tab[aria-selected="true"]) { border-block-end: 2px solid Highlight; }
  }
</style>
