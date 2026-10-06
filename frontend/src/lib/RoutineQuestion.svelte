<script>
  import { tick } from 'svelte';
  import { Button, RadioField, TextField } from '@shimpz/frontend';

  import { composeClarifiedRequest } from '$lib/clarification.js';
  import { questionWords } from '$lib/routine.js';

  // What Team asks before a recorded Routine can become a card (ADR-0101). The person's answer is an ordinary send,
  // composed with the original request as a clarification's answer is, and nothing is chosen for them: no option is
  // preselected or recommended. Once the exchange holds that answer, only the question and the answer remain.
  let { question, original, copy, clarifyCopy, answered = null, disabled = false, onanswer } = $props();

  const id = $props.id();
  const OTHER = 'other';
  let choice = $state('');
  let custom = $state('');
  let error = $state('');

  let words = $derived(questionWords(question, copy));
  let answer = $derived(choice === OTHER ? custom : choice === '' ? '' : words.answers[Number(choice)]?.text ?? '');
  // An answer sent as a target's exact JSON text reads as that target's label once answered, after a reload too.
  let answeredLabel = $derived(words.answers.find((option) => option.text === answered)?.label ?? answered);
  let ready = $derived(answer.trim().length > 0);

  async function chooseOther() {
    if (choice !== OTHER) return;
    await tick();
    document.getElementById(`${id}-custom`)?.focus();
  }

  function submit(event) {
    event.preventDefault();
    const composed = composeClarifiedRequest(original, words.question, answer, {
      question: clarifyCopy.questionLabel,
      answer: clarifyCopy.answerLabel,
    });
    if (composed === null) {
      error = answer.trim() ? clarifyCopy.tooLong : clarifyCopy.empty;
      return;
    }
    error = '';
    onanswer({ composed, answer: answer.trim() });
  }
</script>

{#if answered !== null}
  <div class="routine-question answered">
    <p class="question">{words.question}</p>
    <p class="choice"><span class="mark" aria-hidden="true">✓</span><span class="sr-only">{clarifyCopy.answered}: </span>{answeredLabel}</p>
  </div>
{:else}
  <form class="routine-question" aria-labelledby={`${id}-question`} onsubmit={submit}>
    <p class="question" id={`${id}-question`}>{words.question}</p>
    <div class="options" role="radiogroup" aria-labelledby={`${id}-question`}>
      {#each words.answers as option, index (option.text)}
        <RadioField
          id={`${id}-option-${index}`}
          name={`${id}-choice`}
          label={option.label}
          optionValue={String(index)}
          bind:value={choice}
          {disabled}
        />
      {/each}
      <RadioField
        id={`${id}-option-other`}
        name={`${id}-choice`}
        label={clarifyCopy.other}
        description={clarifyCopy.otherDescription}
        optionValue={OTHER}
        bind:value={choice}
        onchange={chooseOther}
        {disabled}
      />
      {#if choice === OTHER}
        <TextField
          id={`${id}-custom`}
          label={clarifyCopy.other}
          visuallyHiddenLabel
          placeholder={clarifyCopy.otherPlaceholder}
          bind:value={custom}
          maxlength="4000"
          {disabled}
        />
      {/if}
    </div>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="actions">
      <Button class="answer" type="submit" size="sm" disabled={disabled || !ready}>{clarifyCopy.use}</Button>
    </div>
  </form>
{/if}

<style>
  .routine-question { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-2); }
  .question { margin: 0; color: var(--shimpz-color-text); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .answered .question { color: var(--shimpz-color-text-muted); font-weight: 500; }
  .choice { display: flex; align-items: baseline; gap: var(--shimpz-space-2); margin: 0; overflow-wrap: anywhere; }
  .mark { color: var(--shimpz-color-accent); }
  .options { display: grid; gap: 2px; }
  .actions { display: flex; align-items: center; gap: var(--shimpz-space-2); }
  .error { margin: 0; color: var(--shimpz-color-danger); }
</style>
