<script>
  import { Button } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import RoutinePlan from '$lib/RoutinePlan.svelte';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    fillRoutineCopy,
    openRoutineCard,
    openRoutineChallenge,
    resumeRoutineIntegrations,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message. It names the Routine by its quoted request and never carries an Action's raw input or result; it is
  // not part of the Brain's conversation. A frozen run is answered here with chat's own approval dialog, and nothing
  // runs until the Supervisor answers. A held or paused run offers its recovery card's three choices (ADR-0092).
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
  let detail = $derived(entry.detail);
  let actions = $derived(
    (detail.actions ?? []).map(([assistant, action]) => `${assistant} · ${action}`).join(', '),
  );
  let summary = $derived.by(() => {
    const run = copy.run;
    switch (entry.outcome) {
      case 'done': return run.done;
      case 'recovered': return run.recovered;
      case 'held': return heldWords(card ?? detail);
      case 'paused': return fillRoutineCopy(run.paused, { reason: run.pauseReasons[detail.reason] });
      case 'user-skipped': return run.userSkipped;
      case 'failed': return fillRoutineCopy(run.failed, { code: detail.code });
      case 'denied': return run.denied;
      case 'stopped': return run.stopped;
      case 'skipped': return fillRoutineCopy(run.skipped, { missed: detail.missed });
      case 'healthy': return fillRoutineCopy(run.healthy, { runs: detail.runs });
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
          assistant: detail.assistant_id,
          action: detail.action,
        });
    }
  });
  // The step a card names is Team's current one, which a stale transcript row may not show.
  function heldWords(step = detail) {
    if (step.assistant_id === null) return copy.run.heldUnknown;
    return fillRoutineCopy(copy.run.held, { assistant: step.assistant_id, action: step.action });
  }
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

  async function openCard() {
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
    const words = { policy: copy.card.policy, unquiesced: copy.card.unquiesced, unclassified: copy.card.unclassified };
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

  let tone = $derived(
    ['failed', 'denied'].includes(entry.outcome)
      ? 'bad'
      : ['frozen', 'held', 'paused', 'scope-changed'].includes(entry.outcome)
        ? 'waiting'
        : 'neutral',
  );
</script>

<div class={['routine-run', tone]}>
  <p class="label">{copy.run.label} · <span class="quote">{entry.quote}</span></p>
  <p class="summary">{summary}</p>
  {#if entry.outcome === 'created' || entry.outcome === 'changed'}
    <RoutinePlan steps={detail.steps} copy={copy.plan} />
  {/if}
  {#if actions}
    <p class="actions">{fillRoutineCopy(copy.run.actions, { actions })}</p>
  {/if}
  {#if result}
    <p class="result" role="status">{result}</p>
  {/if}
  {#if recoverable}
    {#if card}
      {#if entry.outcome === 'paused'}<p class="actions">{heldWords(card)}</p>{/if}
      <!-- Pular's consequence is stated before any choice is made. -->
      <p class="actions">{copy.card.skipConsequence}</p>
      <div class="buttons">
        {#each card.choices as choice (choice)}
          <Button
            size="sm"
            variant={choice === card.recommended ? 'primary' : 'secondary'}
            type="button"
            disabled={working}
            onclick={() => recover(choice)}
          >{copy.card[choice]}</Button>
        {/each}
      </div>
    {:else if !working}
      <div class="buttons">
        <Button size="sm" variant="secondary" type="button" onclick={() => (wanted = true)}>{copy.list.retry}</Button>
      </div>
    {/if}
  {:else if entry.outcome !== 'frozen' || ended}
    <!-- The run is no longer waiting here; its next outcome replaces this row when it is delivered. -->
  {:else if waitingIntegration}
    <p class="actions">{fillRoutineCopy(copy.run.connect, { assistant: detail.assistant_id })}</p>
    <div class="buttons">
      <Button
        size="sm"
        type="button"
        disabled={working}
        onclick={() => settle(() => resumeRoutineIntegrations(fetch, teamId, entry.runId))}
      >{working ? copy.run.working : copy.run.continue}</Button>
    </div>
  {:else}
    <div class="buttons">
      <Button size="sm" type="button" disabled={working} onclick={review}>
        {working ? copy.run.working : copy.run.review}
      </Button>
    </div>
  {/if}
</div>

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
  .routine-run { display: grid; gap: var(--shimpz-space-1); }
  .label { margin: 0; color: var(--shimpz-color-cyan); font: 700 0.7rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; overflow-wrap: anywhere; }
  .quote { color: var(--shimpz-color-text-muted); letter-spacing: 0; text-transform: none; font-family: var(--shimpz-font-sans); font-weight: 600; }
  .summary { margin: 0; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .bad .summary { color: var(--shimpz-color-danger); }
  .waiting .summary { color: var(--shimpz-color-yellow); }
  .actions, .result { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; overflow-wrap: anywhere; }
  .result { color: var(--shimpz-color-text); }
  .buttons { display: flex; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-1); }
</style>
