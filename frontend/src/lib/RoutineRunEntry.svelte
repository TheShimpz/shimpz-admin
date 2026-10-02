<script>
  import { Button } from '@shimpz/frontend';

  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import { locale } from '$lib/i18n.js';
  import { createHumanResponseFrame, parseChatEvent } from '$lib/localChat.js';
  import Markdown from '$lib/Markdown.svelte';
  import {
    answerRoutineChallenge,
    fillRoutineCopy,
    openRoutineChallenge,
    resumeRoutineIntegrations,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086, ADR-0092), or a Routine created or changed from the user's
  // own message. It names the Routine by its quoted request and never carries an Action's raw input or result; it is not part of the Brain's conversation. A frozen run is answered
  // here with chat's own approval dialog, and nothing runs until the Supervisor answers.
  let { entry, copy, teamId, teamName } = $props();

  let challenge = $state(null);
  let rejection = $state(undefined);
  let working = $state(false);
  let waitingIntegration = $state(false);
  let result = $state('');
  // Set once the run has left its freeze; until then Review stays available after a dismissal, an error, an expiry,
  // or a resumed run that froze again for its next approval.
  let ended = $state(false);

  let detail = $derived(entry.detail);
  let actions = $derived(
    (detail.actions ?? []).map(([assistant, action]) => `${assistant} · ${action}`).join(', '),
  );
  let summary = $derived.by(() => {
    const run = copy.run;
    switch (entry.outcome) {
      case 'done': return run.done;
      case 'needs-input': return fillRoutineCopy(run.needsInput, { question: detail.question });
      case 'failed': return fillRoutineCopy(run.failed, { code: detail.code });
      case 'denied': return run.denied;
      case 'stopped': return run.stopped;
      case 'uncertain': return run.uncertain;
      case 'skipped': return fillRoutineCopy(run.skipped, { missed: detail.missed });
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
  function outcomeWords(status) {
    const run = copy.run;
    return {
      done: run.done,
      denied: run.denied,
      stopped: run.stopped,
      uncertain: run.uncertain,
      frozen: run.waitingAgain,
    }[status] ?? run.failedOutcome;
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
    ['failed', 'denied', 'uncertain'].includes(entry.outcome)
      ? 'bad'
      : ['frozen', 'needs-input', 'scope-changed'].includes(entry.outcome)
        ? 'waiting'
        : 'neutral',
  );
</script>

<div class={['routine-run', tone]}>
  <p class="label">{copy.run.label} · <span class="quote">{entry.quote}</span></p>
  <p class="summary">{summary}</p>
  {#if entry.outcome === 'done'}
    <Markdown markdown={detail.reply} variant="chat" />
  {/if}
  {#if actions}
    <p class="actions">{fillRoutineCopy(copy.run.actions, { actions })}</p>
  {/if}
  {#if result}
    <p class="result" role="status">{result}</p>
  {/if}
  {#if entry.outcome !== 'frozen' || ended}
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
