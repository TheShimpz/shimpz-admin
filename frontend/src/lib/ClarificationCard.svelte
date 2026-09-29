<script>
  import { untrack } from 'svelte';
  import { Button, RadioField, TextField } from '@shimpz/frontend';

  import { composeClarifiedRequest } from '$lib/clarification.js';

  // A Brain multiple-choice question (ADR-0081). Answering only fills the composer; nothing is sent from here.
  let { clarification, original, copy, disabled = false, onuse } = $props();

  const id = $props.id();
  const OTHER = 'other';
  // Each card starts on its own recommended default; a card never changes its question.
  let choice = $state(untrack(() => String(clarification.default_index)));
  let custom = $state('');
  let error = $state('');

  let answer = $derived(choice === OTHER ? custom : clarification.options[Number(choice)]?.label ?? '');

  function use(event) {
    event.preventDefault();
    const composed = composeClarifiedRequest(original, clarification.question, answer, {
      question: copy.questionLabel,
      answer: copy.answerLabel,
    });
    if (composed === null) {
      error = answer.trim() ? copy.tooLong : copy.empty;
      return;
    }
    error = '';
    onuse(composed);
  }
</script>

<form class="clarification" aria-labelledby={`${id}-question`} onsubmit={use}>
  <p class="question" id={`${id}-question`}>{clarification.question}</p>
  <div class="options" role="radiogroup" aria-labelledby={`${id}-question`}>
    {#each clarification.options as option, index (option.label)}
      <RadioField
        id={`${id}-option-${index}`}
        name={`${id}-choice`}
        label={index === clarification.default_index ? `${option.label} · ${copy.recommended}` : option.label}
        description={option.description}
        optionValue={String(index)}
        bind:value={choice}
        {disabled}
      />
    {/each}
    <RadioField
      id={`${id}-option-other`}
      name={`${id}-choice`}
      label={copy.other}
      optionValue={OTHER}
      bind:value={choice}
      {disabled}
    />
  </div>
  {#if choice === OTHER}
    <TextField
      id={`${id}-custom`}
      label={copy.other}
      visuallyHiddenLabel
      placeholder={copy.otherPlaceholder}
      bind:value={custom}
      maxlength="4000"
      {disabled}
    />
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <div class="actions">
    <Button type="submit" size="sm" {disabled}>{copy.use}</Button>
    <p class="hint">{copy.hint}</p>
  </div>
</form>

<style>
  .clarification { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-1); }
  .question { margin: 0; color: var(--shimpz-color-text); font-weight: 600; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .options { display: grid; gap: 2px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--shimpz-space-2); }
  .hint, .error { margin: 0; font-size: 0.78rem; line-height: 1.4; }
  .hint { color: var(--shimpz-color-text-muted); }
  .error { color: var(--shimpz-color-danger); }
</style>
