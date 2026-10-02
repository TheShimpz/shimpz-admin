<script>
  import { Button, Disclosure, TextAction } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import RoutineRunDetails from '$lib/RoutineRunDetails.svelte';
  import { loadTeamRoutines, routineContext } from '$lib/routineContext.js';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    fillRoutineCopy,
    humanizeId,
    minuteWords,
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
      case 'held': return run.heldTitle;
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
  // Where a held or paused run stopped. The step a card names is Team's current one, which a stale row may not show.
  let stopped = $derived.by(() => {
    if (entry.outcome !== 'held' && entry.outcome !== 'paused') return '';
    const step = card ?? detail;
    if (step.assistant_id === null) return copy.run.stoppedUnknown;
    return fillRoutineCopy(copy.run.stoppedAt, { step: stepWords(step.assistant_id, step.action) });
  });
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
    <h3 class="name" id={`${id}-name`} title={entry.quote}>{routineName}</h3>
    <span class="badge">{badge}</span>
    {#if entry.runId}
      <TextAction class="details" onclick={() => (details = true)}>
        {#snippet icon()}<svg viewBox="0 0 24 24"><path d="M4 5h16M4 12h16M4 19h10"></path></svg>{/snippet}
        {copy.details.open}
      </TextAction>
    {/if}
  </header>
  <p class="title">{summary}</p>
  {#if stopped}<p class="body">{stopped}</p>{/if}
  {#if actions}<p class="body">{fillRoutineCopy(copy.run.actions, { actions })}</p>{/if}
  {#if entry.outcome === 'created' || entry.outcome === 'changed'}
    <Disclosure class="steps">
      {#snippet summary()}{copy.plan.title}{/snippet}
      <RoutinePlan steps={detail.steps} copy={copy.plan} names={$assistantNames} />
    </Disclosure>
  {/if}
  {#if result}<p class="result" role="status">{result}</p>{/if}
  {#if recoverable}
    {#if card}
      <!-- Each choice states its own consequence beside it; the recommended one leads and is marked in words. -->
      <div class="choices" role="group" aria-label={copy.card.choices}>
        {#each card.choices as choice (choice)}
          <div class="choice">
            <Button
              size="sm"
              variant={choice === card.recommended ? 'primary' : 'secondary'}
              type="button"
              disabled={working}
              aria-describedby={`${id}-${choice}`}
              onclick={() => recover(choice)}
            >{copy.card[choice]}</Button>
            <p class="hint" id={`${id}-${choice}`}>{#if choice === card.recommended}<span class="recommended">{copy.card.recommendedMark}</span>{/if}{copy.card[HINTS[choice]]}</p>
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
    <p class="body">{fillRoutineCopy(copy.run.connect, { assistant: $assistantNames[detail.assistant_id] ?? humanizeId(detail.assistant_id) })}</p>
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
      <Button size="sm" variant="secondary" type="button" disabled={working} onclick={resume}>{copy.list.resume}</Button>
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
  /* One bordered card in neutral colors; cyan only marks the primary choice. */
  .routine-run { display: grid; gap: var(--shimpz-space-2); max-width: 44rem; padding: var(--shimpz-space-3) var(--shimpz-space-4); background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--shimpz-space-1) var(--shimpz-space-3); min-width: 0; }
  .name { flex: 1 1 12rem; min-width: 0; margin: 0; overflow: hidden; color: var(--shimpz-color-text); font: 600 0.9rem/1.35 var(--shimpz-font-sans); text-overflow: ellipsis; white-space: nowrap; }
  .badge { flex: none; padding: 0.1rem 0.45rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.7rem; line-height: 1.4; }
  /* A quiet link-styled action: muted, in the body face, never the cyan of a primary action. */
  .head :global(.details) { flex: none; gap: 0.3rem; min-height: 0; padding: 0; color: var(--shimpz-color-text-muted); font: 500 0.75rem/1.4 var(--shimpz-font-sans); letter-spacing: normal; text-decoration: underline; text-transform: none; text-underline-offset: 0.2em; }
  .head :global(.details:hover) { color: var(--shimpz-color-text); }
  .head :global(.details svg) { width: 0.85rem; height: 0.85rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .title { margin: 0; color: var(--shimpz-color-text); line-height: 1.45; overflow-wrap: break-word; }
  .body, .result { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.82rem; line-height: 1.45; overflow-wrap: break-word; }
  .result { color: var(--shimpz-color-text); }
  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--shimpz-space-3); margin-block-start: var(--shimpz-space-1); }
  .choice { display: grid; align-content: start; justify-items: start; gap: var(--shimpz-space-1); }
  .hint { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.75rem; line-height: 1.4; }
  .recommended { display: block; color: var(--shimpz-color-cyan); font: 700 0.62rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); }
  @media (forced-colors: active) { .routine-run, .badge { border-color: CanvasText; } }
</style>
