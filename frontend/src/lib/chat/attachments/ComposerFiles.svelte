<script>
  import { Button } from '@shimpz/frontend';
  import AttachmentTile from '#lib/chat/attachments/Tile.svelte';
  import { stored as storedFile } from '#lib/chat/attachments/previews.js';
  import { t } from '#lib/i18n/index.js';

  // The message's files above its text, on their own ground: each a square tile as a sent message shows it, the files
  // still being read or uploaded with their one cancel, and the last refusal in plain words (ADR-0093).
  let {
    items = [],
    teamId = null,
    progress = null,
    reading = false,
    error = '',
    oncancel = () => {},
    onremove = () => {},
  } = $props();

  let copy = $derived($t('attachments'));
  // The stored files the viewer can move through.
  let stored = $derived(items.filter((item) => item.state === 'ready' && storedFile(teamId, item)));
</script>

{#if items.length || error || progress || reading}
  <div class="composer-attachments">
    {#if items.length}
      <ul class="attachment-list" aria-label={copy.list}>
        {#each items as item (item.key)}
          <AttachmentTile {teamId} file={item} files={stored} status={item.state} onremove={() => onremove(item.key)} />
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
  </div>
{/if}

<style>
  /* The files sit on a ground of their own, set apart from the message text below them. */
  .composer-attachments {
    display: grid;
    gap: var(--gap-item);
    padding: var(--gap-item) var(--gap-group);
    border-block-end: 1px solid var(--shimpz-color-border);
    border-radius: 0;
    background: color-mix(in srgb, var(--shimpz-color-text) 7%, var(--shimpz-color-bg));
  }

  /* As a sent message shows them: one compact card each, side by side as space allows. */
  .attachment-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
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
</style>
