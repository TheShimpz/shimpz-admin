<script>
  import { fillRoutineCopy } from '$lib/routine.js';

  // A Routine plan's safe projection (ADR-0092): each step's Action, every input's source, and the Stored Inputs its
  // Action uses by name only. Every value is Team's escaped preview, rendered as text, never as Markdown or HTML.
  let { steps, copy } = $props();
</script>

<ol class="plan" aria-label={copy.title}>
  {#each steps as step (step.id)}
    <li>
      <span><code>{step.assistant}</code> · <code>{step.action}</code></span>
      {#if step.inputs.length > 0}
        <ul class="inputs">
          {#each step.inputs as input (input.member)}
            <li>
              <code>{input.member}</code>:
              {#if input.source === 'literal'}
                <code>{input.value}</code>
              {:else if input.source === 'run_clock'}
                {fillRoutineCopy(copy.clock, { format: input.value })}
              {:else}
                {fillRoutineCopy(copy.fromStep, { step: input.step, pointer: input.pointer || '/' })}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if step.stored_inputs.length > 0}
        <p class="stored">{fillRoutineCopy(copy.storedInputs, { names: step.stored_inputs.join(', ') })}</p>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .plan { display: grid; gap: 2px; margin: 0; padding-inline-start: 1.2em; font-size: 0.72rem; line-height: 1.4; overflow-wrap: anywhere; }
  .inputs { margin: 0; padding-inline-start: 1em; list-style: none; color: var(--shimpz-color-text-dim); }
  .stored { margin: 0; color: var(--shimpz-color-text-dim); }
</style>
