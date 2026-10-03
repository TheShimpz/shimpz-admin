<script>
  import { Button } from '@shimpz/frontend';
  import AttachmentChip from '$lib/AttachmentChip.svelte';
  import { t } from '$lib/i18n.js';

  // The message's files above its text: each chip, the upload in progress with its one cancel, the last refusal in
  // plain words, and the reminder that files are read only in this message (ADR-0093).
  let {
    items = [],
    progress = null,
    error = '',
    oncancel = () => {},
    onremove = () => {},
  } = $props();

  let copy = $derived($t('attachments'));
</script>

{#if items.length || error}
  <div class="composer-attachments">
    {#if items.length}
      <ul class="attachment-list" aria-label={copy.list}>
        {#each items as item (item.key)}
          <AttachmentChip
            name={item.name}
            size={item.size}
            kind={item.kind}
            note={item.note}
            state={item.state}
            onremove={() => onremove(item.key)}
          />
        {/each}
      </ul>
    {/if}
    {#if progress}
      <div class="attachment-progress">
        <span role="status">{$t('attachments.uploading', { current: String(progress.current), total: String(progress.total) })}</span>
        <Button variant="ghost" size="compact" type="button" onclick={oncancel}>{copy.cancelUpload}</Button>
      </div>
    {/if}
    {#if error}
      <p class="attachment-error" role="alert">{error}</p>
    {/if}
    {#if items.length}
      <p class="attachment-hint">{copy.hint}</p>
    {/if}
  </div>
{/if}

<style>
  .composer-attachments {
    display: grid;
    gap: 0.4rem;
    padding: 0.6rem 0.7rem 0;
  }

  .attachment-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr));
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .attachment-progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 0.6rem;
    color: var(--shimpz-color-text-muted);
    font: 400 0.72rem/1.4 var(--shimpz-font-mono);
  }

  .attachment-error {
    margin: 0;
    color: var(--shimpz-color-danger);
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .attachment-hint {
    margin: 0;
    color: var(--shimpz-color-text-dim);
    font-size: 0.72rem;
    line-height: 1.45;
  }
</style>
