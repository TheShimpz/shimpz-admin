<script>
  import { Button } from '@shimpz/frontend';
  import { formatFileSize } from '$lib/attachments.js';
  import { locale, t } from '$lib/i18n.js';

  // One file as a quiet chip: a type mark, its literal name, then its type, size, and what Team reads of it. In the
  // composer it may still be uploading and can be removed from the message; in the transcript it is only a record.
  let {
    name,
    size,
    kind = 'file',
    note = '',
    state = 'ready',
    sent = false,
    onremove = null,
  } = $props();

  let copy = $derived($t('attachments'));
  let noteText = $derived(
    note === 'pdf-text' ? copy.pdfText : note === 'unreadable' ? (sent ? copy.notRead : copy.willNotRead) : '',
  );
  let stateText = $derived(state === 'queued' ? copy.queued : state === 'uploading' ? copy.sending : '');
  let details = $derived(
    [copy.kinds[kind] ?? copy.kinds.file, formatFileSize(size, $locale), noteText, stateText].filter(Boolean).join(' · '),
  );
</script>

<li class="attachment-chip" data-kind={kind} aria-busy={state === 'ready' ? undefined : 'true'}>
  <svg class="attachment-mark" viewBox="0 0 24 24" aria-hidden="true">
    {#if kind === 'image'}
      <path d="M4.5 5.5h15v13h-15zM4.5 15.5l4.5-4.5 4 4 2.5-2.5 4 4"></path><circle cx="15.5" cy="9.5" r="1.4"></circle>
    {:else if kind === 'pdf'}
      <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 13h6M9.5 16.5h4"></path>
    {:else if kind === 'text'}
      <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 11.5h6M9.5 14.5h6M9.5 17.5h3.5"></path>
    {:else}
      <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4"></path>
    {/if}
  </svg>
  <span class="attachment-text">
    <span class="attachment-name" title={name}>{name}</span>
    <span class="attachment-details">{details}</span>
  </span>
  {#if onremove}
    <Button
      class="attachment-remove"
      variant="ghost"
      size="icon"
      type="button"
      onclick={onremove}
      title={copy.remove}
      aria-label={$t('attachments.removeNamed', { name })}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
    </Button>
  {/if}
</li>

<style>
  .attachment-chip {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--gap-item);
    min-width: 0;
    max-width: 100%;
    /* The remove button brings its own hit area, so the end side needs less. */
    padding: var(--gap-inside) var(--gap-inside) var(--gap-inside) var(--gap-item);
    border: 1px solid var(--shimpz-color-border);
    background: color-mix(in srgb, var(--shimpz-color-text) 3%, transparent);
  }

  .attachment-chip[aria-busy="true"] { border-style: dashed; }

  .attachment-mark {
    width: 1.15rem;
    height: 1.15rem;
    fill: none;
    stroke: var(--shimpz-color-text-muted);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  .attachment-text { display: grid; min-width: 0; gap: var(--gap-inside); }

  .attachment-name {
    overflow: hidden;
    color: var(--shimpz-color-text);
    font: 500 0.8rem/1.35 var(--shimpz-font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .attachment-details {
    overflow: hidden;
    color: var(--shimpz-color-text-dim);
    font: 400 0.68rem/1.35 var(--shimpz-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-chip :global(.shimpz-button.attachment-remove) {
    width: 1.75rem;
    height: 1.75rem;
    min-height: 0;
    padding: 0;
    color: var(--shimpz-color-text-dim);
  }

  .attachment-chip :global(.attachment-remove svg) {
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }
</style>
