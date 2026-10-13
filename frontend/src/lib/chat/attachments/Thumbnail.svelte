<script>
  import { Button } from '@shimpz/frontend';
  import AttachmentChip from '#lib/chat/attachments/Chip.svelte';
  import ImageViewer from '#lib/chat/attachments/ImageViewer.svelte';
  import { acquirePreview } from '#lib/chat/attachments/previews.js';
  import { t } from '#lib/i18n/index.js';

  // One image a sent message carried (ADR-0093): its card until its thumbnail is drawn, then the thumbnail, in its own
  // proportions, as a button that opens the image. The thumbnail is asked for only once its message comes within
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
      title={file.name}
      aria-label={$t('attachments.openImage', { name: file.name })}
      onclick={() => (viewing = true)}
    >
      <img src={shown.url} width={shown.width} height={shown.height} alt={file.name} />
    </Button>
    {#if viewing}
      <ImageViewer {teamId} fileId={file.id} name={file.name} thumbnail={shown} onclose={closeViewer} />
    {/if}
  </li>
{:else}
  <AttachmentChip bind:element name={file.name} size={file.size} kind={file.kind} note={file.note} sent />
{/if}

<style>
  /* The thumbnail is as tall as its own image, never stretched to a taller neighbour's row. */
  .attachment-thumbnail {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    align-self: start;
  }

  .attachment-thumbnail :global(.shimpz-button.attachment-open) {
    --button-border: var(--shimpz-color-border);
    height: auto;
    min-height: 0;
    max-inline-size: 100%;
    padding: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--shimpz-color-text) 3%, transparent);
  }

  .attachment-thumbnail :global(.attachment-open .button-content) {
    display: block;
    line-height: 0;
  }

  /* The thumbnail keeps its own proportions within a bounded box, never wider than the message. */
  img {
    display: block;
    width: auto;
    height: auto;
    max-inline-size: min(100%, 16rem);
    max-block-size: 16rem;
  }
</style>
