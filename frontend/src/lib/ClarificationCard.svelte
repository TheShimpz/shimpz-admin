<script>
  import { tick, untrack } from 'svelte';
  import { Button, RadioField, TextField } from '@shimpz/frontend';

  import { composeClarifiedRequest } from '$lib/clarification.js';

  // A Brain multiple-choice question (ADR-0081). Answering sends the original request with the chosen answer;
  // once the exchange holds that answer, the card shows only the question and the answer.
  let { clarification, original, copy, answered = null, disabled = false, onanswer } = $props();

  const id = $props.id();
  const OTHER = 'other';
  // Each card starts on its own recommended default, or on nothing when it recommends none; a card never changes its
  // question.
  const recommended = untrack(() => clarification.default_index);
  let choice = $state(recommended === null ? '' : String(recommended));
  let custom = $state('');
  let error = $state('');

  // The recommended option leads the list; the others keep their order. Each keeps its index as its value.
  let ordered = $derived([
    ...(recommended === null ? [] : [recommended]),
    ...clarification.options.map((_, index) => index).filter((index) => index !== recommended),
  ].map((index) => ({ index, option: clarification.options[index] })));

  let answer = $derived(
    choice === OTHER ? custom : choice === '' ? '' : clarification.options[Number(choice)]?.label ?? '',
  );
  // A chosen option is always an answer; a custom answer needs text before it can be sent.
  let ready = $derived(answer.trim().length > 0);

  // Choosing "other" puts the caret straight into its answer field.
  async function chooseOther() {
    if (choice !== OTHER) return;
    await tick();
    document.getElementById(`${id}-custom`)?.focus();
  }

  function submit(event) {
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
    onanswer({ composed, answer: answer.trim() });
  }
</script>

{#if answered === null}
  <form class="clarification" aria-labelledby={`${id}-question`} onsubmit={submit}>
    <p class="question" id={`${id}-question`}>{clarification.question}</p>
    <div class="options" role="radiogroup" aria-labelledby={`${id}-question`}>
      {#each ordered as { index, option } (option.label)}
        <RadioField
          id={`${id}-option-${index}`}
          name={`${id}-choice`}
          label={index === recommended ? `${option.label} · ${copy.recommended}` : option.label}
          description={option.description}
          optionValue={String(index)}
          bind:value={choice}
          {disabled}
        />
      {/each}
      <div class="other" class:chosen={choice === OTHER}>
        <RadioField
          id={`${id}-option-other`}
          name={`${id}-choice`}
          label={copy.other}
          description={copy.otherDescription}
          optionValue={OTHER}
          bind:value={choice}
          onchange={chooseOther}
          {disabled}
        />
        {#if choice === OTHER}
          <div class="other-entry">
            <TextField
              id={`${id}-custom`}
              label={copy.other}
              visuallyHiddenLabel
              placeholder={copy.otherPlaceholder}
              bind:value={custom}
              maxlength="4000"
              {disabled}
            />
          </div>
        {/if}
      </div>
    </div>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="actions">
      <Button class="answer" type="submit" size="sm" disabled={disabled || !ready}>
        {copy.use}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17 4 12l5-5"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
      </Button>
    </div>
  </form>
{/if}

<style>
  .clarification { display: grid; gap: var(--gap-item); margin-block-start: var(--gap-inside); }
  .question { margin: 0; color: var(--shimpz-color-text); font-weight: 600; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .options { display: grid; gap: 2px; } /* a seam between the bordered option tiles, not rhythm */
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap-group); }
  /* "Other" is one card: its option, then its answer field aligned under the description. */
  .other {
    background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border-subtle);
    transition: border-color var(--shimpz-duration-fast) var(--shimpz-ease), background var(--shimpz-duration-fast) var(--shimpz-ease);
  }
  /* The whole card answers hover like every other option, selected or not; its option row never paints its own. */
  .other:hover:not(:has(input:disabled)) {
    background: color-mix(in srgb, var(--shimpz-color-cyan) 6%, var(--shimpz-color-surface-raised));
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 55%, var(--shimpz-color-border));
  }
  .other.chosen { border-color: color-mix(in srgb, var(--shimpz-color-cyan) 35%, var(--shimpz-color-border)); }
  .other :global(.shimpz-radio-field),
  .other :global(.shimpz-radio-field:hover) { background: transparent; border-color: transparent; }
  /* Once chosen, the field sits exactly on the description's line, so the card never changes height. */
  .other { position: relative; }
  .other.chosen :global(.shimpz-radio-field small) { visibility: hidden; }
  /* Not rhythm: these offsets mirror the shared radio field's own padding and mark, so the field lands on its
     description line. */
  .other-entry {
    position: absolute;
    inset-inline: calc(1.125rem + 2 * var(--shimpz-space-3) + 1px) calc(var(--shimpz-space-3) + 1px);
    inset-block-end: calc(0.65rem + 1px);
  }
  /* Inside the card the field is bare text at the card's own scale; the card frame already shows the focus. */
  .other .other-entry :global(.shimpz-field input),
  .other .other-entry :global(.shimpz-field input:focus) {
    width: 100%;
    height: calc(0.7rem * 1.4);
    min-height: 0;
    padding: 0;
    color: var(--shimpz-color-text);
    font: 500 0.76rem/calc(0.7rem * 1.4) var(--shimpz-font-sans);
    background: transparent;
    border: 0;
    clip-path: none;
    box-shadow: none;
    outline: none;
  }
  .other-entry :global(.shimpz-field input::placeholder) {
    color: var(--shimpz-color-text-dim);
    font: 500 0.7rem/1.4 var(--shimpz-font-sans);
  }
  .actions :global(.answer) { display: inline-flex; align-items: center; gap: var(--gap-inside); }
  .actions :global(.answer svg) {
    width: 0.95rem;
    height: 0.95rem;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.75;
  }
  .error { margin: 0; font-size: 0.78rem; line-height: 1.4; color: var(--shimpz-color-danger); }
</style>
