<script>
  import { Button, Modal } from '@shimpz/frontend';
  import { previewUrl } from '#lib/chat/attachments/previews.js';
  import { t } from '#lib/i18n/index.js';

  // One sent image opened over the chat (ADR-0093): Team's sanitized rendition loaded again at its own size, never the
  // thumbnail, fitted to the viewport under the file's literal name. The thumbnail stands in only when the rendition
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
  <figure class="viewer">
    <header class="viewer-head">
      <h2 id={`${id}-title`}>{name}</h2>
      <Button
        class="viewer-close"
        variant="ghost"
        size="sm"
        iconOnly
        type="button"
        aria-label={$t('attachments.closeImage')}
        title={$t('attachments.closeImage')}
        onclick={close}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
      </Button>
    </header>
    <img
      src={failed ? thumbnail.url : previewUrl(teamId, fileId)}
      width={thumbnail.width}
      height={thumbnail.height}
      alt={name}
      onerror={() => (failed = true)}
    />
  </figure>
</Modal>

<style>
  .viewer {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 2rem); /* the browser's own dialog margin, not rhythm */
    margin: 0;
    color: var(--shimpz-color-text);
    background: var(--shimpz-color-surface);
    border: 1px solid var(--shimpz-color-border);
  }

  .viewer-head {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--gap-item);
    padding: var(--gap-inside) var(--gap-item) var(--gap-inside) var(--gap-panel);
    border-block-end: 1px solid var(--shimpz-color-border);
  }

  h2 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font: 600 0.9rem/1.3 var(--shimpz-font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .viewer-head :global(.viewer-close) {
    --button-color: var(--shimpz-color-text-dim);
    --button-border: transparent;
    flex: none;
  }

  .viewer-head :global(.viewer-close svg) {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }

  /* The image keeps its own proportions and fits the viewport below the header, never larger than it is. */
  img {
    display: block;
    flex: 1 1 auto;
    min-height: 0;
    width: auto;
    height: auto;
    max-inline-size: 100%;
    max-block-size: calc(100dvh - 2rem - 3rem);
    margin-inline: auto;
    object-fit: contain;
  }

  @media (forced-colors: active) { .viewer { border-color: CanvasText; } }
</style>
