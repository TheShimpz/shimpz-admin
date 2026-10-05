<script>
  import RoutineOutput from '$lib/RoutineOutput.svelte';
  import { omittedWords, outputLabels, outputScalarWords, outputTable } from '$lib/routine.js';

  // One node of a Routine run's shown result (ADR-0092 amendment, 2026-10-05, output): Team's bounded, redacted
  // projection of an Action's validated result, never a model's summary. Every label and value is plain text, never
  // Markdown or HTML. A list of field sets reads as a table, other field sets as label and value rows, other lists as
  // a list; what Team left out reads as how many more.
  let { node, copy, locale, depth = 0 } = $props();

  let table = $derived(outputTable(node));
  let headers = $derived(table ? outputLabels(table.columns) : []);
  let labels = $derived(node.kind === 'fields' ? outputLabels(node.fields.map(([label]) => label)) : []);
  let more = $derived(node.omitted ? omittedWords(copy, node.omitted, locale) : '');
</script>

{#if table}
  <div class="table">
    <table>
      <thead>
        <tr>{#each headers as header, index (index)}<th scope="col">{header}</th>{/each}</tr>
      </thead>
      <tbody>
        {#each table.rows as row, index (index)}
          <tr>
            {#each row as cell, column (column)}
              <td>{#if cell}<RoutineOutput node={cell} {copy} {locale} depth={depth + 1} />{/if}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if more}<div class="more">{more}</div>{/if}
{:else if node.kind === 'list'}
  {#if node.items.length}
    <ul class="items">
      {#each node.items as item, index (index)}
        <li><RoutineOutput node={item} {copy} {locale} depth={depth + 1} /></li>
      {/each}
    </ul>
  {:else if !more}
    <span class="empty">{copy.empty}</span>
  {/if}
  {#if more}<div class="more">{more}</div>{/if}
{:else if node.kind === 'fields'}
  {#if node.fields.length}
    <dl class="fields">
      {#each node.fields as [label, value], index (label)}
        <div><dt>{labels[index]}</dt><dd><RoutineOutput node={value} {copy} {locale} depth={depth + 1} /></dd></div>
      {/each}
    </dl>
  {:else if !more}
    <span class="empty">{copy.empty}</span>
  {/if}
  {#if more}<div class="more">{more}</div>{/if}
{:else}
  <span class={['scalar', `kind-${node.kind}`]}>{outputScalarWords(node, copy, locale)}</span>
{/if}

<style>
  /* Plain data in quiet type: a compact table, label and value rows, or a list, wrapping long values. */
  .table { max-width: 100%; overflow-x: auto; }
  table { border-collapse: collapse; font-size: 0.8rem; }
  th, td { padding: 0.2rem 0.75rem 0.2rem 0; text-align: start; vertical-align: top; overflow-wrap: anywhere; }
  th { color: var(--shimpz-color-text-dim); font-weight: 500; white-space: nowrap; }
  td { color: var(--shimpz-color-text); }
  .items { margin: 0; padding-inline-start: 1.1rem; }
  .fields { display: grid; gap: 0.1rem; margin: 0; }
  .fields > div { display: flex; flex-wrap: wrap; gap: 0 0.4rem; min-width: 0; }
  dt { color: var(--shimpz-color-text-dim); }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); overflow-wrap: anywhere; }
  .more, .empty { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.78rem; }
  .kind-redacted, .kind-elided, .kind-null { color: var(--shimpz-color-text-dim); }
</style>
