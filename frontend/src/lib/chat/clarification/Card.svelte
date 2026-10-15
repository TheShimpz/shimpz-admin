<script>
  import { untrack } from 'svelte';

  import AnswerForm from '#lib/chat/clarification/AnswerForm.svelte';

  // A Brain multiple-choice question (ADR-0081). Answering sends the original request with the chosen answer;
  // once the exchange holds that answer, the card shows only the question and the answer.
  let { clarification, original, copy, answered = null, disabled = false, onanswer } = $props();

  // Each card starts on its own recommended default, or on nothing when it recommends none; a card never changes its
  // question.
  const recommended = untrack(() => clarification.default_index);

  // The recommended option leads the list and says so; the others keep their order. Each keeps its index as its value
  // and sends its own label.
  let options = $derived([
    ...(recommended === null ? [] : [recommended]),
    ...clarification.options.map((_, index) => index).filter((index) => index !== recommended),
  ].map((index) => {
    const option = clarification.options[index];
    return {
      value: String(index),
      label: index === recommended ? `${option.label} · ${copy.recommended}` : option.label,
      description: option.description,
      answer: option.label,
    };
  }));
</script>

{#if answered === null}
  <AnswerForm question={clarification.question} {options} initial={recommended === null ? '' : String(recommended)}
    {original} {copy} {disabled} {onanswer} />
{/if}
