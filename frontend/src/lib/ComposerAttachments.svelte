<script>
  import { Button } from '@shimpz/frontend';
  import AttachmentChip from '$lib/AttachmentChip.svelte';
  import { t } from '$lib/i18n.js';

  // The message's files above its text: each chip, the files still being read or uploaded with their one cancel, the
  // last refusal in plain words, and the reminder that files are read only in this message (ADR-0093).
  let {
    items = [],
    progress = null,
    reading = false,
    error = '',
    oncancel = () => {},
    onremove = () => {},
  } = $props();

  let copy = $derived($t('attachments'));
</script>

{#if items.length || error || progress || reading}
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
    {#if progress || reading}
      <div class="attachment-progress">
        <span role="status">
          {progress
            ? $t('attachments.uploading', { current: String(progress.current), total: String(progress.total) })
            : copy.reading}
        </span>
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
    gap: var(--gap-item);
    padding: var(--gap-item) var(--gap-group) 0;
  }

  .attachment-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 13rem), 1fr));
    gap: var(--gap-item);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .attachment-progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-inside) var(--gap-item);
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
