<script>
  import { Button } from '@shimpz/frontend';
  import { formatFileSize } from '#lib/chat/attachments/files.js';
  import ImageViewer from '#lib/chat/attachments/ImageViewer.svelte';
  import { acquirePreview, previewable } from '#lib/chat/attachments/previews.js';
  import { locale, t } from '#lib/i18n/index.js';

  // One file of a message as a compact card (ADR-0093), alike in the composer and in a sent message: a badge, its name
  // cut in the middle so its start and its extension both show, and its type and size. An image Team has stored shows
  // its thumbnail in the badge's place, and the thumbnail opens it over the chat; until then the badge names its
  // extension. The thumbnail is asked for only once the card comes within NEAR_PX of its scrolling region, and an image
  // Team cannot read is reported through `onunavailable`, so its message can leave it out. `images` are the message's
  // images the viewer can move through, this one among them. In the composer the card can be removed from the message.
  let {
    teamId,
    file,
    images = [file],
    status = 'ready',
    onremove = null,
    onunavailable = () => {},
  } = $props();

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
  // The badge: the file's extension, at most four characters, or its type when it has none.
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
    else pin.ready.then((thumbnail) => { if (current) shown = thumbnail; }, () => { if (current) onunavailable(file.id); });
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
  class="attachment-card"
  data-kind={file.kind}
  aria-busy={status === 'ready' ? undefined : 'true'}
>
  {#if shown}
    <Button
      bind:element={opener}
      class="card-thumbnail"
      variant="ghost"
      type="button"
      aria-label={$t('attachments.openImage', { name: file.name })}
      onclick={() => (viewing = true)}
    >
      <img src={shown.url} alt={file.name} />
    </Button>
  {:else}
    <span class="card-badge" aria-hidden="true">{badge}</span>
  {/if}
  <span class="card-text">
    <span class="card-name" title={file.name}><span class="head">{nameParts[0]}</span><span class="tail">{nameParts[1]}</span></span>
    <span class="card-details">{details}</span>
  </span>
  {#if onremove}
    <Button
      class="card-remove"
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
  /* A compact card: its badge or thumbnail, then its name over its type and size. */
  .attachment-card {
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--gap-item);
    padding: var(--gap-inside);
    clip-path: var(--shimpz-control-shape);
    background: color-mix(in srgb, var(--shimpz-color-text) 5%, var(--shimpz-color-bg));
  }

  /* A file still uploading is dimmed until Team has stored it. */
  .attachment-card[aria-busy="true"] { opacity: 0.6; }

  .card-badge {
    --tone: var(--shimpz-color-text-muted);
    display: grid;
    width: 2.6rem;
    height: 2.6rem;
    place-items: center;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    clip-path: var(--shimpz-control-shape);
    font: 700 0.58rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.04em;
  }

  .attachment-card[data-kind="pdf"] .card-badge { --tone: var(--shimpz-color-magenta); }
  .attachment-card[data-kind="text"] .card-badge { --tone: var(--shimpz-color-cyan); }

  /* An image's thumbnail takes the badge's place, filling it edge to edge; the controls' glitch never slices it. */
  .attachment-card :global(.shimpz-button.card-thumbnail) {
    --button-border: transparent;
    width: 2.6rem;
    height: 2.6rem;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    background: transparent;
  }

  .attachment-card :global(.card-thumbnail .button-content) {
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

  /* The name is split where its end begins; both parts keep their spaces at that split. */
  .head {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }

  .tail { flex: none; white-space: pre; }

  .card-details {
    overflow: hidden;
    color: var(--shimpz-color-text-dim);
    font: 400 0.64rem/1.3 var(--shimpz-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-card :global(.shimpz-button.card-remove) {
    width: 1.75rem;
    height: 1.75rem;
    min-height: 0;
    padding: 0;
    color: var(--shimpz-color-text-dim);
  }

  .attachment-card :global(.card-remove svg) {
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }
</style>
