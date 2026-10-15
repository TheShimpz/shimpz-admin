<script>
  import { Message } from '@shimpz/frontend';
  import AttachmentTile from '#lib/chat/attachments/Tile.svelte';
  import { clockTime, instantValue } from '#lib/chat/days.js';
  import InstallPlan from '#lib/chat/lifecycle/InstallPlan.svelte';
  import Uninstall from '#lib/chat/lifecycle/Uninstall.svelte';
  import { shownUsage } from '#lib/chat/turns.js';
  import ClarificationCard from '#lib/chat/clarification/Card.svelte';
  import { clarifiedRequest } from '#lib/chat/clarification/compose.js';
  import ExecutionReceipt from '#lib/chat/progress/Receipt.svelte';
  import { locale, t } from '#lib/i18n/index.js';
  import Markdown from '#lib/chat/Markdown.svelte';
  import { refusalWords } from '#lib/routines/words.js';
  import RoutineProposal from '#lib/routines/Proposal.svelte';
  import RoutineQuestion from '#lib/routines/Question.svelte';
  import { formatTaskUsage, formatTaskUsageDetail } from '#lib/chat/usage.js';
  import { fill } from '#lib/i18n/fill.js';

  // One exchange of a Team's transcript: a person's message and the reply that answered it, either of them alone. The
  // page owns the turns and every action; this shows them. `words` are the chat's (chat/turns.js); `instantOf` dates a
  // turn; `sentAnswer` is the clarification answer this message sent, `givenAnswer` the one the reply's question got;
  // `cardAnswer` is how the person already answered the reply's Routine card, if they did; `thinking`, when given, is
  // the turn's live progress, shown after the exchange.
  let {
    exchange,
    words,
    instantOf,
    teamId,
    selectedTeamId,
    sentAnswer,
    givenAnswer,
    answerDisabled,
    lifecycleDisabled,
    onanswer,
    onrewrite = () => false,
    cardAnswer = '',
    ondecide,
    thinking,
  } = $props();

  let userTurn = $derived(exchange.user);
  // The images Team can no longer read are left out of the message.
  let unreadable = $state(new Set());
  let shownFiles = $derived((userTurn?.files ?? []).filter((file) => !unreadable.has(file.id)));

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
<!-- Every reply shows when it was completed; a Routine's creation, when Team made it. -->
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
            <AttachmentTile {teamId} {file} files={shownFiles} onunavailable={markUnreadable} />
          {/each}
        </ul>
      {/if}
    </Message>
  {/if}
  {#if assistantTurn}
    <Message variant="assistant" author={assistantTurn.author} meta={replyTime}>
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
      {:else if assistantTurn.routineRun || assistantTurn.routineAnswer}
        <!-- A Routine's creation, or a card's confirmed change, says so at its own time, naming the Routine only in the
             words Team froze into it. -->
        {@const said = assistantTurn.routineRun ?? assistantTurn.routineAnswer}
        <p class="routine-run" role="group" aria-label={said.name} tabindex="-1">
          {fill($t('routine').proposal.answers[assistantTurn.routineRun ? 'created' : said.status], { name: said.name })}
        </p>
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
      <!-- Only a reply's usage line opens its recorded steps; a reply without usage shows none. With recorded steps,
           the usage line itself opens them: one line, its triangle beside it. -->
      {#if assistantTurn.usage}
        {@const shown = shownUsage(assistantTurn)}
        {#if shown.steps.length > 0}
          {#snippet usageLine()}
            <span class="task-usage" title={formatTaskUsageDetail(shown.usage, $locale, words.usage)}>
              {formatTaskUsage(shown.usage, $locale, words.usage)}
            </span>
          {/snippet}
          <ExecutionReceipt
            line={usageLine}
            steps={shown.steps}
            label={words.progressStagesExecuted}
            progressLabels={words.progress}
          />
        {:else}
          <p class="task-usage" title={formatTaskUsageDetail(shown.usage, $locale, words.usage)}>
            {formatTaskUsage(shown.usage, $locale, words.usage)}
          </p>
        {/if}
      {/if}
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
          copy={$t('routine')} disabled={answerDisabled} answered={cardAnswer} {onrewrite} />
      {:else if assistantTurn.routineRefusal}
        <p class="routine-refusal" role="note">{refusalWords(assistantTurn.routineRefusal, $t('routine').proposal)}</p>
      {/if}
    </Message>
  {/if}
  {@render thinking?.()}
</section>

<style>
  .exchange {
    display: grid;
    min-width: 0;
    align-content: start;
    gap: var(--gap-item);
    margin-block-start: var(--gap-group);
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
  .exchange .routine-run { margin: 0; color: var(--shimpz-color-green); font-weight: 600; outline-offset: 4px; }
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
    border-radius: 0;
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
