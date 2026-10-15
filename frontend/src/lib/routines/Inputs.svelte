<script>
  import { humanizeId } from '#lib/ids.js';
  import RoutineIcon from '#lib/routines/Icon.svelte';

  // A step's inputs as one wrapping line of "Member: value" pairs, the value in its own mono face (ADR-0101). The
  // card, a Routine's plan, and a run's steps list them alike; `words` puts one input's value in words for the view
  // that holds it. `locked` are the inputs whose value is never shown, such as a saved key: each a lock chip with its
  // `name`, and `label` saying what it is.
  let { inputs, words, locked = [] } = $props();
</script>

<dl class="inputs">
  {#each inputs as input (input.member)}
    <div><dt>{humanizeId(input.member)}</dt><dd>{words(input)}</dd></div>
  {/each}
</dl>
{#each locked as item (item.name)}
  <p class="locked" title={item.label}>
    <RoutineIcon name="lock" /><span class="sr-only">{item.label}</span><span aria-hidden="true">{item.name}</span>
  </p>
{/each}

<style>
  .inputs { display: contents; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-inside); min-width: 0; }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.74rem; overflow-wrap: anywhere; }
  .locked { display: inline-flex; align-items: center; gap: var(--gap-inside); margin: 0; font-family: var(--shimpz-font-mono); font-size: 0.74rem; }
  .locked :global(.routine-icon) { width: 0.75rem; height: 0.75rem; }
</style>
