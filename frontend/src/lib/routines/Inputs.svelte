<script>
  import { humanizeId } from '#lib/ids.js';

  // A step's inputs as one wrapping line of "Member: value" pairs, the value in its own mono face (ADR-0101). The
  // card and a Routine's plan list them alike; `words` puts one input's value in words for the view that holds it.
  let { inputs, words } = $props();
</script>

<dl class="inputs">
  {#each inputs as input (input.member)}
    <div><dt>{humanizeId(input.member)}</dt><dd>{words(input)}</dd></div>
  {/each}
</dl>

<style>
  .inputs { display: contents; }
  .inputs > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-inside); min-width: 0; }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.74rem; overflow-wrap: anywhere; }
</style>
