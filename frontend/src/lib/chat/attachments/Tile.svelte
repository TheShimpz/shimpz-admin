<script>
  import { Button } from '@shimpz/frontend';
  import { formatFileSize } from '#lib/chat/attachments/files.js';
  import ImageViewer from '#lib/chat/attachments/ImageViewer.svelte';
  import { acquirePreview, previewable } from '#lib/chat/attachments/previews.js';
  import { locale, t } from '#lib/i18n/index.js';

  // One file of a message as a square tile (ADR-0093), alike in the composer and in a sent message: an image Team has
  // stored shows its thumbnail and opens over the chat; any other file, or an image not stored yet or not readable,
  // shows its type mark and type. Its name stays at the tile's foot, cut in the middle so its start and its extension
  // both show. The thumbnail is asked for only once the tile comes within NEAR_PX of its scrolling region. In the
  // composer the tile can be removed from the message.
  // `images` are the message's images the viewer can move through, this one among them.
  let { teamId, file, images = [file], status = 'ready', onremove = null } = $props();

  const NEAR_PX = 400;
  // The name's end, always kept whole: its extension and a few characters before it; only the start before it is cut.
  const TAIL_CHARS = 8;
  let element = $state();
  let opener = $state();
  let near = $state(false);
  let shown = $state(null);
  let viewing = $state(false);

  let copy = $derived($t('attachments'));
  let kindText = $derived(copy.kinds[file.kind] ?? copy.kinds.file);
  let noteText = $derived(file.note === 'pdf-text' ? copy.pdfText : file.note === 'unreadable' ? copy.notRead : '');
  let statusText = $derived(status === 'queued' ? copy.queued : status === 'uploading' ? copy.sending : '');
  let details = $derived([kindText, formatFileSize(file.size, $locale), noteText, statusText].filter(Boolean).join(' · '));
  let nameParts = $derived(
    [...file.name].length > TAIL_CHARS
      ? [[...file.name].slice(0, -TAIL_CHARS).join(''), [...file.name].slice(-TAIL_CHARS).join('')]
      : [file.name, ''],
  );
  let canPreview = $derived(status === 'ready' && previewable(teamId, file));

  // The chat scrolls inside its own region, not the window: nearness is measured against it.
  function scrollRoot(node) {
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) return parent;
    }
    return null;
  }

  $effect(() => {
    if (!canPreview || near || !element) return undefined;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) near = true;
    }, { root: scrollRoot(element), rootMargin: `${NEAR_PX}px 0px` });
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!canPreview || !near) return undefined;
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

<li bind:this={element} class="attachment-tile" data-kind={file.kind} aria-busy={status === 'ready' ? undefined : 'true'}>
  {#if shown}
    <Button
      bind:element={opener}
      class="tile-open"
      variant="ghost"
      type="button"
      aria-label={$t('attachments.openImage', { name: file.name })}
      onclick={() => (viewing = true)}
    >
      <img src={shown.url} alt={file.name} />
    </Button>
  {:else}
    <span class="tile-face" aria-hidden="true">
      <svg class="tile-mark" viewBox="0 0 24 24">
        {#if file.kind === 'image'}
          <path d="M4.5 5.5h15v13h-15zM4.5 15.5l4.5-4.5 4 4 2.5-2.5 4 4"></path><circle cx="15.5" cy="9.5" r="1.4"></circle>
        {:else if file.kind === 'pdf'}
          <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 13h6M9.5 16.5h4"></path>
        {:else if file.kind === 'text'}
          <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 11.5h6M9.5 14.5h6M9.5 17.5h3.5"></path>
        {:else}
          <path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4"></path>
        {/if}
      </svg>
      <span class="tile-kind">{kindText}</span>
    </span>
  {/if}
  <span class="tile-name" title={file.name}><span class="head">{nameParts[0]}</span><span class="tail">{nameParts[1]}</span></span>
  <span class="sr-only">{details}</span>
  {#if onremove}
    <Button
      class="tile-remove"
      variant="ghost"
      size="icon"
      type="button"
      onclick={onremove}
      title={copy.remove}
      aria-label={$t('attachments.removeNamed', { name: file.name })}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
    </Button>
  {/if}
  {#if viewing && shown}
    <ImageViewer
      {teamId}
      images={images.some((image) => image.id === file.id) ? images : [file]}
      start={Math.max(0, images.findIndex((image) => image.id === file.id))}
      thumbnail={shown}
      onclose={closeViewer}
    />
  {/if}
</li>

<style>
  /* Every tile is the same square, as wide as its grid column and never wider than 8rem, cut like the controls, with
     no border. */
  .attachment-tile {
    position: relative;
    clip-path: var(--shimpz-control-shape);
    display: grid;
    width: 100%;
    max-width: 8rem;
    aspect-ratio: 1;
    min-width: 0;
    overflow: hidden;
    background: color-mix(in srgb, var(--shimpz-color-text) 4%, var(--shimpz-color-bg));
  }

  /* A file still uploading is dimmed until Team has stored it. */
  .attachment-tile[aria-busy="true"] { opacity: 0.6; }

  .attachment-tile :global(.shimpz-button.tile-open) {
    --button-border: transparent;
    border: 0;
    border-radius: 0 !important;
    clip-path: none;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    background: transparent;
  }

  /* An image is not a label: the controls' hover glitch, which slices a button's content, never touches it. */
  .attachment-tile :global(.tile-open .button-content) {
    display: block;
    width: 100%;
    height: 100%;
    line-height: 0;
    animation: none !important;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* A file without a thumbnail shows its type mark and type above the name. */
  .tile-face {
    display: grid;
    align-content: center;
    justify-items: center;
    gap: var(--gap-inside);
    padding-block-end: 1.1rem;
  }

  .tile-mark {
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: var(--shimpz-color-text-muted);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  .tile-kind {
    color: var(--shimpz-color-text-dim);
    font: 600 0.56rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* The name always shows at the tile's foot; a long one is cut in the middle, its start and its end kept. */
  .tile-name {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    min-width: 0;
    padding: var(--gap-inside) var(--gap-item);
    color: #fff;
    font: 600 0.62rem/1.3 var(--shimpz-font-sans);
    /* A dark outline keeps the name legible over any image, with no ground of its own. */
    text-shadow: 0 0 2px #000, 0 0 3px #000, 0 1px 2px #000;
    pointer-events: none;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .head {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tail { flex: none; }

  .attachment-tile :global(.shimpz-button.tile-remove) {
    position: absolute;
    inset-block-start: var(--gap-inside);
    inset-inline-end: var(--gap-inside);
    width: 1.5rem;
    height: 1.5rem;
    min-height: 0;
    padding: 0;
    color: var(--shimpz-color-text);
    background: color-mix(in srgb, var(--shimpz-color-bg) 78%, transparent);
  }

  .attachment-tile :global(.tile-remove svg) {
    width: 0.8rem;
    height: 0.8rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }
</style>
