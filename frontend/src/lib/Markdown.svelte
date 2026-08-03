<script>
  import MarkdownInline from '$lib/MarkdownInline.svelte';
  import { parseMarkdown } from '$lib/markdown.js';

  let { markdown = '', variant = 'body' } = $props();
  let blocks = $derived(parseMarkdown(markdown));

  function tableLabel(block) {
    return block.header.map((cell) => cell.map((token) => token.text).join('')).join(', ');
  }
</script>

<div class="markdown" class:chat={variant === 'chat'}>
  {#each blocks as block}
    {#if block.type === 'heading' && block.level === 1}
      <h1><MarkdownInline tokens={block.inlines} /></h1>
    {:else if block.type === 'heading' && block.level === 2}
      <h2><MarkdownInline tokens={block.inlines} /></h2>
    {:else if block.type === 'heading'}
      <h3><MarkdownInline tokens={block.inlines} /></h3>
    {:else if block.type === 'code'}
      <pre><code>{block.text}</code></pre>
    {:else if block.type === 'list' && block.ordered}
      <ol>{#each block.items as item}<li><MarkdownInline tokens={item} /></li>{/each}</ol>
    {:else if block.type === 'list'}
      <ul>{#each block.items as item}<li><MarkdownInline tokens={item} /></li>{/each}</ul>
    {:else if block.type === 'table'}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling for wide tables) -->
      <div class="table-scroll" role="region" aria-label={tableLabel(block)} tabindex="0">
        <table>
          <thead>
            <tr>
              {#each block.header as cell, index}
                <th class:align-center={block.align[index] === 'center'} class:align-right={block.align[index] === 'right'}>
                  <MarkdownInline tokens={cell} />
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row}
              <tr>
                {#each row as cell, index}
                  <td class:align-center={block.align[index] === 'center'} class:align-right={block.align[index] === 'right'}>
                    <MarkdownInline tokens={cell} />
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p><MarkdownInline tokens={block.inlines} /></p>
    {/if}
  {/each}
</div>

<style>
  .markdown { color: var(--text-dim); font-size: 0.76rem; line-height: 1.62; }
  .markdown.chat { color: var(--text); font-size: inherit; line-height: 1.55; }
  h1, h2, h3 { margin: 1.2rem 0 0.55rem; color: var(--text); line-height: 1.22; }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  h1 { font-size: 1.15rem; }
  h2 { font-size: 0.92rem; }
  h3 { font-size: 0.8rem; }
  p, ul, ol, .table-scroll { margin: 0.55rem 0; }
  .chat > :first-child { margin-top: 0; }
  .chat > :last-child { margin-bottom: 0; }
  ul, ol { padding-inline-start: 1.3rem; }
  li + li { margin-top: 0.28rem; }
  pre { overflow-x: auto; margin: 0.75rem 0; border: 1px solid var(--border-strong); padding: 0.75rem; background: #030506; }
  code { color: var(--accent); font-family: var(--font-mono); font-size: 0.9em; }
  .table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--border-strong); }
  .table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  table { width: 100%; min-width: max-content; border-collapse: collapse; font-size: 0.9em; }
  th, td { padding: 0.55rem 0.7rem; border-inline-end: 1px solid var(--border); border-block-end: 1px solid var(--border); text-align: start; vertical-align: top; }
  th:last-child, td:last-child { border-inline-end: 0; }
  tbody tr:last-child td { border-block-end: 0; }
  th { color: var(--accent); background: rgb(0 229 255 / 0.07); font-family: var(--font-mono); font-size: 0.82em; letter-spacing: 0.05em; text-transform: uppercase; }
  tbody tr:nth-child(even) { background: rgb(255 255 255 / 0.025); }
  .align-center { text-align: center; }
  .align-right { text-align: end; }
  .markdown :global(a) { color: var(--accent); text-decoration: underline; text-decoration-color: var(--accent-alt); text-underline-offset: 0.2em; }
  .markdown :global(a:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
