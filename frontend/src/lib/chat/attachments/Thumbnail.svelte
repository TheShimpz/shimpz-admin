<script>
  import { Button } from '@shimpz/frontend';
  import AttachmentChip from '#lib/chat/attachments/Chip.svelte';
  import ImageViewer from '#lib/chat/attachments/ImageViewer.svelte';
  import { acquirePreview } from '#lib/chat/attachments/previews.js';
  import { t } from '#lib/i18n/index.js';

  // One image a sent message carried (ADR-0093): its card until its thumbnail is drawn, then the thumbnail, a fixed
  // square the image's centre fills edge to edge, as a button that opens the image; its name shows on hover or focus. The thumbnail is asked for only once its message comes within
  // NEAR_PX of the chat's scrolling region, as the catalog's icons are; any failure keeps the card.
  let { teamId, file } = $props();

  const NEAR_PX = 400;
  let element = $state();
  let opener = $state();
  let near = $state(false);
  let shown = $state(null);
  let viewing = $state(false);

  // The chat scrolls inside its own region, not the window: nearness is measured against it.
  function scrollRoot(node) {
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) return parent;
    }
    return null;
  }

  $effect(() => {
    if (near || !element) return undefined;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) near = true;
    }, { root: scrollRoot(element), rootMargin: `${NEAR_PX}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!near) return undefined;
    const pin = acquirePreview(teamId, file.id);
    let current = true;
    if (pin.cached) shown = pin.cached;
    else pin.ready.then((thumbnail) => { if (current) shown = thumbnail; }, () => {});
    return () => {
      current = false;
      pin.release();
    };
  });

  function closeViewer() {
    viewing = false;
    opener?.focus();
  }
</script>

{#if shown}
  <li bind:this={element} class="attachment-thumbnail">
    <Button
      bind:element={opener}
      class="attachment-open"
      variant="ghost"
      type="button"
      aria-label={$t('attachments.openImage', { name: file.name })}
      onclick={() => (viewing = true)}
    >
      <img src={shown.url} alt={file.name} />
      <span class="thumbnail-name" aria-hidden="true">{file.name}</span>
    </Button>
    {#if viewing}
      <ImageViewer {teamId} fileId={file.id} name={file.name} thumbnail={shown} onclose={closeViewer} />
    {/if}
  </li>
{:else}
  <AttachmentChip bind:element name={file.name} size={file.size} kind={file.kind} note={file.note} sent />
{/if}

<style>
  .attachment-thumbnail {
    display: flex;
    min-width: 0;
    align-self: start;
  }

  /* Every thumbnail is the same square. */
  .attachment-thumbnail :global(.shimpz-button.attachment-open) {
    --button-border: var(--shimpz-color-border);
    position: relative;
    width: 8rem;
    height: 8rem;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--shimpz-color-text) 3%, transparent);
  }

  .attachment-thumbnail :global(.attachment-open .button-content) {
    display: block;
    width: 100%;
    height: 100%;
    line-height: 0;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* The name, as a label over the foot of the image, only while the thumbnail is hovered or focused. */
  .thumbnail-name {
    position: absolute;
    inset: auto 0 0;
    padding: var(--gap-inside) var(--gap-item);
    overflow: hidden;
    color: var(--shimpz-color-text);
    background: color-mix(in srgb, var(--shimpz-color-bg) 78%, transparent);
    font: 600 0.62rem/1.3 var(--shimpz-font-sans);
    letter-spacing: 0;
    text-align: start;
    text-overflow: ellipsis;
    text-shadow: none;
    text-transform: none;
    white-space: nowrap;
    opacity: 0;
    transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease);
  }

  .attachment-thumbnail :global(.attachment-open:is(:hover, :focus-visible) .thumbnail-name) { opacity: 1; }
</style>
