<script>
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
  {#each steps as step (step.id)}
    <li>
      <span class="step">{fillRoutineCopy(copy.step, { assistant: assistantName(step.assistant), action: humanizeId(step.action) })}</span>
      {#if step.inputs.length > 0}
        <dl class="inputs">
          {#each step.inputs as input (input.member)}
            <div><dt>{humanizeId(input.member)}</dt><dd>{inputWords(input)}</dd></div>
          {/each}
        </dl>
      {/if}
      {#each step.stored_inputs as name (name)}
        <p class="stored">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
          {fillRoutineCopy(copy.storedInput, { name })}
        </p>
      {/each}
    </li>
  {/each}
</ol>

<style>
  .plan { display: grid; gap: var(--shimpz-space-2); margin: 0; padding-inline-start: 1.4em; font-size: 0.8rem; line-height: 1.45; }
  .plan > li::marker { color: var(--shimpz-color-cyan); font-family: var(--shimpz-font-mono); }
  .step { font-weight: 600; overflow-wrap: break-word; }
  .inputs { display: grid; gap: 2px; margin: var(--shimpz-space-1) 0 0; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 var(--shimpz-space-2); }
  dt { color: var(--shimpz-color-text-muted); }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; overflow-wrap: break-word; }
  .stored { display: flex; align-items: center; gap: var(--shimpz-space-1); margin: var(--shimpz-space-1) 0 0; color: var(--shimpz-color-text-muted); }
  .stored svg { flex: none; width: 0.85rem; height: 0.85rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
</style>
