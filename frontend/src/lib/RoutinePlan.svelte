<script>
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { dispositionWords, fillRoutineCopy, humanizeId, literalWords, pointerWords } from '$lib/routine.js';

  // A Routine plan's safe projection (ADR-0092) in words: numbered steps naming the Assistant and its Action, each
  // input as a friendly key and value, references to an earlier step's result as a path, and the saved keys an Action
  // uses by name only, then what each run does with its result. Every value is Team's escaped preview, rendered as
  // text, never as Markdown or HTML.
  let { steps, copy, names = {}, output = null } = $props();

  const assistantName = (id) => names[id] ?? humanizeId(id);
  let positions = $derived(new Map(steps.map((step, index) => [step.id, index + 1])));

  function inputWords(input) {
    if (input.source === 'literal') return literalWords(input.value);
    if (input.source === 'run_clock') return fillRoutineCopy(copy.clock, { format: copy.clocks[input.value] });
    const n = positions.get(input.step);
    const text = input.source === 'step_text';
    if (!input.pointer) return fillRoutineCopy(text ? copy.fromStepTextWhole : copy.fromStepWhole, { n });
    return fillRoutineCopy(text ? copy.fromStepText : copy.fromStep, { n, path: pointerWords(input.pointer, copy) });
  }
</script>

<ol class="plan" aria-label={copy.title}>
  {#each steps as step, index (step.id)}
    <li>
      <span class="number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
      <div class="step">
        <p class="head">
          <span class="action">{humanizeId(step.action)}</span>
          <span class="assistant">{assistantName(step.assistant)}</span>
        </p>
        {#if step.inputs.length > 0 || step.stored_inputs.length > 0}
          <div class="meta">
            {#if step.inputs.length > 0}
              <dl class="inputs">
                {#each step.inputs as input (input.member)}
                  <div><dt>{humanizeId(input.member)}</dt><dd>{inputWords(input)}</dd></div>
                {/each}
              </dl>
            {/if}
            {#each step.stored_inputs as name (name)}
              <p class="stored" title={fillRoutineCopy(copy.storedInput, { name })}>
                <RoutineIcon name="lock" /><span class="sr-only">{fillRoutineCopy(copy.storedInput, { name })}</span><span aria-hidden="true">{name}</span>
              </p>
            {/each}
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
{#if output}<p class="disposition">{dispositionWords(output, steps, copy)}</p>{/if}

<style>
  /* Steps as plain rows without rules: a mono number, the Action with its Assistant beside it, and one quiet line of what it uses. */
  .plan { display: grid; margin: 0; padding: 0; list-style: none; font-size: 0.82rem; line-height: 1.45; }
  li { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr); gap: var(--shimpz-space-2); padding-block: 0.5rem; }
  li:first-child { padding-block-start: 0; }
  .number { color: var(--shimpz-color-cyan); font: 600 0.72rem/1.6 var(--shimpz-font-mono); }
  .step { display: grid; gap: 0.25rem; min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.1rem 0.6rem; margin: 0; }
  .action { color: var(--shimpz-color-text); font-weight: 600; overflow-wrap: anywhere; }
  .assistant { color: var(--shimpz-color-text-dim); font-size: 0.74rem; }
  .meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.15rem 1rem; color: var(--shimpz-color-text-muted); font-size: 0.76rem; }
  .inputs { display: contents; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 0.4rem; min-width: 0; }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.74rem; overflow-wrap: anywhere; }
  .stored { display: inline-flex; align-items: center; gap: 0.3rem; margin: 0; font-family: var(--shimpz-font-mono); font-size: 0.74rem; }
  .stored :global(.routine-icon) { width: 0.75rem; height: 0.75rem; }
  .disposition { margin: 0.25rem 0 0; color: var(--shimpz-color-text-muted); font-size: 0.78rem; }
</style>
