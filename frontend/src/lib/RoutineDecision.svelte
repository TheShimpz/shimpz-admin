<script>
  import { Button } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { assistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { routineContext } from '$lib/routineContext.js';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    fillRoutineCopy,
    humanizeId,
    openRoutineCard,
    openRoutineChallenge,
    resumeRoutineIntegrations,
    routineErrorMessage,
  } from '$lib/routine.js';

  // The decision one Routine run waits for (ADR-0092), the same wherever it is shown: a held or paused run's
  // recovery card with its three choices, or a frozen run's approval through chat's own dialog. Nothing runs until
  // the Supervisor answers. `onsettled` hears the outcome words once this decision is answered, and whether the same run
  // was held again and so waits for a fresh decision. With `onunavailable`, a card Team cannot open yet (a held run
  // listed before its incident) keeps Retry here and lets the host refresh; without it, the decision simply ends.
  let { teamId, teamName, runId, routineId, outcome, detail, copy, onsettled = () => {}, onunavailable = null } = $props();

  // A response that arrives after this decision gave way to a newer one never speaks for that newer one.
  let mounted = true;
  $effect(() => () => { mounted = false; });

  let challenge = $state(null);
  let rejection = $state(undefined);
  let working = $state(false);
  let waitingIntegration = $state(false);
  let result = $state('');
  // Set once the run has left its decision; until then Review stays available after a dismissal, an error, an
  // expiry, or a resumed run that froze again for its next approval.
  let ended = $state(false);

  // The held run's recovery card: Team's own card, opened for this person and shown with its choices in Team's order
  // before anything is answered. An answer uses exactly that card's nonce, once; a fresh card follows.
  let card = $state(null);

  const id = $props.id();
  const CHOICE_ICONS = { verify: 'verify', skip: 'skip', pause: 'pause' };
  const HINTS = { verify: 'verifyHint', skip: 'skipHint', pause: 'pauseHint' };
  let listed = $derived($routineContext.get(teamId));
  let recovery = $derived(outcome === 'held' || outcome === 'paused');

  // Where a held or paused run stopped, and its place in the plan when the listed Routine names it exactly once. The
  // step a card names is Team's current one, which a stale row may not show.
  let situation = $derived.by(() => {
    if (!recovery) return null;
    const step = card ?? detail;
    if (step.assistant_id === null) return { step: '', position: '' };
    const steps = listed?.routines.find((routine) => routine.routine_id === routineId)?.steps ?? [];
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
  // Why the person decides: a held run's open question, the reason its Routine paused, or the approval it waits for.
  let reason = $derived.by(() => {
    if (outcome === 'held') return copy.card.reasonHeld;
    if (outcome === 'paused') {
      const words = copy.run.pauseReasons[detail.reason] ?? '';
      return words.charAt(0).toLocaleUpperCase($locale) + words.slice(1);
    }
    return fillRoutineCopy(detail.request_kind === 'human' ? copy.run.frozenHuman : copy.run.frozenIntegrations, {
      assistant: $assistantNames[detail.assistant_id] ?? humanizeId(detail.assistant_id),
      action: humanizeId(detail.action),
    });
  });

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

  function finish(words, heldAgain = false) {
    ended = true;
    if (mounted) onsettled(words, heldAgain);
  }

  // Set when a card is needed: at first, after each answer while the run is still held, and when the person retries
  // an opening that failed; it never retries on its own.
  let wanted = $state(true);
  let recoverable = $derived(recovery && !ended);

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
      card = await openRoutineCard(fetch, teamId, runId);
    } catch (error) {
      card = null;
      // A run already settled has nothing left to answer here; its newer notice replaces this one.
      if (error?.code !== 'routine-incident-unavailable') result = routineErrorMessage(error, copy.errors);
      else if (!onunavailable) finish('');
      else if (mounted) onunavailable();
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
      const answered = await answerRoutineCard(fetch, teamId, runId, answering, choice);
      const run = copy.run;
      if (answered.status === 'skipped') result = run.userSkipped;
      else if (answered.status === 'paused') result = fillRoutineCopy(run.paused, { reason: run.pauseReasons.person });
      else if (answered.status === null) result = unresolvedWords(answered.verdict);
      else result = fillRoutineCopy(run.continued, { outcome: outcomeWords(answered.status) });
      if (answered.status !== null) finish(result, answered.status === 'held');
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
      if (status !== 'frozen') finish(result, status === 'held');
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
        runId,
        $locale,
        (value) => parseChatEvent(value, teamId, teamName),
      );
      // Each opening replaces what the last one showed, so a stale challenge never keeps reopening the run.
      waitingIntegration = opened.status === 'integrations-required';
      challenge = waitingIntegration ? null : opened.challenge;
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
      answered = await answerRoutineChallenge(fetch, teamId, runId, frame);
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
    if (answered.status !== 'frozen') finish(result, answered.status === 'held');
    challenge = null;
  }
</script>

