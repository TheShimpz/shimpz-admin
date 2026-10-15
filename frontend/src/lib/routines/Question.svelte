<script>
  import AnswerForm from '#lib/chat/clarification/AnswerForm.svelte';
  import { questionWords } from '#lib/routines/words.js';

  // What Team asks before a recorded Routine can become a card (ADR-0101). The person's answer is an ordinary send,
  // composed with the original request as a clarification's answer is, and nothing is chosen for them: no option is
  // preselected or recommended. A target is sent as its exact JSON text, the only answer Team matches. Once the
  // exchange holds that answer, only the question and the answer remain.
  let { question, original, copy, clarifyCopy, answered = null, disabled = false, onanswer } = $props();

  let words = $derived(questionWords(question, copy.questions));
  let options = $derived(words.answers.map((option, index) => ({
    value: String(index),
    label: option.label,
    description: undefined,
    answer: option.text,
  })));
</script>

{#if answered === null}
  <AnswerForm question={words.question} {options} {original} copy={clarifyCopy} {disabled} {onanswer} />
{/if}
