<script>
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { fillRoutineCopy, humanizeId, literalWords, pointerWords } from '$lib/routine.js';

  // A Routine plan's safe projection (ADR-0092) in words: numbered steps naming the Assistant and its Action, each
  // input as a friendly key and value, references to an earlier step's result as a path, and the saved keys an Action
  // uses by name only. Every value is Team's escaped preview, rendered as text, never as Markdown or HTML.
  let { steps, copy, names = {} } = $props();

  const assistantName = (id) => names[id] ?? humanizeId(id);
  let positions = $derived(new Map(steps.map((step, index) => [step.id, index + 1])));

  function inputWords(input) {
    if (input.source === 'literal') return literalWords(input.value);
    if (input.source === 'run_clock') return fillRoutineCopy(copy.clock, { format: copy.clocks[input.value] });
    const n = positions.get(input.step);
    if (!input.pointer) return fillRoutineCopy(copy.fromStepWhole, { n });
    return fillRoutineCopy(copy.fromStep, { n, path: pointerWords(input.pointer, copy) });
  }
</script>

<ol class="plan" aria-label={copy.title}>
  {#each steps as step, index (step.id)}
    <li>
      <span class="number" aria-hidden="true">{index + 1}</span>
      <div class="step">
        <p class="action"><RoutineIcon name="step" /><span>{fillRoutineCopy(copy.step, { assistant: assistantName(step.assistant), action: humanizeId(step.action) }).replace(' · ', ' › ')}</span></p>
        {#if step.inputs.length > 0}
          <dl class="inputs">
            {#each step.inputs as input (input.member)}
              <div><dt>{humanizeId(input.member)}</dt><dd>{inputWords(input)}</dd></div>
            {/each}
          </dl>
        {/if}
        {#each step.stored_inputs as name (name)}
          <p class="stored"><RoutineIcon name="lock" />{fillRoutineCopy(copy.storedInput, { name })}</p>
        {/each}
      </div>
    </li>
  {/each}
</ol>

<style>
  /* Steps as a numbered column joined by a quiet rail; values in mono, saved keys behind a lock. */
  .plan { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; font-size: 0.8rem; line-height: 1.45; }
  li { position: relative; display: grid; grid-template-columns: 1.5rem minmax(0, 1fr); gap: 0.65rem; padding-block-end: var(--shimpz-space-3); }
  li:not(:last-child)::before { content: ""; position: absolute; inset-block: 1.6rem 0.2rem; inset-inline-start: 0.75rem; border-inline-start: 1px solid var(--shimpz-color-border); }
  .number { display: grid; width: 1.5rem; height: 1.5rem; place-items: center; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font: 600 0.68rem/1 var(--shimpz-font-mono); }
  .step { display: grid; gap: 0.3rem; min-width: 0; padding-block-start: 0.1rem; }
  .action { display: flex; align-items: center; gap: 0.4rem; margin: 0; color: var(--shimpz-color-text); font-weight: 600; overflow-wrap: break-word; }
  .action :global(.routine-icon) { width: 0.8rem; height: 0.8rem; color: var(--shimpz-color-text-dim); }
  :global([dir="rtl"]) .action :global(.routine-icon) { transform: scaleX(-1); }
  .inputs { display: grid; gap: 2px; margin: 0; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 0.5rem; }
  dt { color: var(--shimpz-color-text-dim); }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; font-family: var(--shimpz-font-mono); font-size: 0.76rem; overflow-wrap: anywhere; }
  .stored { display: flex; align-items: center; gap: 0.4rem; margin: 0; color: var(--shimpz-color-text-muted); }
  .stored :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
</style>
