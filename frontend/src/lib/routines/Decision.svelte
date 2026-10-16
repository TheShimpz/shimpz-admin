<script>
  import { Button, Disclosure } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import AssistantHumanRequestDialog from '#lib/assistants/HumanRequestDialog.svelte';
  import { assistantName } from '#lib/assistants/names.js';
  import ChoiceList from '#lib/choice/List.svelte';
  import { call, commandsReady } from '#lib/session/socket.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { createHumanResponseFrame, parseChatEvent } from '#lib/chat/protocol.js';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import { humanizeId } from '#lib/ids.js';
  import {
    answerRoutineCard,
    answerRoutineChallenge,
    openRoutineCard,
    openRoutineChallenge,
    resumeRoutineIntegrations,
  } from '#lib/routines/protocol.js';
  import { conditionWords, failureCause, routineFailureWords } from '#lib/routines/words.js';

  // The decision one Routine run waits for (ADR-0092), the same wherever it is shown: a held run's
  // recovery card, or a frozen run's approval through chat's own dialog. Nothing runs until the Supervisor answers.
  // A card says which step stopped, the error it returned, and its likely cause in plain words, then offers exactly
  // Rodar and Excluir; Excluir is the Routine's own confirmed deletion, which `ondelete` opens in the host.
  // `onsettled` hears the outcome words once this decision is answered, and whether the same run was held again and
  // so waits for a fresh decision. A card Team cannot open yet (a held run listed before its incident) keeps Retry here
  // and `onunavailable` lets the host refresh, as does a frozen run another window already resumed; a card whose
  // evidence Team cannot verify or whose state it cannot read also offers Excluir, since the host hides its own Delete
  // while a decision is pending. When a card reading leaves focus nowhere in the host's dialog, focus moves to what the
  // person acts on next; focus they placed there stays.
  let {
    teamId,
    teamName,
    runId,
    outcome,
    detail,
    copy,
    onsettled,
    onunavailable,
    ondelete,
  } = $props();

  // A response that arrives after this decision gave way to a newer one never speaks for that newer one.
  let mounted = true;
  $effect(() => () => { mounted = false; });

  let challenge = $state(null);
  let rejection = $state(undefined);
  let working = $state(false);
  let waitingIntegration = $state(false);
  let result = $state('');
  // Set once the run has left its decision; until then Review stays available after a dismissal, an error, or a
  // resumed run that froze again for its next approval.
  let ended = $state(false);

  // The held run's recovery card: Team's own card, opened for this person before anything is answered. An answer names
  // the card's tag, so Team applies it only to exactly the state the card showed; a fresh card follows.
  let card = $state(null);

  // Rodar and Excluir, in this order, none recommended (ADR-0092 section 7).
  const CHOICES = ['run', 'delete'];
  // The card openings Team refuses for the run itself, which a retry may not change: Excluir stays possible.
  const UNOPENABLE = new Set(['routine-incident-unverifiable', 'routine-state-unavailable']);
  let unopenable = $state(false);
  // Whether the last card reading failed: its Retry stays in place, disabled, while the person's retry reads again.
  let unopened = $state(false);
  let root = $state();
  const CHOICE_ICONS = { run: 'play', delete: 'trash' };
  const HINTS = { run: 'runHint', delete: 'deleteHint' };
  let recovery = $derived(outcome === 'held');

  // Where a held run stopped, as one sentence: the step its open card names, else the one its incident or notice names,
  // a replay step of the plan the run executed.
  let situation = $derived.by(() => {
    if (!recovery) return '';
    const step = card ?? detail;
    if (step.assistant_id === null) return copy.run.stoppedUnknown;
    const words = fill(copy.card.step, {
      assistant: $assistantName(step.assistant_id),
      action: humanizeId(step.action),
    });
    return fill(copy.card.stoppedAt, { n: step.position, total: step.steps, step: words });
  });
  // What the person is asked to decide: a held run waits for them, and a frozen one names the approval it waits for.
  let reason = $derived.by(() => {
    if (outcome === 'held') return copy.card.heldLead;
    const frozen = { human: copy.run.frozenHuman, integrations: copy.run.frozenIntegrations };
    return fill(frozen[detail.request_kind], {
      assistant: $assistantName(detail.assistant_id),
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

  // A change Admin never answered because the socket dropped may or may not have happened, and says so.
  function failed(error) {
    return routineFailureWords(error, copy.errors, $t('shell.outcomeUnknown'));
  }

  // An exit that keeps this decision open (its request dismissed or expired, refused, or answered frozen again) or a card
  // reading unmounts or disables what had focus; focus then moves to `target`, by default the decision's first enabled
  // action, never to the document. Focus the person placed in the host's dialog stays.
  async function keepFocus(target = '.actions button:not(:disabled)') {
    await tick();
    if (!mounted || root?.closest('dialog')?.contains(document.activeElement)) return;
    root?.querySelector(target)?.focus();
  }

  // A request that closes leaves focus with the decision; the next review's opening clears any earlier refusal.
  function closeChallenge() {
    challenge = null;
    void keepFocus();
  }

  async function openCard() {
    try {
      card = await openRoutineCard(call, teamId, runId);
      unopenable = false;
      unopened = false;
    } catch (error) {
      card = null;
      unopenable = UNOPENABLE.has(error?.code);
      unopened = true;
      // A run already settled has nothing left to answer here; its newer notice replaces this one.
      if (error?.code !== 'routine-incident-unavailable') result = failed(error);
      else if (mounted) onunavailable();
    }
  }

  $effect(() => {
    // A card opens while Admin is reachable; one wanted while the socket reconnects opens once it is back.
    if (recoverable && wanted && !working && $commandsReady) {
      wanted = false;
      working = true;
      void openCard().finally(() => {
        working = false;
        void keepFocus(card ? '[data-choice="run"]' : undefined);
      });
    }
  });

  // The error the held step returned, as Team recorded it: the literal text, never interpreted, and its likely cause.
  let failure = $derived.by(() => {
    if (!card) return null;
    if (card.evidence !== 'recorded') {
      return { cause: card.evidence === 'unavailable' ? copy.card.detailUnavailable : copy.card.noDetail };
    }
    const item = card.diagnostic;
    const text = item.failure
      ? item.failure.message || item.failure.error_type
      : conditionWords(item.condition ?? '', copy.details);
    const meta = item.failure
      ? [item.failure.http_status === null ? '' : `HTTP ${item.failure.http_status}`, item.failure.provider ?? '']
        .filter(Boolean).join(' · ')
      : '';
    const cause = failureCause(item);
    return {
      title: cause === 'unknown' ? '' : copy.card.causeTitles[cause],
      // A cause with nothing to add beyond its title has no line of its own.
      cause: copy.card.causes[cause] ?? '',
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
      await answerRoutineCard(call, teamId, runId, card);
      result = copy.card.requested;
      finish(result);
    } catch (error) {
      result = failed(error);
    } finally {
      // An answer, refused or not, may have moved the run on, so its card is read again: while the run is still held,
      // the next answer carries the current tag.
      card = null;
      wanted = true;
      working = false;
    }
  }

  async function settle(action) {
    working = true;
    try {
      const status = await action();
      result = fill(copy.run.continued, { outcome: outcomeWords(status) });
      if (status !== 'frozen') finish(result, status === 'held');
      waitingIntegration = false;
    } catch (error) {
      result = failed(error);
      // A run another window already continued waits for nothing here: the host reads its Routines again.
      if (error?.code === 'routine-run-not-frozen' && mounted) onunavailable();
    } finally {
      working = false;
      closeChallenge();
    }
  }

  async function review() {
    working = true;
    result = '';
    try {
      // Team renders the request copy in the interface language selected when the run is reviewed (ADR-0091).
      const opened = await openRoutineChallenge(
        call,
        teamId,
        runId,
        $locale,
        (value) => parseChatEvent(value, teamId, teamName),
      );
      // Each opening replaces what the last one showed, so a stale challenge never keeps reopening the run.
      waitingIntegration = opened.status === 'integrations-required';
      challenge = waitingIntegration ? null : opened.challenge;
      rejection = undefined;
    } catch (error) {
      result = failed(error);
      challenge = null;
      // A run another window already resumed waits for nothing here: the host reads its Routines again.
      if (error?.code === 'routine-run-not-frozen' && mounted) onunavailable();
    } finally {
      working = false;
      // An opened request takes focus itself; anything else leaves it here.
      if (!challenge) void keepFocus();
    }
  }

  // A challenge opened in another language than the one selected now is never answered: each opening is a fresh
  // challenge, so the run is opened again in the selected language, also when the language changed mid-opening.
  let stale = $derived(Boolean(challenge) && challenge.locale !== $locale);
  $effect(() => {
    if (stale && !working) void review();
  });

  async function respond(response) {
    const asked = challenge;
    const frame = createHumanResponseFrame(teamId, asked.challenge_id, response.decision, response.value);
    working = true;
    let answered;
    try {
      answered = await answerRoutineChallenge(call, teamId, runId, frame);
    } catch (error) {
      result = failed(error);
      working = false;
      closeChallenge();
      return;
    }
    working = false;
    if (answered.rejection) {
      // A wrong password keeps the dialog open for another attempt, as in chat. A refusal of a request that closed
      // meanwhile has no dialog left to show it: focus stays with the decision.
      if (challenge === asked) rejection = answered.rejection;
      else void keepFocus();
      return;
    }
    result = fill(copy.run.continued, { outcome: outcomeWords(answered.status) });
    if (answered.status !== 'frozen') finish(result, answered.status === 'held');
    closeChallenge();
  }
</script>

<div class="decision" bind:this={root}>
  {#if situation}
    <!-- One clear message: what happened, where, and that the person chooses how to go on. -->
    <!-- What happened, as the headline: the likely cause in plain words when the error says it, else that the run
         stopped; then where; then its likely cause as a fact; the literal error stays one click away. -->
    <!-- The message reaches the panel's edges and continues its side lines. -->
    <div class="message">
    <div class="alert">
      <!-- The badge wears the failed status's color and the shared idle glitch. -->
      <span class="badge" data-shimpz-glitch="true" aria-hidden="true">
        <span><RoutineIcon name="warning" /></span>
      </span>
      <div class="alert-text">
        <p class="title">{(recoverable && failure?.title) || reason}</p>
        <p class="where">{situation}</p>
      </div>
    </div>
    {#if recoverable && failure && (failure.cause || failure.text)}
      <div class="body">
        <!-- The likely cause is a fact, never advice: with several choices, the person picks one unsteered. -->
        {#if failure.cause}<p class="cause">{failure.cause}</p>{/if}
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
      <!-- One choice list that continues its host's frame to the edges: a row per choice, none recommended. Each row is
           one button (icon, verb, what it does in plain words). -->
      <div class="spacer"></div>
      <ChoiceList
        label={copy.card.choices}
        title={copy.card.choose}
        items={CHOICES.map((choice) => ({
          id: choice,
          icon: CHOICE_ICONS[choice],
          label: copy.card[choice],
          description: copy.card[HINTS[choice]],
        }))}
        disabled={working || !$commandsReady}
        onchoose={recover}
      />
    {:else if unopened || !working}
      <div class="actions">
        <Button size="sm" variant="secondary" type="button" disabled={working || !$commandsReady}
          onclick={() => (wanted = true)}>
          {copy.list.retry}
        </Button>
        {#if unopenable}
          <!-- Named as a choice row is, so Cancel on the deletion it opens returns focus here. -->
          <Button size="sm" variant="secondary" type="button" data-choice="delete" disabled={working || !$commandsReady}
            onclick={ondelete}>
            {copy.card.delete}
          </Button>
        {/if}
      </div>
    {/if}
  {:else if recovery || ended}
    <!-- The run is no longer waiting here; its next outcome replaces this decision when it is delivered. -->
  {:else if waitingIntegration}
    <p class="line muted">{fill(copy.run.connect, { assistant: $assistantName(detail.assistant_id) })}</p>
    <div class="actions">
      <Button
        size="sm"
        type="button"
        disabled={working || !$commandsReady}
        onclick={() => settle(() => resumeRoutineIntegrations(call, teamId, runId))}
      >{working ? copy.run.working : copy.run.continue}</Button>
    </div>
  {:else}
    <div class="actions">
      <Button size="sm" type="button" disabled={working || !$commandsReady} onclick={review}>
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
    working={working || stale || !$commandsReady}
    onrespond={respond}
    ondismiss={closeChallenge}
    dismissLabel={copy.run.dismiss}
    onretry={() => (rejection = undefined)}
    onexpire={() => { result = copy.errors.expired; closeChallenge(); }}
  />
{/if}

<style>
  /* One plain message and one choice list: cyan marks only the hovered choice, and state color lives on small
     icons. */
  .decision { container-type: inline-size; display: flex; flex: 1 1 auto; flex-direction: column; gap: var(--gap-item); min-width: 0; }
  /* Terminal lines flow as text, so a narrow card wraps words, never whole pieces of the line. */
  .line { margin: 0; font: 400 0.78rem/1.55 var(--shimpz-font-mono); overflow-wrap: break-word; }
  .line > * + * { margin-inline-start: var(--gap-inside); }
  .line.muted { color: var(--shimpz-color-text-muted); }
  .prompt { color: var(--shimpz-color-cyan); }
  .value { color: var(--shimpz-color-text); }
  /* What happened: a warning badge beside the headline and where it stopped; the likely cause and the technical error
     sit under the headline's own edge. */
  .alert { display: grid; grid-template-columns: 2.75rem minmax(0, 1fr); align-items: center; gap: var(--gap-item); }
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
  .badge > span { display: grid; place-items: center; }
  .badge :global(.routine-icon) { width: 1.25rem; height: 1.25rem; filter: drop-shadow(0 0 0.35rem color-mix(in srgb, var(--badge-color) 55%, transparent)); }
  @media (forced-colors: active) { .badge { border-color: CanvasText; box-shadow: none; } }
  .alert-text { display: grid; gap: var(--gap-inside); min-width: 0; }
  .title { margin: 0; color: var(--shimpz-color-text); font: 600 1.12rem/1.3 var(--shimpz-font-sans); text-wrap: balance; overflow-wrap: anywhere; }
  .where { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.84rem; line-height: 1.45; overflow-wrap: anywhere; }
  /* Under the headline's own edge: the badge's width plus the alert's gap. */
  .body { display: grid; gap: var(--gap-item); margin-block-start: var(--gap-item); padding-inline-start: calc(2.75rem + var(--gap-item)); }
  .cause { margin: 0; max-width: 64ch; color: var(--shimpz-color-text-muted); font-size: 0.92rem; line-height: 1.5; text-wrap: pretty; }
  :global([dir="rtl"]) .technical-summary :global(.routine-icon) { transform: scaleX(-1); }
  /* The literal error, quiet and one click away. */
  .decision :global(.technical) { border-block-start: 0; padding-block-start: 0; }
  .decision :global(.technical summary) { list-style: none; color: var(--shimpz-color-text-dim); font: 500 0.78rem/1.4 var(--shimpz-font-sans); letter-spacing: normal; text-transform: none; }
  .decision :global(.technical summary:hover) { color: var(--shimpz-color-text); }
  .decision :global(.technical summary::-webkit-details-marker) { display: none; }
  .technical-summary { display: inline-flex; align-items: center; gap: var(--gap-inside); }
  .technical-summary :global(.routine-icon) { width: 0.8rem; height: 0.8rem; transition: transform var(--shimpz-duration-fast) var(--shimpz-ease); }
  .decision :global(.technical[open] .technical-summary .routine-icon) { transform: rotate(90deg); }
  .technical-error { display: grid; gap: var(--gap-item); min-width: 0; }
  .error-text { margin: 0; padding: var(--gap-item) var(--gap-group); background: var(--shimpz-color-surface-high); border: 1px solid var(--shimpz-color-border-subtle); color: var(--shimpz-color-text); font: 400 0.76rem/1.5 var(--shimpz-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .technical-error .meta { margin: 0; color: var(--shimpz-color-text-muted); font: 400 0.72rem/1.4 var(--shimpz-font-mono); overflow-wrap: anywhere; }
  .result { margin: 0; color: var(--shimpz-color-text); font-size: 0.85rem; line-height: 1.45; }

  /* The message reaches the panel's edges, as the choice list below it does; the panel's side lines run only beside
     the header and the message, and the answers below are open. */
  .spacer { flex: 0 0 0; }
  .message {
    display: grid;
    flex: 1 0 auto;
    align-content: start;
    gap: var(--gap-item);
    margin-inline: calc(-1 * var(--gap-panel));
    padding: var(--gap-panel) var(--gap-panel) var(--gap-group);
    box-shadow: inset 1px 0 0 var(--shimpz-color-border), inset -1px 0 0 var(--shimpz-color-border);
    border-block-end: 1px solid var(--shimpz-color-border);
    /* Its sides and bottom continue the panel's frame lines, which run straight. */
    border-radius: 0;
  }
  .actions { display: flex; flex-wrap: wrap; gap: var(--gap-group); padding-block-start: var(--gap-inside); }
</style>
