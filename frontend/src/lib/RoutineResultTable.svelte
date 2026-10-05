<script>
  import RoutineOutput from '$lib/RoutineOutput.svelte';
  import RoutineResultValue from '$lib/RoutineResultValue.svelte';
  import { omittedWords } from '$lib/routine.js';
  import { isScalar } from '$lib/routineResult.js';

  // A list of a run's shown result as the Admin's data table: mono column headings over zebra rows in one bordered
  // region that scrolls on its own, with its headings kept in view. Each cell reads by its column's kind; a list of
  // single values reads inline, and anything deeper falls back to plain nested rows. Every value is escaped text.
  let { table, label, copy, resultCopy, locale, oncopy = null } = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling for wide or long tables) -->
<div class="table-scroll" role="region" aria-label={label} tabindex="0">
  <table>
    <thead>
      <tr>
        {#each table.columns as column, index (index)}
          <th scope="col" class={`kind-${column.kind}`}>{column.label}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each table.rows as row, index (index)}
        <tr>
          {#each row as cell, column (column)}
            <td class={`kind-${table.columns[column].kind}`}>
              {#if cell === null}
                <span class="blank">—</span>
              {:else if isScalar(cell)}
                <RoutineResultValue node={cell} kind={table.columns[column].kind} {copy} {resultCopy} {locale} {oncopy} />
              {:else if cell.kind === 'list' && cell.items.every(isScalar)}
                <span class="inline">
                  {#each cell.items as item, position (position)}
                    <RoutineResultValue node={item} {copy} {resultCopy} {locale} {oncopy} />
                  {/each}
                  {#if cell.omitted}<span class="blank">{omittedWords(copy, cell.omitted, locale)}</span>{/if}
                  {#if cell.items.length === 0 && !cell.omitted}<span class="blank">{copy.empty}</span>{/if}
                </span>
              {:else}
                <div class="nested"><RoutineOutput node={cell} {copy} {locale} depth={1} /></div>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
{#if table.omitted}<div class="more">{omittedWords(copy, table.omitted, locale)}</div>{/if}

<style>
  /* The chat's data table: one strong border, cyan mono capitals on a faint tint, hairline cells, zebra rows. */
  .table-scroll {
    max-width: 100%;
    max-height: min(70dvh, 44rem);
    overflow: auto;
    border: 1px solid var(--shimpz-color-border);
  }
  .table-scroll:focus-visible { outline: 2px solid var(--shimpz-color-cyan); outline-offset: 2px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.82rem; line-height: 1.45; }
  th, td {
    padding: 0.5rem 0.75rem;
    text-align: start;
    vertical-align: top;
    border-inline-end: 1px solid var(--shimpz-color-border-subtle);
    border-block-end: 1px solid var(--shimpz-color-border-subtle);
  }
  th:last-child, td:last-child { border-inline-end: 0; }
  tbody tr:last-child td { border-block-end: 0; }
  th {
    position: sticky;
    inset-block-start: 0;
    z-index: 1;
    color: var(--shimpz-color-cyan);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 7%, var(--shimpz-color-surface));
    font: 600 0.66rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  td { min-width: 8ch; color: var(--shimpz-color-text); }
  tbody tr:nth-child(even) { background: rgb(255 255 255 / 0.025); }
  tbody tr:hover { background: color-mix(in srgb, var(--shimpz-color-cyan) 4%, transparent); }
  .kind-number { text-align: end; }
  td.kind-bool, td.kind-status, td.kind-number { min-width: 0; white-space: nowrap; }
  .inline { display: inline-flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; }
  .blank, .more { color: var(--shimpz-color-text-dim); }
  .more { margin: 0.4rem 0 0; font-size: 0.75rem; }
  .nested { font-size: 0.78rem; }
  @media (forced-colors: active) { .table-scroll { border-color: CanvasText; } }
</style>
