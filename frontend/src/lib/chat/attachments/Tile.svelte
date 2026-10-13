<script>
  import { Button } from '@shimpz/frontend';
  import { formatFileSize } from '#lib/chat/attachments/files.js';
  import ImageViewer from '#lib/chat/attachments/ImageViewer.svelte';
  import { acquirePreview, previewable } from '#lib/chat/attachments/previews.js';
  import { locale, t } from '#lib/i18n/index.js';

  // One file of a message (ADR-0093), alike in the composer and in a sent message. An image is a thumbnail square that
  // opens over the chat once Team has stored it, its type mark until then or when Team cannot read it; its name is the
  // thumbnail's tooltip and accessible name. Any other file is a compact card: a badge with its extension, its name cut
  // in the middle so its start and its extension both show, and its type and size. The thumbnail is asked for only once
  // the tile comes within NEAR_PX of its scrolling region. In the composer either can be removed from the message.
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
  // An image is a thumbnail square; any other file a compact card naming it, as consolidated chats show files.
  let card = $derived(file.kind !== 'image');
  // The card's badge: the file's extension, at most four characters, or its type when it has none.
  let badge = $derived.by(() => {
    const dot = file.name.lastIndexOf('.');
    const extension = dot > 0 ? file.name.slice(dot + 1) : '';
    return /^[\p{L}\p{N}]{1,4}$/u.test(extension) ? extension.toUpperCase() : kindText;
  });

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

<li
  bind:this={element}
  class={card ? 'attachment-card' : 'attachment-tile'}
  data-kind={file.kind}
  aria-busy={status === 'ready' ? undefined : 'true'}
>
  {#if card}
    <span class="card-badge" aria-hidden="true">{badge}</span>
    <span class="card-text">
      <span class="card-name" title={file.name}><span class="head">{nameParts[0]}</span><span class="tail">{nameParts[1]}</span></span>
      <span class="card-details">{details}</span>
    </span>
  {:else if shown}
    <Button
      bind:element={opener}
      class="tile-open"
      variant="ghost"
      type="button"
      title={file.name}
      aria-label={$t('attachments.openImage', { name: file.name })}
      onclick={() => (viewing = true)}
    >
      <img src={shown.url} alt={file.name} />
    </Button>
  {:else}
    <span class="tile-face" title={file.name}>
      <svg class="tile-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 5.5h15v13h-15zM4.5 15.5l4.5-4.5 4 4 2.5-2.5 4 4"></path><circle cx="15.5" cy="9.5" r="1.4"></circle>
      </svg>
      <span class="sr-only">{file.name}</span>
    </span>
  {/if}
  {#if !card}<span class="sr-only">{details}</span>{/if}
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

  /* An image not yet stored, or one Team cannot read, shows only its type mark. */
  .tile-face {
    display: grid;
    place-items: center;
  }

  .tile-mark {
    width: 1.5rem;
    height: 1.5rem;
    fill: none;
    stroke: var(--shimpz-color-text-muted);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  /* Any other file is a compact card: its extension's badge, then its name over its type and size. */
  .attachment-card {
    position: relative;
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--gap-item);
    padding: var(--gap-inside);
    clip-path: var(--shimpz-control-shape);
    background: color-mix(in srgb, var(--shimpz-color-text) 5%, var(--shimpz-color-bg));
  }

  .attachment-card[aria-busy="true"] { opacity: 0.6; }

  .card-badge {
    --tone: var(--shimpz-color-text-muted);
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    clip-path: var(--shimpz-control-shape);
    font: 700 0.58rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.04em;
  }

  .attachment-card[data-kind="pdf"] .card-badge { --tone: var(--shimpz-color-magenta); }
  .attachment-card[data-kind="text"] .card-badge { --tone: var(--shimpz-color-cyan); }

  .card-text {
    display: grid;
    min-width: 0;
    gap: 0.15rem;
  }

  .card-name {
    display: flex;
    min-width: 0;
    color: var(--shimpz-color-text);
    font: 500 0.78rem/1.3 var(--shimpz-font-sans);
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .head {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tail { flex: none; }

  .card-details {
    overflow: hidden;
    color: var(--shimpz-color-text-dim);
    font: 400 0.64rem/1.3 var(--shimpz-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-card :global(.shimpz-button.tile-remove) {
    width: 1.75rem;
    height: 1.75rem;
    min-height: 0;
    padding: 0;
    color: var(--shimpz-color-text-dim);
  }

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

  :is(.attachment-tile, .attachment-card) :global(.tile-remove svg) {
    width: 0.8rem;
    height: 0.8rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }
</style>
