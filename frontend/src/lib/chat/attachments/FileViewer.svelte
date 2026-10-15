<script>
  import { Button, DialogFrame, Modal } from '@shimpz/frontend';
  import { untrack } from 'svelte';
  import PdfPages from '#lib/chat/attachments/PdfPages.svelte';
  import { attachmentKind } from '#lib/chat/attachments/files.js';
  import { paged, previewable, previewUrl, stored } from '#lib/chat/attachments/previews.js';
  import TextPreview from '#lib/chat/attachments/TextPreview.svelte';
  import Unavailable from '#lib/chat/attachments/Unavailable.svelte';
  import { t } from '#lib/i18n/index.js';

  // The files of one message opened over the chat (ADR-0093) in the design system's dialog frame, filling the viewport
  // within its margin, each below its literal name. An image is Team's sanitized rendition loaded at its own size, never
  // its thumbnail; a PDF is Team's rendition of each of its pages; a text file is its own text; any other file says it
  // has no preview. The arrow keys and the arrows along the frame's sides move to the previous or the next file; the
  // thumbnail the viewer opened from stands in only when its rendition cannot load, and any other image that cannot load
  // says so. Esc, a click on the backdrop, and Close each close it; whoever opened it gets focus back in `onclose`.
  let { teamId, files, start = 0, thumbnail = null, onclose } = $props();

  const id = $props.id();
  let dialog = $state();
  // The files as they were when it opened: a thumbnail failing meanwhile leaves the message's own list, never this one.
  const opened = untrack(() => [...files]);
  // The viewer opens on `start`, then moves on its own.
  let index = $state(untrack(() => start));
  let failed = $state(false);
  let current = $derived(opened[index]);
  let hasPrevious = $derived(index > 0);
  let hasNext = $derived(index < opened.length - 1);
  let kind = $derived(attachmentKind(current.mediaType));
  let shows = $derived(
    previewable(teamId, current) ? 'image'
      : paged(teamId, current) ? 'pdf'
      : kind === 'text' && stored(teamId, current) ? 'text'
      : 'none',
  );

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  function close() {
    dialog?.close();
    onclose();
  }

  function show(next) {
    if (next < 0 || next >= opened.length || next === index) return;
    index = next;
    failed = false;
  }

  // Left and right follow the reading direction: in a right-to-left interface, left moves on.
  function keydown(event) {
    if (!dialog?.open || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const forward = (event.key === 'ArrowRight') === (getComputedStyle(dialog).direction !== 'rtl');
    show(index + (forward ? 1 : -1));
  }

  // The dialog itself is the target only where its content is not: its backdrop.
  function closeOnBackdrop(event) {
    if (event.target === dialog) close();
  }
</script>

<!-- The arrow keys move on wherever the focus is while the viewer is open, even once an arrow at its end gave it up. -->
<svelte:window onkeydown={keydown} />

<Modal
  bind:element={dialog}
  class="file-viewer"
  size="xl"
  labelledBy={`${id}-title`}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onclick={closeOnBackdrop}
>
  <div class="viewer-shell">
    <DialogFrame class="viewer" kicker={$t('attachments').kinds[kind] ?? $t('attachments').kinds.file} title={current.name} titleId={`${id}-title`}>
      <div class="viewer-body" class:paged={opened.length > 1}>
        {#if opened.length > 1}
          <Button class="viewer-step" variant="ghost" type="button" disabled={!hasPrevious} aria-label={$t('attachments.previousFile')} title={$t('attachments.previousFile')} onclick={() => show(index - 1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>
          </Button>
        {/if}
        <figure class="stage" class:scanned={shows === 'image' || shows === 'none'}>
          {#key current.key ?? current.id}
            {#if shows === 'pdf'}
              <PdfPages {teamId} file={current} />
            {:else if shows === 'text'}
              <TextPreview {teamId} file={current} />
            {:else if shows === 'none'}
              <Unavailable text={$t('attachments.noPreview')} />
            {:else if failed && !(index === start && thumbnail)}
              <Unavailable text={$t('attachments.notRead')} />
            {:else}
              <img
                src={failed ? thumbnail.url : previewUrl(teamId, current.id)}
                alt={current.name}
                onerror={() => (failed = true)}
              />
            {/if}
          {/key}
        </figure>
        {#if opened.length > 1}
          <Button class="viewer-step" variant="ghost" type="button" disabled={!hasNext} aria-label={$t('attachments.nextFile')} title={$t('attachments.nextFile')} onclick={() => show(index + 1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>
          </Button>
        {/if}
      </div>
    </DialogFrame>
    <Button
      class="viewer-close"
      variant="ghost"
      size="sm"
      type="button"
      onclick={close}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
      {$t('attachments.closeViewer')}
    </Button>
  </div>
</Modal>

<style>
  /* The viewer fills the viewport, keeping the page's region margin on every side. */
  :global(dialog.shimpz-modal.file-viewer) {
    width: calc(100dvw - 2 * var(--gap-region));
    max-width: none;
    height: calc(100dvh - 2 * var(--gap-region));
    max-height: none;
  }

  /* The viewer's one box, in the design system's cut, with the close button's soft line at half its strength. Only the
     header runs its full width; below it the previous and next arrows each hold a column of their own beside the
     image, down to the box's foot. */
  .viewer-shell {
    position: relative;
    height: 100%;
    background: var(--shimpz-color-surface);
    border: 1px solid color-mix(in srgb, var(--shimpz-color-border) 50%, transparent);
    box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 68%);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, var(--shimpz-cut-sm) 100%, 0 calc(100% - var(--shimpz-cut-sm)));
  }

  /* The frame lends the box its header and stage, without a box of its own. */
  .viewer-shell :global(.shimpz-dialog-frame.viewer) {
    height: 100%;
    max-height: none;
    border: 0 !important;
    background: transparent;
    box-shadow: none;
    clip-path: none !important;
  }

  .viewer-shell :global(.viewer h2) {
    overflow: hidden;
    padding-inline-end: 7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .viewer-shell :global(.viewer > .body) {
    display: flex;
    padding-inline: 0;
    overflow: hidden;
  }

  .viewer-body {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    padding-inline: var(--shimpz-space-5);
  }

  .viewer-body.paged {
    grid-template-columns: 3.5rem minmax(0, 1fr) 3.5rem;
    padding-inline: 0;
  }

  .viewer-shell :global(.viewer-close) {
    position: absolute;
    inset-block-start: var(--shimpz-space-4);
    inset-inline-end: var(--shimpz-space-4);
  }

  .viewer-shell :global(.viewer-close svg) {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }

  /* An image keeps its own proportions and fits the stage, never larger than it is; pages and text fill it and scroll. */
  .stage {
    display: flex;
    min-width: 0;
    min-height: 0;
    margin: 0;
    align-items: center;
    justify-content: center;
    background: var(--shimpz-color-bg);
  }

  .stage.scanned {
    background:
      repeating-linear-gradient(to bottom, color-mix(in srgb, var(--shimpz-color-cyan) 4%, transparent) 0 1px, transparent 1px 3px),
      var(--shimpz-color-bg);
  }

  img {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  /* An image Team can no longer read, or a file with no preview, says so in its place. */
  /* Each arrow fills its column; one with nowhere to go stays in place, disabled. */
  .viewer-shell :global(.shimpz-button.viewer-step) {
    --button-border: transparent;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    border-radius: 0 !important;
    color: var(--shimpz-color-text);
    background: transparent;
    clip-path: none;
  }

  .viewer-shell :global(.viewer-step svg) {
    width: 1.5rem;
    height: 1.5rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  /* An arrow points the way it moves, in either reading direction. */
  :global([dir='rtl']) .viewer-shell :global(.viewer-step svg) { transform: scaleX(-1); }
</style>
