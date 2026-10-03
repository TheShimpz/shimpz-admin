<script>
  import { identifierName } from '$lib/attachments.js';
  import { t } from '$lib/i18n.js';

  // A neutral note under a reply whose message carried readable attachments: which Actions Team withheld, by their
  // Assistant and Action names, and the attachment-free way to use them. It offers nothing to run (ADR-0093).
  let { restricted, assistantNames = new Map() } = $props();

  let copy = $derived($t('attachments.restricted'));
  let hidden = $derived(restricted.total - restricted.actions.length);
</script>

<div class="restricted-actions" role="note" aria-label={copy.title}>
  <p>{copy.lead}</p>
  <ul>
    {#each restricted.actions as item (`${item.assistant}\u0000${item.action}`)}
      <li>
        {$t('attachments.restricted.item', {
          assistant: assistantNames.get(item.assistant) ?? identifierName(item.assistant),
          action: identifierName(item.action),
        })}
      </li>
    {/each}
    {#if hidden > 0}
      <li>{$t('attachments.restricted.more', { count: String(hidden) })}</li>
    {/if}
  </ul>
  <p>{copy.next}</p>
</div>

<style>
  .restricted-actions {
    display: grid;
    gap: 0.3rem;
    max-width: 62ch;
    margin-block-start: 0.6rem;
    padding: 0.55rem 0.7rem;
    border-inline-start: 2px solid var(--shimpz-color-border);
    color: var(--shimpz-color-text-muted);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  p { margin: 0; }

  ul {
    display: grid;
    gap: 0.1rem;
    margin: 0;
    padding-inline-start: 1.1rem;
    color: var(--shimpz-color-text);
  }
</style>
