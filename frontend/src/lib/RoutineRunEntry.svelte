<script>
  import { Button, Disclosure, TextAction } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import RoutineTag from '$lib/RoutineTag.svelte';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    fillRoutineCopy,
    humanizeId,
    minuteWords,
    OUTCOME_TONES,
    openRoutineCard,
    openRoutineChallenge,
    resumeRoutine,
    resumeRoutineIntegrations,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message, as one card: the Routine's name and a neutral badge, the state in one sentence, and its actions. It
  // never carries an Action's raw input or result, and it is not part of the Brain's conversation. A frozen run is
  // answered here with chat's own approval dialog, and nothing runs until the Supervisor answers. A held or paused run offers its recovery card's three choices (ADR-0092).
  let { entry, copy, teamId, teamName } = $props();

  let challenge = $state(null);
  let rejection = $state(undefined);
  let working = $state(false);
  let waitingIntegration = $state(false);
  let result = $state('');
  // Set once the run has left its freeze; until then Review stays available after a dismissal, an error, an expiry,
  // or a resumed run that froze again for its next approval.
  let ended = $state(false);

  // The held run's recovery card (ADR-0092): Team's own card, opened for this person and shown with its choices in
  // Team's order before anything is answered. An answer uses exactly that card's nonce, once; a fresh card follows.
  let card = $state(null);
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
      case 'held': return copy.card.reasonHeld;
      case 'paused': return fillRoutineCopy(run.paused, { reason: run.pauseReasons[detail.reason] });
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
      default:
        return fillRoutineCopy(detail.request_kind === 'human' ? run.frozenHuman : run.frozenIntegrations, {
          assistant: $assistantNames[detail.assistant_id] ?? humanizeId(detail.assistant_id),
          action: humanizeId(detail.action),
        });
    }
  });
  // Where a held or paused run stopped, and its place in the plan when the listed Routine names it exactly once. The
  // step a card names is Team's current one, which a stale row may not show.
  let situation = $derived.by(() => {
    if (entry.outcome !== 'held' && entry.outcome !== 'paused') return null;
    const step = card ?? detail;
    if (step.assistant_id === null) return { step: '', position: '' };
    const steps = listed?.routines.find((routine) => routine.routine_id === entry.routineId)?.steps ?? [];
    const matches = steps.flatMap((item, index) => (
      item.assistant === step.assistant_id && item.action === step.action ? [index + 1] : []
    ));
    return {
      step: fillRoutineCopy(copy.plan.step, {
        assistant: $assistantNames[step.assistant_id] ?? humanizeId(step.assistant_id),
        action: humanizeId(step.action),
      }).replace(' · ', ' › '),
      position: matches.length === 1 ? fillRoutineCopy(copy.card.stepOf, { n: matches[0], total: steps.length }) : '',
    };
  });
  // Why the person decides: a held run's open question, or the reason its Routine paused, as one sentence.
  let reason = $derived.by(() => {
    if (entry.outcome === 'held') return copy.card.reasonHeld;
    const words = copy.run.pauseReasons[detail.reason] ?? '';
    return words.charAt(0).toLocaleUpperCase($locale) + words.slice(1);
  });
  // The status tag's icon: state color lives only on these small icons.
  const TAG_ICONS = {
    held: 'warning', paused: 'pause', 'scope-changed': 'pause', done: 'check', recovered: 'check', failed: 'failed',
    denied: 'stop', stopped: 'stop', 'user-skipped': 'skip', skipped: 'skip', frozen: 'approval', created: 'plus',
    changed: 'edit', healthy: 'activity',
  };
  const CHOICE_ICONS = { verify: 'verify', skip: 'skip', pause: 'pause' };
  // The one mono line of a notice: what it changed or did, never a repeat of the name and badge in its header.
  let line = $derived.by(() => {
    if (entry.outcome === 'created' || entry.outcome === 'changed') {
      return `${scheduleWords(detail.schedule, copy.schedule, $locale)} · ${detail.timezone}`;
    }
    if ((entry.outcome === 'done' || entry.outcome === 'recovered') && actions) return actions.replaceAll(' · ', ' › ');
    return summary;
  });
  let actionsLine = $derived(line === summary && actions ? fillRoutineCopy(copy.run.actions, { actions }) : '');
  const HINTS = { verify: 'verifyHint', skip: 'skipHint', pause: 'pauseHint' };
  const id = $props.id();
  function outcomeWords(status) {
    const run = copy.run;
    return {
      done: run.done,
      recovered: run.recovered,
      denied: run.denied,
      stopped: run.stopped,
      held: run.heldOutcome,
      frozen: run.waitingAgain,
    }[status] ?? run.failedOutcome;
  }

  // Set when a card is needed: at first, after each answer while the run is still held, and when the person retries
  // an opening that failed; it never retries on its own.
  let wanted = $state(true);
  let recoverable = $derived((entry.outcome === 'held' || entry.outcome === 'paused') && !ended);

  // A card answers only within Team's lifetime for it; once that passes it is withdrawn here, and the person opens
  // a fresh one on purpose, so an idle page never keeps opening cards.
  let expired = $state(false);
  $effect(() => {
    if (!card) return;
    const opened = card;
    const timer = setTimeout(() => {
      if (card !== opened) return;
      card = null;
      expired = true;
      result = copy.card.expired;
    }, opened.expires_in * 1000);
    return () => clearTimeout(timer);
  });

  async function openCard() {
    // Reopening after an expiry clears only that notice; a verdict shown after an answer stays.
    if (expired) result = '';
    expired = false;
    try {
      card = await openRoutineCard(fetch, teamId, entry.runId);
    } catch (error) {
      card = null;
      // A run already settled has nothing left to answer here; its newer notice replaces this row.
      if (error?.code === 'routine-incident-unavailable') ended = true;
      else result = routineErrorMessage(error, copy.errors);
    }
  }

  $effect(() => {
    if (recoverable && wanted && !working) {
      wanted = false;
      working = true;
      void openCard().finally(() => { working = false; });
    }
  });

  function unresolvedWords(verdict) {
    const words = {
      policy: copy.card.policy,
      unquiesced: copy.card.unquiesced,
      unclassified: copy.card.unclassified,
      exhausted: copy.card.exhausted,
    };
    return words[verdict] ?? copy.card.unproven;
  }

  async function recover(choice) {
    const answering = card;
    working = true;
    result = '';
    try {
      const answered = await answerRoutineCard(fetch, teamId, entry.runId, answering, choice);
      const run = copy.run;
      if (answered.status === 'skipped') result = run.userSkipped;
      else if (answered.status === 'paused') result = fillRoutineCopy(run.paused, { reason: run.pauseReasons.person });
      else if (answered.status === null) result = unresolvedWords(answered.verdict);
      else result = fillRoutineCopy(run.continued, { outcome: outcomeWords(answered.status) });
      ended = answered.status !== null;
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
    } finally {
      // The card was used or refused either way; while the run is still held, the next answer needs a fresh one.
      card = null;
      wanted = true;
      working = false;
    }
  }

  async function settle(action) {
    working = true;
    try {
      const status = await action();
      result = fillRoutineCopy(copy.run.continued, { outcome: outcomeWords(status) });
      ended = status !== 'frozen';
      waitingIntegration = false;
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
    } finally {
      challenge = null;
      working = false;
    }
  }

  async function review() {
    working = true;
    result = '';
    try {
      // Team renders the request copy in the interface language selected when the run is reviewed (ADR-0091).
      const opened = await openRoutineChallenge(
        fetch,
        teamId,
        entry.runId,
        $locale,
        (value) => parseChatEvent(value, teamId, teamName),
      );
      if (opened.status === 'integrations-required') waitingIntegration = true;
      else challenge = opened.challenge;
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
      challenge = null;
    } finally {
      working = false;
    }
  }

  // A challenge opened in another language than the one selected now is never answered: each opening is a fresh
  // challenge, so the run is opened again in the selected language, also when the language changed mid-opening.
  let stale = $derived(Boolean(challenge) && challenge.locale !== $locale);
  $effect(() => {
    if (stale && !working) void review();
  });

  async function respond(response) {
    const frame = createHumanResponseFrame(teamId, challenge.challenge_id, response.decision, response.value);
    working = true;
    let answered;
    try {
      answered = await answerRoutineChallenge(fetch, teamId, entry.runId, frame);
    } catch (error) {
      result = routineErrorMessage(error, copy.errors);
      challenge = null;
      working = false;
      return;
    }
    working = false;
    if (answered.rejection) {
      // A wrong password keeps the dialog open for another attempt, as in chat.
      rejection = answered.rejection;
      return;
    }
    result = fillRoutineCopy(copy.run.continued, { outcome: outcomeWords(answered.status) });
    ended = answered.status !== 'frozen';
    challenge = null;
  }
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
    {#if situation}
      <p class="line"><span class="prompt" aria-hidden="true">&gt;</span>
        {#if situation.step}
          <span class="key">{copy.card.stoppedLabel}</span>
          <span class="value">{situation.step}</span>
          {#if situation.position}<span class="muted">· {situation.position}</span>{/if}
        {:else}
          <span class="value">{copy.run.stoppedUnknown}</span>
        {/if}
      </p>
      {#if situation.step}<p class="line muted"><RoutineIcon name="warning" />{copy.card.unknownEffect}</p>{/if}
      <p class="reason">{reason}</p>
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

  {#if recoverable}
    {#if card}
      <!-- One tile per choice, the recommended one first: its verb names it, its consequence describes it. -->
      <div class="tiles" role="group" aria-label={copy.card.choices}>
        {#each card.choices as choice (choice)}
          <!-- The recommendation mark sits on the tile's static slot, not in the button its hover glitch animates. -->
          <div class="tile-slot">
          <Button
            class={['tile', choice === card.recommended && 'is-recommended']}
            variant="ghost"
            type="button"
            disabled={working}
            aria-label={copy.card[choice]}
            aria-describedby={choice === card.recommended ? `${id}-recommended ${id}-${choice}` : `${id}-${choice}`}
            onclick={() => recover(choice)}
          >
            <RoutineIcon name={CHOICE_ICONS[choice]} />
            <span class="verb">{copy.card[choice]}</span>
            <span class="hint" id={`${id}-${choice}`}>{copy.card[HINTS[choice]]}</span>
          </Button>
          {#if choice === card.recommended}<span class="notch" id={`${id}-recommended`} aria-hidden="true">{copy.card.recommendedMark}</span>{/if}
          </div>
        {/each}
      </div>
    {:else if !working}
      <div class="actions">
        <Button size="sm" variant="secondary" type="button" onclick={() => (wanted = true)}>
          {expired ? copy.card.reopen : copy.list.retry}
        </Button>
      </div>
    {/if}
  {:else if entry.outcome !== 'frozen' || ended}
    <!-- The run is no longer waiting here; its next outcome replaces this row when it is delivered. -->
  {:else if waitingIntegration}
    <p class="line muted">{fillRoutineCopy(copy.run.connect, { assistant: $assistantNames[detail.assistant_id] ?? humanizeId(detail.assistant_id) })}</p>
    <div class="actions">
      <Button
        size="sm"
        type="button"
        disabled={working}
        onclick={() => settle(() => resumeRoutineIntegrations(fetch, teamId, entry.runId))}
      >{working ? copy.run.working : copy.run.continue}</Button>
    </div>
  {:else}
    <div class="actions">
      <Button size="sm" type="button" disabled={working} onclick={review}>
        {working ? copy.run.working : copy.run.review}
      </Button>
    </div>
  {/if}
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

{#if challenge}
  <AssistantHumanRequestDialog
    open={Boolean(challenge)}
    {challenge}
    {rejection}
    working={working || stale}
    onrespond={respond}
    ondismiss={() => (challenge = null)}
    dismissLabel={copy.run.dismiss}
    onretry={() => (rejection = undefined)}
    onexpire={() => { challenge = null; result = copy.errors.expired; }}
  />
{/if}

<style>
  /* One chamfered shell in neutrals: cyan marks only the recommended choice, and state color lives on small icons. */
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
  /* Terminal lines flow as text, so a narrow card wraps words, never whole pieces of the line. */
  .line { margin: 0; font: 400 0.78rem/1.55 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .line > * + * { margin-inline-start: 0.5em; }
  .line :global(.routine-icon) { width: 0.85rem; height: 0.85rem; margin-inline-end: 0.5em; vertical-align: -0.15em; }
  .line.muted { color: var(--shimpz-color-text-muted); }
  .line.muted :global(.routine-icon--warning) { color: var(--shimpz-color-yellow); }
  .prompt { color: var(--shimpz-color-cyan); }
  .key { color: var(--shimpz-color-text-dim); letter-spacing: 0.06em; text-transform: uppercase; }
  .value { color: var(--shimpz-color-text); }
  .muted { color: var(--shimpz-color-text-muted); }
  .reason { margin: 0.2rem 0 0; color: var(--shimpz-color-text); font-size: 0.88rem; line-height: 1.5; text-wrap: pretty; }
  .result { margin: 0; color: var(--shimpz-color-text); font-size: 0.85rem; line-height: 1.45; }
  .body :global(.steps) { border-block-start: 0; padding-block-start: 0.25rem; }
  .body :global(.steps summary) { list-style: none; }
  .body :global(.steps summary::-webkit-details-marker) { display: none; }
  .steps-summary { display: inline-flex; align-items: center; gap: 0.35rem; }
  .steps-summary :global(.routine-icon) { width: 0.8rem; height: 0.8rem; transition: transform var(--shimpz-duration-fast) var(--shimpz-ease); }
  :global([dir="rtl"]) .steps-summary :global(.routine-icon) { transform: scaleX(-1); }
  .body :global(.steps[open] .routine-icon) { transform: rotate(90deg); }

  /* Three equal tiles in one row; a narrow card stacks them. Each tile is one button: icon, verb, consequence. */
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--shimpz-space-3); padding: var(--shimpz-space-2) var(--shimpz-space-4) var(--shimpz-space-4); }
  @container (max-width: 34rem) {
    .tiles { grid-template-columns: minmax(0, 1fr); gap: var(--shimpz-space-3); }
    .tiles :global(.tile.tile) { min-height: 0; }
  }
  .tiles :global(.tile) {
    --button-color: var(--shimpz-color-text);
    --button-bg: var(--shimpz-color-surface);
    --button-border: var(--shimpz-color-border);
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: var(--shimpz-color-surface-high);
    width: 100%;
    height: 100%;
    min-height: 5.75rem;
    padding: var(--shimpz-space-3);
    overflow: visible;
    text-align: start;
    text-transform: none;
    letter-spacing: normal;
    clip-path: none;
    align-items: stretch;
  }
  .tiles :global(.tile .button-content) { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; align-content: start; justify-items: start; align-self: stretch; gap: 0.45rem 0.55rem; width: 100%; }
  .tiles :global(.tile .routine-icon) { width: 1.1rem; height: 1.1rem; color: var(--shimpz-color-text-muted); }
  .tiles :global(.tile:hover:not(:disabled)), .tiles :global(.tile:focus-visible) { border-color: var(--shimpz-color-cyan); }
  .tiles :global(.tile.is-recommended) { --button-border: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .tiles :global(.tile.is-recommended .routine-icon) { color: var(--shimpz-color-cyan); }
  .verb { font: 700 0.74rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .hint { grid-column: 1 / -1; color: var(--shimpz-color-text-muted); font: 400 0.76rem/1.4 var(--shimpz-font-sans); text-wrap: pretty; white-space: normal; }
  .tile-slot { position: relative; display: grid; min-width: 0; }
  /* The recommendation is notched into the tile's top edge, cutting its border. */
  .notch {
    pointer-events: none;
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: var(--shimpz-space-3);
    padding: 0 0.35rem;
    color: var(--shimpz-color-cyan);
    background: var(--shimpz-color-surface-raised);
    font: 700 0.56rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    transform: translateY(-50%);
  }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); padding: 0 var(--shimpz-space-4) var(--shimpz-space-4); }
  .head :global(.tag--neutral.tag) :global(.routine-icon--failed) { color: var(--shimpz-color-danger); }
  @media (forced-colors: active) { .routine-run, .tiles :global(.tile) { border-color: CanvasText; } }
</style>
