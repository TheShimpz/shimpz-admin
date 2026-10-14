<script>
  import { Message } from '@shimpz/frontend';
  import AttachmentTile from '#lib/chat/attachments/Tile.svelte';
  import { previewable } from '#lib/chat/attachments/previews.js';
  import { clockTime, instantValue } from '#lib/chat/days.js';
  import InstallPlan from '#lib/chat/lifecycle/InstallPlan.svelte';
  import Uninstall from '#lib/chat/lifecycle/Uninstall.svelte';
  import { shownUsage } from '#lib/chat/turns.js';
  import ClarificationCard from '#lib/chat/ClarificationCard.svelte';
  import { clarifiedRequest } from '#lib/chat/clarification.js';
  import ExecutionReceipt from '#lib/chat/progress/Receipt.svelte';
  import { locale, t } from '#lib/i18n/index.js';
  import Markdown from '#lib/chat/Markdown.svelte';
  import { refusalWords } from '#lib/routines/words.js';
  import RoutineProposal from '#lib/routines/Proposal.svelte';
  import RoutineQuestion from '#lib/routines/Question.svelte';
  import RoutineRunEntry from '#lib/routines/run/Entry.svelte';
  import { formatTaskUsage, formatTaskUsageDetail } from '#lib/chat/usage.js';

  // One exchange of a Team's transcript: a person's message and the reply that answered it, either of them alone. The
  // page owns the turns and every action; this shows them. `words` are the chat's (chat/turns.js); `instantOf` dates a
  // turn; `sentAnswer` is the clarification answer this message sent, `givenAnswer` the one the reply's question got;
  // `joinAbove` and `joinBelow` join a Routine notice's rail to its neighbours; `thinking`, when given, is the turn's
  // live progress, shown after the exchange.
  let {
    exchange,
    words,
    instantOf,
    teamId,
    selectedTeamId,
    assistantNames,
    sentAnswer,
    givenAnswer,
    answerDisabled,
    joinAbove,
    joinBelow,
    lifecycleDisabled,
    onanswer,
    ondecide,
    thinking,
  } = $props();

  let userTurn = $derived(exchange.user);
  // The images Team can no longer read are left out of the message.
  let unreadable = $state(new Set());
  let shownFiles = $derived((userTurn?.files ?? []).filter((file) => !unreadable.has(file.id)));
  // The images the viewer moves through.
  let viewerImages = $derived(shownFiles.filter((file) => previewable(teamId, file)));

  function markUnreadable(fileId) {
    if (!unreadable.has(fileId)) unreadable = new Set([...unreadable, fileId]);
  }
  let assistantTurn = $derived(exchange.assistant);
</script>

