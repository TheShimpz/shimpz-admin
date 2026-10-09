<script>
  import RoutineOutput from '$lib/RoutineOutput.svelte';
  import RoutineResult from '$lib/RoutineResult.svelte';
  import RoutineResultTable from '$lib/RoutineResultTable.svelte';
  import RoutineResultValue from '$lib/RoutineResultValue.svelte';
  import { fillRoutineCopy, omittedWords } from '$lib/routine.js';

  // A run's shown result organized for reading (ADR-0092 amendment, 2026-10-05, output): its single values as one
  // compact summary strip, each small group of them under its own label, then each list as a table and each deeper
  // field set as a nested section. Every label and value is Team's projection, rendered as escaped text.
  let { view, copy, resultCopy, locale, level = 4, oncopy = null } = $props();

  let heading = $derived(`h${Math.min(level, 6)}`);

  function countWords(count) {
    const forms = resultCopy.items;
    return fillRoutineCopy(new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other, {
      count: new Intl.NumberFormat(locale).format(count),
    });
  }
</script>

{#if view.summary.length}
  <div class="summary">
    {#each view.summary as group, index (index)}
      <div class="group">
        {#if group.label}<div class="group-label">{group.label}</div>{/if}
        <dl>
          {#each group.items as item, position (position)}
            <div class="stat">
              <dt>{item.label}</dt>
              <dd><RoutineResultValue node={item.node} kind={item.kind} {copy} {resultCopy} {locale} {oncopy} /></dd>
            </div>
          {/each}
        </dl>
      </div>
    {/each}
  </div>
{/if}

{#each view.blocks as block, index (index)}
  <section class="block">
    {#if block.label}
      <svelte:element this={heading} class="block-label">
        {block.label}
        {#if block.kind === 'table'}<span class="count">{countWords(block.table.rows.length + block.omitted)}</span>{/if}
      </svelte:element>
    {/if}
    {#if block.kind === 'table'}
      <RoutineResultTable table={block.table} label={block.label || resultCopy.response} {copy} {resultCopy} {locale} {oncopy} />
    {:else if block.kind === 'values'}
      <div class="values">
        {#each block.items as item, position (position)}
          <RoutineResultValue node={item} {copy} {resultCopy} {locale} {oncopy} />
        {/each}
        {#if block.items.length === 0 && !block.omitted}<span class="dim">{copy.empty}</span>{/if}
      </div>
      {#if block.omitted}<div class="dim">{omittedWords(copy, block.omitted, locale)}</div>{/if}
    {:else if block.kind === 'view'}
      <div class="nested"><RoutineResult view={block.view} {copy} {resultCopy} {locale} level={level + 1} {oncopy} /></div>
    {:else if block.kind === 'value'}
      <div class="single"><RoutineResultValue node={block.node} {copy} {resultCopy} {locale} {oncopy} /></div>
    {:else}
      <div class="plain"><RoutineOutput node={block.node} {copy} {locale} /></div>
    {/if}
  </section>
{/each}
{#if view.omitted}<div class="dim">{omittedWords(copy, view.omitted, locale)}</div>{/if}
<!-- A field set with nothing in it, and nothing left out, says so instead of showing nothing. -->
{#if !view.summary.length && !view.blocks.length && !view.omitted}<div class="dim">{copy.empty}</div>{/if}

<style>
  /* Single values as one strip of small mono labels over their values; a named group sits apart by a hairline. */
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-group) var(--gap-panel);
    padding: var(--gap-item) var(--gap-group);
    border: 1px solid var(--shimpz-color-border-subtle);
    background: rgb(255 255 255 / 0.015);
  }
  .group { display: grid; gap: var(--gap-item); min-width: 0; }
  .group + .group { padding-inline-start: var(--gap-panel); border-inline-start: 1px solid var(--shimpz-color-border-subtle); }
  .group-label, dt, .block-label {
    margin: 0;
    color: var(--shimpz-color-text-dim);
    font: 600 0.62rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .group-label { color: var(--shimpz-color-text-muted); }
  dl { display: flex; flex-wrap: wrap; gap: var(--gap-item) var(--gap-group); margin: 0; }
  .stat { display: grid; gap: var(--gap-inside); min-width: 0; }
  dd { margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; }
  .block { display: grid; gap: var(--gap-item); min-width: 0; }
  .block-label { display: flex; align-items: baseline; gap: var(--gap-item); color: var(--shimpz-color-text-muted); font-size: 0.68rem; }
  .count { color: var(--shimpz-color-text-dim); font-weight: 400; letter-spacing: 0.04em; text-transform: none; }
  .values { display: flex; flex-wrap: wrap; gap: var(--gap-inside) var(--gap-item); margin: 0; font-size: 0.85rem; }
  .nested { display: grid; gap: var(--gap-group); padding-inline-start: var(--gap-group); border-inline-start: 1px solid var(--shimpz-color-border-subtle); }
  .single { margin: 0; font-size: 0.9rem; }
  .plain { font-size: 0.82rem; line-height: 1.45; }
  .dim { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  @media (max-width: 600px) {
    .group + .group { padding-inline-start: 0; border-inline-start: 0; }
  }
</style>
