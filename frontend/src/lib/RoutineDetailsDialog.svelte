<script>
  import { Button, Notice } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { listChatHistory } from '$lib/chatHistory.js';
  import { locale } from '$lib/i18n.js';
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import {
    ATTENTION_STATUSES,
    clockWords,
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
  import RoutineDecision from '$lib/RoutineDecision.svelte';
  import RoutineDeletion from '$lib/RoutineDeletion.svelte';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineModal from '$lib/RoutineModal.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';

  // One Routine in full (ADR-0086, ADR-0092). While a run waits for the person, the whole panel is that decision and
  // nothing else: a held run's recovery choices or a frozen run's approval, with what it needs to decide. Once it is
  // answered the panel returns to its usual pages and actions. Otherwise it shows three pages
  // behind a tab menu: its summary (what was asked, when it
  // runs, and why it stopped), its steps, and its runs with their execution details. The menu's far end keeps one icon
  // per action on every page: Pause or Resume, and Delete, which turns the whole panel into its confirmation: the
  // Supervisor's password and a second factor, and nothing else until it is deleted or canceled.
  // `onback` adds a Back control that returns to the list the panel was opened from; Escape then goes back as well.
  let { teamId, teamName, routine, runs = [], incidents = [], copy, onclose, ondeleted, onback = null } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let error = $state('');
  let confirming = $state(false);
  let deleting = $state(false);
  let deleteButton = $state();
  let recent = $state(null);
  let recentFailed = $state(false);
  let detailsRun = $state('');
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
  // The run that waits for the person: a held run is its incident (the incident and the run share one id), a frozen
  // run its approval. A held run Team lists before its incident names no step until its card does.
  let decision = $derived.by(() => {
    if (status === 'recovery') {
      const incident = incidents.find((item) => item.routine_id === routine.routine_id);
      const held = live.find((run) => run.status === 'held');
      const source = incident ? { ...incident, run_id: incident.incident_id } : held;
      return source ? { runId: source.run_id, outcome: 'held', detail: { assistant_id: source.assistant_id, action: source.action } } : null;
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
    await loadTeamRoutines(fetch, teamId).catch(() => {});
  }

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1_000);
    return () => clearInterval(timer);
  });

  let summary = $derived(fillParts(copy.panel.summaryLine, {
    request: routine.quote.replace(/[\s.。．!！]+$/u, ''),
    timezone: routine.timezone,
    now: clockWords(now, $locale, routine.timezone),
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

  async function removed(deleted) {
    if (deleted) {
      dropTeamRoutine(teamId, routine.routine_id);
      dialog?.close();
      (ondeleted ?? onclose)();
      return;
    }
    // A run is still ending: Team keeps the Routine as being deleted until it has.
    confirming = false;
    await loadTeamRoutines(fetch, teamId).catch(() => {});
  }

  // Canceling returns to the panel, or to the decision it was opened from, with focus on the Delete it came from.
  async function keep() {
    confirming = false;
    await tick();
    (deleteButton ?? dialog?.querySelector('[data-choice="delete"]'))?.focus();
  }

  // Escape leaves the confirmation for the panel, and does nothing while the deletion is being confirmed; from the
  // panel it goes back to the list it was opened from, if any, or closes it.
  function cancel(event) {
    if (!confirming) return onback ? back(event) : close(event);
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

  function close(event) {
    event?.preventDefault();
    dialog?.close();
    onclose();
  }

  function back(event) {
    event?.preventDefault();
    dialog?.close();
    onback();
  }
</script>

<RoutineModal bind:dialog class="routine-panel"
  title={confirming ? fillRoutineCopy(copy.deletion.title, { name: routine.name }) : routine.name}
  frameClass={[confirming && 'frame--deletion', Boolean(pending) && !confirming && 'frame--deciding']}
  open={Boolean(pending) && !confirming}
  closable={!confirming} onback={onback && !confirming ? back : null} oncancel={cancel} onclose={close}>
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
        {#if routine.paused}
          <Button class="act act--resume" variant="ghost" size="sm" iconOnly type="button" disabled={busy}
            aria-label={copy.list.resume} title={copy.list.resume}
            onclick={() => act(() => resumeRoutine(fetch, teamId, routine.routine_id))}><RoutineIcon name="play" /></Button>
        {:else}
          <Button class="act act--pause" variant="ghost" size="sm" iconOnly type="button" disabled={busy}
            aria-label={copy.panel.pause} title={copy.panel.pause}
            onclick={() => act(() => pauseRoutine(fetch, teamId, routine.routine_id))}><RoutineIcon name="pause" /></Button>
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
          <RoutineDecision {teamId} {teamName} runId={pending.runId} routineId={routine.routine_id}
            outcome={pending.outcome} detail={pending.detail} {copy} onsettled={settled}
            ondelete={() => (confirming = true)}
            onunavailable={() => loadTeamRoutines(fetch, teamId).catch(() => {})} />
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

      {#if error}<Notice variant="error">{error}</Notice>{/if}
    </div>
    {/if}
</RoutineModal>

{#if detailsRun}
  <RoutineRunDetails {teamId} runId={detailsRun} copy={copy.details} errors={copy.errors} onclose={() => (detailsRun = '')} />
{/if}

<style>
  /* The panel's frame and header are the shared Routine modal's; its pages keep mono labels, neutral tags, and cyan
     only on the one primary action. The deletion confirmation is the header and one form that fills the rest. */
  :global(.routine-frame.frame.frame--deletion > .deletion) { flex: 1 1 auto; }
  .note :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  /* The page menu: mono labels on one rule, the selected page underlined in the panel's one accent. */
  /* The page menu starts at the panel's edge; the Routine's actions sit at its far end. */
  .bar { display: flex; align-items: center; gap: var(--shimpz-space-2); padding-inline-end: var(--shimpz-space-2); border-block-end: 1px solid var(--shimpz-color-border); }
  .tabs { display: flex; flex: 1 1 auto; min-width: 0; padding-block-start: 0.3rem; overflow-x: auto; }
  .actions { display: flex; flex: none; gap: 0.15rem; margin-inline-start: auto; }
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
  .bar { min-height: 2.5rem; }
  /* A decision fills the panel, and its choice group closes the panel's frame along its bottom edge. */
  .content.decide {
    --choice-inline: var(--shimpz-space-4);
    --choice-ask-align: center;
    --choice-list-border: 1px solid var(--shimpz-color-border);
    /* The panel's side lines run only beside the header and the message; the answers below are open. */
    --decision-message-bleed: var(--shimpz-space-4);
    --decision-message-top: var(--shimpz-space-4);
    --decision-message-sides: inset 1px 0 0 var(--shimpz-color-border), inset -1px 0 0 var(--shimpz-color-border);
    --decision-message-rule: 1px solid var(--shimpz-color-border);
    --choice-rule: 0;
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    padding-block-start: 0;
  }
  /* A decision narrows the panel to about 80%, and its answers span that same width below the message. */
  :global(dialog.shimpz-modal.routine-panel:has(.frame--deciding)) { --modal-max-width: calc(var(--shimpz-dialog-lg) * 0.805); }
  /* Every page keeps one height so switching tabs does not resize the panel. */
  .content { flex: 1 1 auto; align-content: start; min-height: min(17rem, 50dvh); display: grid; gap: var(--shimpz-space-4); min-width: 0; padding: var(--shimpz-space-4); overflow: auto; }
  /* A decision kept mounted under its deletion confirmation takes no room and is not shown. */
  .content.decide[hidden] { display: none; }
  /* One paragraph in the person's own words; the timezone and the time now stand out in bold. */
  .summary { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; overflow-wrap: break-word; }
  .part { font-weight: 700; }
  .part--request { font-weight: inherit; }
  /* The next run: a mono label over the instant, then how far off it is. */
  .next { display: grid; justify-items: start; gap: 0.3rem; margin: 0; font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  .next-label { color: var(--shimpz-color-text-dim); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }
  .next time { color: var(--shimpz-color-cyan); }
  .until { color: var(--shimpz-color-text-dim); }
  .note { display: flex; align-items: flex-start; gap: 0.5rem; margin: 0; padding: 0.55rem 0.7rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.8rem; line-height: 1.45; }
  .note :global(.routine-icon) { margin-block-start: 0.15rem; }
  .note :global(.routine-icon--check) { color: var(--shimpz-color-cyan); }
  .sub { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
  .runs { display: grid; gap: 1px; margin: 0; padding: 0; list-style: none; }
  .runs li { display: flex; align-items: center; gap: 0.6rem; min-height: 2.25rem; padding-block: 0.25rem; font: 400 0.8rem/1.4 var(--shimpz-font-mono); }
  .runs li :global(.routine-icon) { color: var(--shimpz-color-text-dim); width: 0.9rem; height: 0.9rem; }
  .runs li :global(.routine-icon--failed) { color: var(--shimpz-color-danger); }
  .runs li :global(.routine-icon--warning) { color: var(--shimpz-color-yellow); }
  .run-what { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .when { flex: none; color: var(--shimpz-color-text-dim); font-size: 0.72rem; }
  .runs :global(.run-details) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  @media (max-width: 600px) { .when { display: none; } }
  @media (forced-colors: active) { .bar { border-color: CanvasText; } }
  @media (forced-colors: active) {
    .note { border-color: CanvasText; }
    .tabs :global(.tab[aria-selected="true"]) { border-block-end: 2px solid Highlight; }
  }
</style>
