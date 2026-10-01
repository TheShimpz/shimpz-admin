<script>
  import { tick, untrack } from 'svelte';
  import { Button, RadioField, TextField } from '@shimpz/frontend';

  import { composeClarifiedRequest } from '$lib/clarification.js';

  // A Brain multiple-choice question (ADR-0081). Answering sends the original request with the chosen answer;
  // once the exchange holds that answer, the card shows only the question and the answer.
  let { clarification, original, copy, answered = null, disabled = false, onanswer } = $props();

  const id = $props.id();
  const OTHER = 'other';
  // Each card starts on its own recommended default; a card never changes its question.
  let choice = $state(untrack(() => String(clarification.default_index)));
  let custom = $state('');
  let error = $state('');

  // The recommended option always leads the list; each option keeps its own index as its value.
  let ordered = $derived([
    clarification.default_index,
    ...clarification.options.map((_, index) => index).filter((index) => index !== clarification.default_index),
  ].map((index) => ({ index, option: clarification.options[index] })));

  let answer = $derived(choice === OTHER ? custom : clarification.options[Number(choice)]?.label ?? '');
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

{#if answered !== null}
  <div class="clarification answered">
    <p class="question">{clarification.question}</p>
    <p class="choice"><span class="mark" aria-hidden="true">✓</span><span class="sr-only">{copy.answered}: </span>{answered}</p>
  </div>
{:else}
  <form class="clarification" aria-labelledby={`${id}-question`} onsubmit={submit}>
    <p class="question" id={`${id}-question`}>{clarification.question}</p>
    <div class="options" role="radiogroup" aria-labelledby={`${id}-question`}>
      {#each ordered as { index, option } (option.label)}
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
      <Button class="answer glitch-host" type="submit" size="sm" disabled={disabled || !ready}>
        <span class="glitch-text">{copy.use}</span>
        <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17 4 12l5-5"></path><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
      </Button>
    </div>
  </form>
{/if}

<style>
  .clarification { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-1); }
  .question { margin: 0; color: var(--shimpz-color-text); font-weight: 600; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .answered .question { color: var(--shimpz-color-text-muted); font-weight: 500; }
  .choice {
    display: flex;
    align-items: baseline;
    gap: var(--shimpz-space-2);
    margin: 0;
    color: var(--shimpz-color-text);
    font-family: var(--shimpz-font-mono, ui-monospace, monospace);
    font-size: 0.88rem;
    overflow-wrap: anywhere;
  }
  .mark { color: var(--shimpz-color-accent); }
  .options { display: grid; gap: 2px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--shimpz-space-2); }
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
  .actions :global(.answer) { display: inline-flex; align-items: center; gap: 0.45rem; }
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
