<script>
  import { Button } from '@shimpz/frontend';

  import { fillRoutineCopy, outputScalarWords } from '$lib/routine.js';

  // One value of a Routine run's shown result as escaped text, read by its column's kind: an identifier in mono that
  // stays on one line and copies exactly the value Team projected, a number in tabular figures, a yes or no, a short
  // status word as a quiet badge, or plain text. A value Team hid or left out says so; one it cut short ends with
  // Team's own ellipsis and is never offered to copy as whole.
  let { node, kind = 'text', copy, resultCopy, locale, oncopy = null } = $props();

  let words = $derived(outputScalarWords(node, copy, locale));
  // Only a whole identifier is offered to copy; one Team cut short is never presented as complete.
  let copyable = $derived(kind === 'id' && node.kind === 'text' && !node.cut);

  async function copyValue() {
    let done = false;
    try {
      await navigator.clipboard.writeText(node.value);
      done = true;
    } catch {
      done = false;
    }
    oncopy?.(done);
  }
</script>

{#if node.kind === 'redacted'}
  <span class="blank redacted">{words}</span>
{:else if node.kind === 'null' || node.kind === 'elided'}
  <span class="blank">{words}</span>
{:else if copyable}
  <Button class="result-id" variant="ghost" size="xs" type="button" title={node.value}
    aria-label={fillRoutineCopy(resultCopy.copy, { value: node.value })} onclick={copyValue}>{node.value}</Button>
{:else if node.kind === 'bool'}
  <span class={['badge', node.value && 'badge--on']}>{words}</span>
{:else if kind === 'status' && node.kind === 'text'}
  <span class="badge">{words}</span>
{:else}
  <span class={['value', `value--${node.kind}`, kind === 'id' && 'value--id']}>{words}</span>
{/if}

<style>
  .value { overflow-wrap: break-word; }
  .value--number { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value--id { font: 0.78rem/1.4 var(--shimpz-font-mono); }
  .blank { color: var(--shimpz-color-text-dim); }
  .redacted { font: italic 0.78rem/1.4 var(--shimpz-font-mono); }
  /* An identifier keeps one line: the cell cuts it with an ellipsis, the hover title and a copy give the whole value. */
  :global(.shimpz-button.shimpz-button--ghost.result-id) {
    --button-color: var(--shimpz-color-text-muted);
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: transparent;
    display: block;
    max-width: var(--result-id-width, 16ch);
    min-height: 0;
    padding: 0;
    overflow: hidden;
    font: 400 0.78rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0;
    text-align: start;
    text-overflow: ellipsis;
    text-transform: none;
    white-space: nowrap;
    cursor: copy;
    clip-path: none;
  }
  :global(.shimpz-button.result-id:hover:not(:disabled)) { box-shadow: none; }
  :global(.shimpz-button.result-id .button-content) { display: inline; }
  /* A yes, a no, or a status word: one small outlined badge in mono capitals; a yes reads brighter than a no. */
  .badge {
    display: inline-block;
    padding: 0.05rem var(--gap-item); /* the block padding is the badge's own height, not rhythm */
    color: var(--shimpz-color-text-muted);
    border: 1px solid var(--shimpz-color-border);
    font: 600 0.62rem/1.5 var(--shimpz-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .badge--on { color: var(--shimpz-color-text); border-color: var(--shimpz-color-text-dim); }
  @media (forced-colors: active) { .badge { border-color: CanvasText; } }
</style>
