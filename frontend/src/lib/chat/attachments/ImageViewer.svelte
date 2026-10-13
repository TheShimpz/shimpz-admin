<script>
  import { Button, DialogFrame, Modal } from '@shimpz/frontend';
  import { previewUrl } from '#lib/chat/attachments/previews.js';
  import { t } from '#lib/i18n/index.js';

  // One sent image opened over the chat (ADR-0093) in the design system's dialog frame, filling the viewport within its
  // margin: Team's sanitized rendition loaded again at its own size, never the thumbnail, fitted below the file's
  // literal name. The thumbnail stands in only when the rendition
  // cannot load. Esc, a click on the backdrop, and Close each close it; whoever opened it gets focus back in `onclose`.
  let { teamId, fileId, name, thumbnail, onclose } = $props();

  const id = $props.id();
  let dialog = $state();
  let failed = $state(false);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  function close() {
    dialog?.close();
    onclose();
  }

  // The dialog itself is the target only where its content is not: its backdrop.
  function closeOnBackdrop(event) {
    if (event.target === dialog) close();
  }
</script>

<Modal
  bind:element={dialog}
  class="image-viewer"
  size="xl"
  labelledBy={`${id}-title`}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onclick={closeOnBackdrop}
>
  <div class="viewer-shell">
    <DialogFrame class="viewer" kicker={$t('attachments.kinds.image')} title={name} titleId={`${id}-title`}>
      <figure class="stage">
        <img
          src={failed ? thumbnail.url : previewUrl(teamId, fileId)}
          width={thumbnail.width}
          height={thumbnail.height}
          alt={name}
          onerror={() => (failed = true)}
        />
      </figure>
    </DialogFrame>
    <Button
      class="viewer-close"
      variant="ghost"
      size="sm"
      type="button"
      onclick={close}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
      {$t('attachments.closeImage')}
    </Button>
  </div>
</Modal>

<style>
  /* The viewer fills the viewport, keeping the page's region margin on every side. */
  :global(dialog.shimpz-modal.image-viewer) {
    width: calc(100dvw - 2 * var(--gap-region));
    max-width: none;
    height: calc(100dvh - 2 * var(--gap-region));
    max-height: none;
  }

  /* The close button sits over the frame's top end corner. */
  .viewer-shell {
    position: relative;
    height: 100%;
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

  :global(dialog.image-viewer .viewer h2) {
    padding-inline-end: 7rem;
  }

  /* The frame's border is the close button's own soft line at half its strength. */
  :global(dialog.image-viewer .shimpz-dialog-frame.viewer) {
    height: 100%;
    max-height: none;
    border-color: color-mix(in srgb, var(--shimpz-color-border) 50%, transparent) !important;
    box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 68%);
  }

  :global(dialog.image-viewer .viewer h2) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  :global(dialog.image-viewer .viewer > .body) {
    display: flex;
    overflow: hidden;
  }

  /* The image keeps its own proportions and fits the stage, never larger than it is. */
  .stage {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    align-items: center;
    justify-content: center;
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
</style>