<!-- When a message was sent or a reply completed, to the second, in the viewer's timezone. -->
{#snippet turnTime(turn)}
  {@const instant = instantOf(turn)}
  <span class="turn-at">{words.timeAt}</span>
  <time class="turn-time" datetime={instantValue(instant)}>{clockTime(instant, $locale)}</time>
{/snippet}
<!-- A Routine notice keeps its time on its own rail; every other reply shows when it was completed. -->
{#snippet replyTime()}{@render turnTime(assistantTurn)}{/snippet}
<section class="exchange">
  {#if userTurn}
    <Message variant="user" author={words.you}>
      {#snippet meta()}{@render turnTime(userTurn)}{/snippet}
      {#if userTurn.resumedObjective}
        <div class="resumed-task">
          <strong>{words.install.resuming}</strong>
          <span>{userTurn.resumedObjective}</span>
        </div>
      {/if}
      {#if sentAnswer !== null}
        <!-- The question stays above its answer, so the person always sees what they replied to. -->
        <div class="clarification-reply">
          <p class="clarification-question">
            <span class="reply-label">{$t('clarify').questionLabel}</span>{sentAnswer.question}
          </p>
          <p><span class="reply-label">{$t('clarify').answered}</span>{sentAnswer.answer}</p>
        </div>
      {:else}
        <p>{userTurn.text}</p>
      {/if}
      {#if shownFiles.length}
        <!-- A message's files follow its text, one compact card each. -->
        <ul class="sent-attachments" aria-label={$t('attachments').list}>
          {#each shownFiles as file (file.key)}
            <AttachmentTile {teamId} {file} images={viewerImages} onunavailable={markUnreadable} />
          {/each}
        </ul>
      {/if}
    </Message>
  {/if}
  {#if assistantTurn}
    <!-- A Routine notice names its Routine in its own words; the chat already is the Team's. -->
    <Message
      variant="assistant"
      author={assistantTurn.routineRun ? undefined : assistantTurn.author}
      meta={assistantTurn.routineRun ? undefined : replyTime}
    >
      {@const clarifiedOriginal = clarifiedRequest(exchange)}
      {#if clarifiedOriginal !== null}
        <ClarificationCard
          clarification={assistantTurn.clarification}
          original={clarifiedOriginal}
          copy={$t('clarify')}
          answered={givenAnswer}
          disabled={answerDisabled}
          {onanswer}
        />
      {:else if assistantTurn.routineRun}
        <RoutineRunEntry
          entry={assistantTurn.routineRun}
          copy={$t('routine')}
          {joinAbove}
          {joinBelow}
        />
      {:else if !assistantTurn.installPlan && (
        !assistantTurn.lifecycle || assistantTurn.lifecycle.state === 'proposed'
      )}
        <Markdown markdown={assistantTurn.text} variant="chat" />
      {/if}
      {#if assistantTurn.installPlan}
        <InstallPlan plan={assistantTurn.installPlan} {teamId} {words} />
      {/if}
      {#if assistantTurn.lifecycle}
        <Uninstall
          lifecycle={assistantTurn.lifecycle}
          author={assistantTurn.author}
          {teamId}
          {words}
          disabled={lifecycleDisabled}
          {ondecide}
        />
      {/if}
      <!-- With recorded steps, the usage line itself opens them: one line, its triangle beside it. -->
      {#snippet usageLine()}
        {@const shown = shownUsage(assistantTurn).usage}
        <span class="task-usage" title={formatTaskUsageDetail(shown, $locale, words.usage)}>
          {formatTaskUsage(shown, $locale, words.usage)}
        </span>
      {/snippet}
      {#if assistantTurn.usage && !shownUsage(assistantTurn).receipt}
        <p class="task-usage" title={formatTaskUsageDetail(assistantTurn.usage, $locale, words.usage)}>
          {formatTaskUsage(assistantTurn.usage, $locale, words.usage)}
        </p>
      {/if}
      <ExecutionReceipt
        line={assistantTurn.usage ? usageLine : undefined}
        durationMs={assistantTurn.usage?.durationMs}
        events={assistantTurn.receipt ?? []}
        label={words.progressStagesExecuted}
        progressLabels={words.progress}
        teamName={assistantTurn.author}
        {assistantNames}
      />
      <!-- A recording turn's Routine card, what Team asks first, or why it made none; a reload shows it again. -->
      {#if assistantTurn.routineQuestion && exchange.user}
        <RoutineQuestion
          question={assistantTurn.routineQuestion}
          original={exchange.user.text}
          copy={$t('routine').proposal}
          clarifyCopy={$t('clarify')}
          answered={givenAnswer}
          disabled={answerDisabled}
          {onanswer}
        />
      {:else if assistantTurn.routineProposal}
        <RoutineProposal teamId={selectedTeamId} proposal={assistantTurn.routineProposal}
          copy={$t('routine')} locale={$locale} />
      {:else if assistantTurn.routineRefusal}
        <p class="routine-refusal" role="note">{refusalWords(assistantTurn.routineRefusal, $t('routine').proposal)}</p>
      {/if}
    </Message>
  {/if}
  {@render thinking?.()}
</section>

<style>
  .exchange {
    /* A Routine notice's timeline rail reaches back across this gap to the notice before it. */
    --routine-rail-gap: var(--gap-group);
    display: grid;
    min-width: 0;
    align-content: start;
    gap: var(--gap-item);
    margin-block-start: var(--routine-rail-gap);
  }

  .exchange:first-child,
  :global(.chat-day) + .exchange {
    margin-block-start: 0;
  }

  .exchange:last-child {
    min-block-size: 100%;
  }

  /* Inside the receipt's uppercase summary the usage keeps its own case and spacing. */
  span.task-usage { margin: 0; text-transform: none; }
  .task-usage {
    margin: var(--gap-inside) 0 0;
    color: var(--shimpz-color-text-dim);
    font: 500 0.68rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .routine-refusal {
    margin: var(--gap-item) 0 0;
    color: var(--shimpz-color-text-muted);
    font-size: 0.85rem;
  }
  /* "às" reads as a word in the sentence "NEO às 10:30:00", not as part of the uppercase label. */
  .turn-at {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  /* Beside the author, as quiet as the day headers and the Routine rail's times: small dim digits that never shift. */
  .turn-time {
    font: 400 0.66rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .clarification-reply { display: grid; gap: var(--gap-item); margin: 0; }
  .clarification-reply p { display: grid; gap: var(--gap-inside); margin: 0; }
  .clarification-question { color: var(--shimpz-color-text-muted); }
  .reply-label {
    color: var(--shimpz-color-text-muted);
    font-family: var(--shimpz-font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .resumed-task {
    display: grid;
    gap: var(--gap-inside);
    margin-bottom: var(--gap-item);
    padding-left: var(--gap-group);
    border-left: 2px solid currentColor;
    color: var(--text-faint);
    line-height: 1.45;
  }

  .resumed-task strong {
    color: currentColor;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* A sent message's files, under its text, one card under another. */
  .sent-attachments {
    display: grid;
    width: 100%;
    gap: var(--gap-inside);
    margin: var(--gap-item) 0 0;
    padding: 0;
    list-style: none;
  }


</style>
