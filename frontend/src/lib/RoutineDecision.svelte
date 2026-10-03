<script>
  import { Button, Disclosure } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { assistantNames } from '$lib/assistantNames.js';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { routineContext } from '$lib/routineContext.js';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    failureCause,
    fillRoutineCopy,
    humanizeId,
    openRoutineCard,
    openRoutineChallenge,
    resumeRoutineIntegrations,
    routineErrorMessage,
  } from '$lib/routine.js';

  // The decision one Routine run waits for (ADR-0092), the same wherever it is shown: a held or paused run's
  // recovery card, or a frozen run's approval through chat's own dialog. Nothing runs until the Supervisor answers.
  // A card says which step stopped, the error it returned, and its likely cause in plain words, then offers exactly
  // Rodar, Recriar, and Excluir; Excluir is the Routine's own confirmed deletion, which `ondelete` opens in the host.
  // `onsettled` hears the outcome words once this decision is answered, and whether the same run was held again and
  // so waits for a fresh decision. With `onunavailable`, a card Team cannot open yet (a held run listed before its
  // incident) keeps Retry here and lets the host refresh; without it, the decision simply ends.
  let {
    teamId,
    teamName,
    runId,
    routineId,
    outcome,
    detail,
    copy,
    onsettled = () => {},
    onunavailable = null,
    ondelete = () => {},
  } = $props();

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
  const CHOICE_ICONS = { run: 'play', recreate: 'rebuild', delete: 'trash' };
  const HINTS = { run: 'runHint', recreate: 'recreateHint', delete: 'deleteHint' };
  let listed = $derived($routineContext.get(teamId));
  let recovery = $derived(outcome === 'held' || outcome === 'paused');

  // Where a held or paused run stopped, as one sentence: its place in the plan the run executed, which the card
  // names; before the card opens, the listed Routine's place when it names that step exactly once.
  let situation = $derived.by(() => {
    if (!recovery) return '';
    const step = card ?? detail;
    if (step.assistant_id === null) return copy.run.stoppedUnknown;
    const words = fillRoutineCopy(copy.plan.step, {
      assistant: $assistantNames[step.assistant_id] ?? humanizeId(step.assistant_id),
      action: humanizeId(step.action),
    }).replace(' · ', ' › ');
    if (card) return fillRoutineCopy(copy.card.stoppedAt, { n: card.step, total: card.steps, step: words });
    const steps = listed?.routines.find((routine) => routine.routine_id === routineId)?.steps ?? [];
    const matches = steps.flatMap((item, index) => (
      item.assistant === step.assistant_id && item.action === step.action ? [index + 1] : []
    ));
    return matches.length === 1
      ? fillRoutineCopy(copy.card.stoppedAt, { n: matches[0], total: steps.length, step: words })
      : fillRoutineCopy(copy.card.stoppedAtStep, { step: words });
  });
  // What the person is asked to decide: a held run waits for them, a paused one says why it paused, and a frozen one
  // names the approval it waits for.
  let reason = $derived.by(() => {
    if (outcome === 'held') return copy.card.heldLead;
    if (outcome === 'paused') return fillRoutineCopy(copy.run.paused, { reason: copy.run.pauseReasons[detail.reason] ?? '' });
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

  // The error the held step returned, as Team recorded it: the literal text, never interpreted, and its likely cause.
  let failure = $derived.by(() => {
    if (!card) return null;
    if (card.evidence !== 'recorded') {
      return { cause: card.evidence === 'unavailable' ? copy.card.detailUnavailable : copy.card.noDetail, known: false };
    }
    const item = card.diagnostic;
    const conditions = copy.details.conditions;
    const exit = item.condition?.match(/^exit-status:(-?\d+)$/);
    const text = item.failure
      ? item.failure.message || item.failure.error_type
      : exit
        ? fillRoutineCopy(conditions.exit, { code: exit[1] })
        : {
          'stderr-output': conditions.stderr,
          timeout: conditions.timeout,
          'frame-invalid': conditions.frame,
          'exit-unavailable': conditions.exitUnavailable,
          'transport-failed': conditions.transport,
        }[item.condition];
    const meta = item.failure
      ? [item.failure.http_status === null ? '' : `HTTP ${item.failure.http_status}`, item.failure.provider ?? '']
        .filter(Boolean).join(' · ')
      : '';
    const cause = failureCause(item);
    return {
      title: cause === 'unknown' ? '' : copy.card.causeTitles[cause],
      cause: copy.card.causes[cause],
      known: cause !== 'unknown',
      text,
      meta,
      redacted: Boolean(item.failure?.redacted),
      truncated: Boolean(item.failure?.truncated),
    };
  });

  async function recover(choice) {
    if (choice === 'delete') {
      // Excluir is the Routine's deletion, confirmed with the password and a second factor where the host shows it.
      ondelete();
      return;
    }
    working = true;
    result = '';
    try {
      const answered = await answerRoutineCard(fetch, teamId, runId, card, choice);
      result = answered.status === 'requested' ? copy.card.requested : copy.card.recreated;
      finish(result);
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
    <!-- One clear message: what happened, where, and that the person chooses how to go on. -->
    <!-- What happened, as the headline: the likely cause in plain words when the error says it, else that the run
         stopped; then where; then the one next step; the literal error stays one click away. -->
    <!-- The message: a host may bleed it to its own edges and draw its side lines (`--decision-message-*`). -->
    <div class="message">
    <div class="alert">
      <!-- The badge wears the status's color (failed red, paused yellow) and the shared idle glitch. -->
      <span class={['badge', outcome === 'paused' ? 'badge--warning' : 'badge--danger']} data-shimpz-glitch="true" aria-hidden="true">
        <span><RoutineIcon name="warning" /></span>
      </span>
      <div class="alert-text">
        <p class="title">{(recoverable && failure?.title) || reason}</p>
        <p class="where">{situation}</p>
      </div>
    </div>
    {#if recoverable && failure}
      <div class="body">
        <p class={['next', failure.known && 'is-step']}>{#if failure.known}<RoutineIcon name="step" />{/if}{failure.cause}</p>
        {#if failure.text}
          <Disclosure class="technical">
            {#snippet summary()}<span class="technical-summary"><RoutineIcon name="chevron" />{copy.card.errorTitle}</span>{/snippet}
            <div class="technical-error">
              <p class="error-text">{failure.text}</p>
              {#if failure.meta}<p class="meta">{failure.meta}</p>{/if}
              {#if failure.redacted}<p class="meta">{copy.details.redacted}</p>{/if}
              {#if failure.truncated}<p class="meta">{copy.details.truncated}</p>{/if}
            </div>
          </Disclosure>
        {/if}
      </div>
    {/if}
    </div>

  {:else}
    <p class="line"><span class="prompt" aria-hidden="true">&gt;</span><span class="value">{reason}</span></p>
  {/if}
  {#if result}<p class="result" role="status">{result}</p>{/if}

  {#if recoverable}
    {#if card}
      <!-- One choice list that continues its host's frame to the edges: a row per choice in Team's order, none
           recommended. Each row is one button (icon, verb, what it does in plain words). -->
      <div class="spacer"></div>
      <div class="choices" role="group" aria-label={copy.card.choices}>
        <p class="ask">{copy.card.choose}</p>
        {#each card.choices as choice (choice)}
          <div class="segment">
            <Button
              class="choice"
              variant="ghost"
              type="button"
              disabled={working}
              aria-label={copy.card[choice]}
              aria-describedby={`${id}-${choice}`}
              data-choice={choice}
              onclick={() => recover(choice)}
            >
              <RoutineIcon name={CHOICE_ICONS[choice]} />
              <span class="verb">{copy.card[choice]}</span>
              <span class="go" aria-hidden="true"><RoutineIcon name="chevron" /></span>
              <span class="hint" id={`${id}-${choice}`}>{copy.card[HINTS[choice]]}</span>
            </Button>
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
  /* One plain message and one choice list: cyan marks only the hovered choice, and state color lives on small
     icons. */
  .decision { container-type: inline-size; display: flex; flex: 1 1 auto; flex-direction: column; gap: 0.4rem; min-width: 0; }
  /* Terminal lines flow as text, so a narrow card wraps words, never whole pieces of the line. */
  .line { margin: 0; font: 400 0.78rem/1.55 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .line > * + * { margin-inline-start: 0.5em; }
  .line :global(.routine-icon) { width: 0.85rem; height: 0.85rem; margin-inline-end: 0.5em; vertical-align: -0.15em; }
  .line.muted { color: var(--shimpz-color-text-muted); }
  .line.muted :global(.routine-icon--warning) { color: var(--shimpz-color-yellow); }
  .prompt { color: var(--shimpz-color-cyan); }
  .value { color: var(--shimpz-color-text); }
  /* What happened: a warning badge beside the headline and where it stopped; the next step and the technical error
     sit under the headline's own edge. */
  .alert { display: grid; grid-template-columns: 2.75rem minmax(0, 1fr); align-items: center; gap: var(--shimpz-space-3); }
  .badge {
    --badge-color: var(--shimpz-color-danger);
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    color: var(--badge-color);
    background:
      repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--badge-color) 7%, transparent) 2px 3px),
      color-mix(in srgb, var(--badge-color) 10%, transparent);
    border: 1px solid var(--badge-color);
    box-shadow: 0 0 0.9rem color-mix(in srgb, var(--badge-color) 28%, transparent);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, var(--shimpz-cut-sm) 100%, 0 calc(100% - var(--shimpz-cut-sm)));
  }
  .badge--warning { --badge-color: var(--shimpz-color-yellow); }
  .badge > span { display: grid; place-items: center; }
  .badge :global(.routine-icon) { width: 1.25rem; height: 1.25rem; filter: drop-shadow(0 0 0.35rem color-mix(in srgb, var(--badge-color) 55%, transparent)); }
  @media (forced-colors: active) { .badge { border-color: CanvasText; box-shadow: none; } }
  .alert-text { display: grid; gap: 0.2rem; min-width: 0; }
  .title { margin: 0; color: var(--shimpz-color-text); font: 600 1.12rem/1.3 var(--shimpz-font-sans); text-wrap: balance; overflow-wrap: anywhere; }
  .where { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.84rem; line-height: 1.45; overflow-wrap: anywhere; }
  .body { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-2); padding-inline-start: calc(2.75rem + var(--shimpz-space-3)); }
  .next { display: flex; align-items: flex-start; gap: 0.5rem; margin: 0; max-width: 64ch; color: var(--shimpz-color-text-muted); font-size: 0.92rem; line-height: 1.5; text-wrap: pretty; }
  .next.is-step { color: var(--shimpz-color-text); }
  .next :global(.routine-icon) { flex: none; width: 0.95rem; height: 0.95rem; margin-block-start: 0.2rem; color: var(--shimpz-color-cyan); }
  :global([dir="rtl"]) .next :global(.routine-icon), :global([dir="rtl"]) .technical-summary :global(.routine-icon) { transform: scaleX(-1); }
  /* The literal error, quiet and one click away. */
  .decision :global(.technical) { border-block-start: 0; padding-block-start: 0; }
  .decision :global(.technical summary) { list-style: none; color: var(--shimpz-color-text-dim); font: 500 0.78rem/1.4 var(--shimpz-font-sans); letter-spacing: normal; text-transform: none; }
  .decision :global(.technical summary:hover) { color: var(--shimpz-color-text); }
  .decision :global(.technical summary::-webkit-details-marker) { display: none; }
  .technical-summary { display: inline-flex; align-items: center; gap: 0.35rem; }
  .technical-summary :global(.routine-icon) { width: 0.8rem; height: 0.8rem; transition: transform var(--shimpz-duration-fast) var(--shimpz-ease); }
  .decision :global(.technical[open] .technical-summary .routine-icon) { transform: rotate(90deg); }
  .technical-error { display: grid; gap: 0.3rem; min-width: 0; }
  .error-text { margin: 0; padding: var(--shimpz-space-2) var(--shimpz-space-3); background: var(--shimpz-color-surface-high); border: 1px solid var(--shimpz-color-border-subtle); color: var(--shimpz-color-text); font: 400 0.76rem/1.5 var(--shimpz-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .technical-error .meta { margin: 0; color: var(--shimpz-color-text-muted); font: 400 0.72rem/1.4 var(--shimpz-font-mono); overflow-wrap: anywhere; }
  /* The question is the list's title, and each choice below answers it: a heading-sized line with a short cyan rule. */
  .ask {
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding: var(--shimpz-space-4) var(--decision-inline, var(--shimpz-space-3)) var(--shimpz-space-3);
    color: var(--shimpz-color-text);
    font: 650 1.12rem/1.3 var(--shimpz-font-sans);
    letter-spacing: -0.01em;
    justify-items: var(--decision-ask-align, start);
    text-align: var(--decision-ask-align, start);
  }
  .ask::after { content: ""; width: 2rem; height: 2px; background: var(--shimpz-color-cyan); box-shadow: 0 0 0.5rem color-mix(in srgb, var(--shimpz-color-cyan) 60%, transparent); }
  .ask + .segment { border-block-start: 1px solid var(--shimpz-color-border); }
  .result { margin: 0; color: var(--shimpz-color-text); font-size: 0.85rem; line-height: 1.45; }

  /* The choice list continues the host's frame: it reaches the host's edges (the host sets the inset it pads with)
     and stacks one row per choice between hairlines. */
  .spacer { flex: 0 0 0; }
  .message {
    display: grid;
    flex: 1 0 auto;
    align-content: start;
    gap: 0.4rem;
    margin-inline: calc(-1 * var(--decision-message-bleed, 0px));
    padding: var(--decision-message-top, 0px) var(--decision-message-bleed, 0px) var(--shimpz-space-3);
    box-shadow: var(--decision-message-sides, none);
    border-block-end: var(--decision-message-rule, 0);
  }
  .choices {
    display: grid;
    justify-items: var(--decision-choices-justify, stretch);
    margin-inline: calc(-1 * var(--decision-inline, 0px));
    border-block-start: var(--decision-choices-rule, 1px solid var(--shimpz-color-border));
  }
  /* A host may narrow the question and its answers (`--decision-choices-width`) and frame the answers as one list
     (`--decision-list-border`); a narrow card always gives them its full width. */
  .ask, .segment { box-sizing: border-box; width: var(--decision-choices-width, auto); max-width: 100%; }
  @container (max-width: 34rem) { .ask, .segment { width: auto; justify-self: stretch; } }
  .segment { display: grid; min-width: 0; border-inline: var(--decision-list-border, 0); }
  .segment:last-child { border-block-end: var(--decision-list-border, 0); }
  .segment + .segment { border-block-start: 1px solid var(--shimpz-color-border); }
  .segment :global(.choice) {
    --button-color: var(--shimpz-color-text);
    --button-bg: transparent;
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: var(--shimpz-color-surface-high);
    width: 100%;
    min-height: 0;
    padding: var(--shimpz-space-3) var(--decision-inline, var(--shimpz-space-3));
    text-align: start;
    text-transform: none;
    letter-spacing: normal;
    clip-path: none;
  }
  .segment :global(.choice:focus-visible) { outline: 2px solid var(--shimpz-color-cyan); outline-offset: -2px; box-shadow: none; }
  /* The icon and the chevron sit in the middle of the whole row, beside the verb and its sentence. */
  .segment :global(.choice .button-content) {
    display: grid;
    grid-template-areas: "icon verb go" "icon hint go";
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    justify-items: start;
    gap: 0.3rem 0.75rem;
    width: 100%;
  }
  .segment :global(.choice .button-content > .routine-icon) { grid-area: icon; align-self: center; }
  .segment :global(.choice .routine-icon) { width: 1rem; height: 1rem; color: var(--shimpz-color-text-muted); }
  .segment :global(.choice:hover:not(:disabled) .routine-icon) { color: var(--shimpz-color-cyan); }
  .verb { grid-area: verb; font: 700 0.76rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
  .go { display: inline-flex; grid-area: go; align-self: center; justify-self: end; }
  :global([dir="rtl"]) .go :global(.routine-icon) { transform: scaleX(-1); }
  /* What a choice does, in plain words; the hover glitch splits the verb, never this sentence. */
  .hint { grid-area: hint; max-width: 68ch; color: var(--shimpz-color-text-muted); font: 400 0.82rem/1.5 var(--shimpz-font-sans); text-shadow: none; text-wrap: pretty; white-space: normal; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--shimpz-space-2); padding-block-start: var(--shimpz-space-1); }
  @media (forced-colors: active) {
    .choices, .segment + .segment { border-color: CanvasText; }
  }
</style>