<div class="decision">
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
    <p class="line"><span class="prompt" aria-hidden="true">&gt;</span><span class="value">{reason}</span></p>
  {/if}
  {#if result}<p class="result" role="status">{result}</p>{/if}

  {#if recoverable}
    {#if card}
      <!-- One choice group: a segment per choice in Team's order, the recommended one first and lit. Each segment is
           one button (key, icon, verb, consequence); the recommendation mark sits on the segment's static slot, outside
           the button its hover glitch animates. -->
      <div class="choices" role="group" aria-label={copy.card.choices}>
        {#each card.choices as choice, index (choice)}
          <div class={['segment', choice === card.recommended && 'is-recommended']}>
            <Button
              class="choice"
              variant="ghost"
              type="button"
              disabled={working}
              aria-label={copy.card[choice]}
              aria-describedby={choice === card.recommended ? `${id}-recommended ${id}-${choice}` : `${id}-${choice}`}
              onclick={() => recover(choice)}
            >
              <span class="key" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <RoutineIcon name={CHOICE_ICONS[choice]} />
              <span class="verb">{copy.card[choice]}</span>
              <span class="hint" id={`${id}-${choice}`}>{copy.card[HINTS[choice]]}</span>
            </Button>
            {#if choice === card.recommended}<span class="mark" id={`${id}-recommended`} aria-hidden="true">{copy.card.recommendedMark}</span>{/if}
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
  {:else if recovery || ended}
    <!-- The run is no longer waiting here; its next outcome replaces this decision when it is delivered. -->
  {:else if waitingIntegration}
    <p class="line muted">{fillRoutineCopy(copy.run.connect, { assistant: $assistantNames[detail.assistant_id] ?? humanizeId(detail.assistant_id) })}</p>
    <div class="actions">
      <Button
        size="sm"
        type="button"
        disabled={working}
        onclick={() => settle(() => resumeRoutineIntegrations(fetch, teamId, runId))}
      >{working ? copy.run.working : copy.run.continue}</Button>
    </div>
  {:else}
    <div class="actions">
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
  /* Neutral terminal lines and one choice group: cyan marks only the recommended choice, and state color lives on small
     icons. */
  .decision { container-type: inline-size; display: grid; gap: 0.4rem; min-width: 0; }
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

  /* The choice group: one chamfered frame split into equal segments by hairlines; a narrow card stacks them. The
     recommended segment carries the only cyan: a lit top edge, a faint wash, and its mark. */
  .choices {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    margin-block-start: var(--shimpz-space-3);
    background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, 0 100%);
  }
  :global([dir="rtl"]) .choices { clip-path: polygon(var(--shimpz-cut-lg) 0, 100% 0, 100% 100%, 0 100%, 0 var(--shimpz-cut-lg)); }
  @container (max-width: 34rem) { .choices { grid-auto-flow: row; } }
  .segment { position: relative; display: grid; min-width: 0; }
  .segment + .segment { border-inline-start: 1px solid var(--shimpz-color-border); }
  @container (max-width: 34rem) {
    .segment + .segment { border-inline-start: 0; border-block-start: 1px solid var(--shimpz-color-border); }
  }
  .segment.is-recommended { background: color-mix(in srgb, var(--shimpz-color-cyan) 6%, transparent); box-shadow: inset 0 2px 0 var(--shimpz-color-cyan); }
  .segment :global(.choice) {
    --button-color: var(--shimpz-color-text);
    --button-bg: transparent;
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: var(--shimpz-color-surface-high);
    width: 100%;
    height: 100%;
    min-height: 5.5rem;
    padding: var(--shimpz-space-3) var(--shimpz-space-3) var(--shimpz-space-3);
    text-align: start;
    text-transform: none;
    letter-spacing: normal;
    clip-path: none;
    align-items: stretch;
  }
  .segment :global(.choice:hover:not(:disabled)) { box-shadow: inset 0 -2px 0 var(--shimpz-color-cyan); }
  .segment :global(.choice:focus-visible) { outline: 2px solid var(--shimpz-color-cyan); outline-offset: -2px; box-shadow: none; }
  .segment :global(.choice .button-content) { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; align-content: start; justify-items: start; align-self: stretch; gap: 0.5rem 0.5rem; width: 100%; }
  .segment :global(.choice .routine-icon) { width: 1rem; height: 1rem; color: var(--shimpz-color-text-muted); }
  .segment.is-recommended :global(.choice .routine-icon) { color: var(--shimpz-color-cyan); }
  .key { color: var(--shimpz-color-text-dim); font: 600 0.62rem/1 var(--shimpz-font-mono); letter-spacing: 0.06em; }
  .is-recommended .key { color: var(--shimpz-color-cyan); }
  .verb { font: 700 0.74rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
  /* The consequence stays readable: the hover glitch splits the verb, never this sentence. */
  .hint { grid-column: 1 / -1; color: var(--shimpz-color-text-muted); font: 400 0.78rem/1.45 var(--shimpz-font-sans); text-shadow: none; text-wrap: pretty; white-space: normal; }
  .mark {
    pointer-events: none;
    position: absolute;
    inset-block-start: var(--shimpz-space-3);
    inset-inline-end: var(--shimpz-space-3);
    color: var(--shimpz-color-cyan);
    font: 700 0.56rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); padding-block-start: var(--shimpz-space-1); }
  @media (forced-colors: active) {
    .choices, .segment + .segment { border-color: CanvasText; }
    .segment.is-recommended { box-shadow: none; outline: 2px solid Highlight; outline-offset: -2px; }
  }
</style>
