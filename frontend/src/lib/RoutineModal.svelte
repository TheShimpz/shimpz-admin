<script>
  import { Button, Modal } from '@shimpz/frontend';

  import { t } from '$lib/i18n.js';
  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // The one shell of every Routine modal (ADR-0086): a chamfered frame under a scanline header with the modal's title.
  // `onback` adds a Back control before the title; `tag` renders beside it; `closable` keeps the Close control. `open`
  // leaves the frame open below its header: no side or bottom edges, so the content draws its own. The modal opens as
  // soon as it mounts, then `onopen` may place focus. `full` fills the whole viewport, for content read at length.
  let {
    dialog = $bindable(),
    class: className = '',
    size = 'lg',
    title,
    frameClass = '',
    open = false,
    full = false,
    closable = true,
    onback = null,
    oncancel,
    onclose,
    onopen = null,
    tag,
    children,
  } = $props();

  const id = $props.id();
  let copy = $derived($t('routine.list'));

  $effect(() => {
    if (dialog && !dialog.open) {
      dialog.showModal();
      onopen?.();
    }
  });
</script>

<Modal bind:element={dialog} class={['routine-modal', full && 'routine-modal--full', className]} {size} labelledBy={`${id}-title`} {oncancel}>
  <div class={['frame', 'routine-frame', open && 'frame--open', full && 'frame--full', frameClass]}>
    <header class="head routine-head">
      {#if onback}
        <Button class="back" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.back} title={copy.back} onclick={onback}>
          <RoutineIcon name="back" />
        </Button>
      {/if}
      <div class="title">
        <h2 id={`${id}-title`}>
          {title}
        </h2>
        {@render tag?.()}
      </div>
      {#if closable}
        <Button class="close" variant="ghost" size="sm" iconOnly type="button" aria-label={copy.close} title={copy.close} onclick={onclose}>
          <RoutineIcon name="close" />
        </Button>
      {/if}
    </header>
    {@render children?.()}
  </div>
</Modal>

<style>
  /* The frame speaks the run card's language: a scanline header strip, a chamfered corner, neutral borders. */
  .frame {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 2rem);
    min-width: 0;
    color: var(--shimpz-color-text);
    background: var(--shimpz-color-surface);
    border: 1px solid var(--shimpz-color-border);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, 0 100%);
    box-shadow: 0 1.5rem 5rem rgb(0 0 0 / 68%);
  }
  .frame--open { border-inline-color: transparent; border-block-end-color: transparent; }
  .frame--open > .head { box-shadow: inset 1px 0 0 var(--shimpz-color-border), inset -1px 0 0 var(--shimpz-color-border); }
  :global([dir="rtl"]) .frame { clip-path: polygon(var(--shimpz-cut-lg) 0, 100% 0, 100% 100%, 0 100%, 0 var(--shimpz-cut-lg)); }
  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--shimpz-space-2);
    min-height: 3rem;
    padding: 0.4rem var(--shimpz-space-2) 0.4rem var(--shimpz-space-4);
    color: var(--shimpz-color-text-dim);
    background: repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 4%, transparent) 2px 3px);
    border-block-end: 1px solid var(--shimpz-color-border);
  }
  .head:has(:global(.back)) { padding-inline-start: var(--shimpz-space-2); }
  /* Long titles wrap. */
  .title { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; gap: var(--shimpz-space-2); }
  h2 { flex: 1 1 auto; min-width: 0; margin: 0; color: var(--shimpz-color-text); font: 600 1rem/1.3 var(--shimpz-font-sans); overflow-wrap: anywhere; }
  .head :global(.close), .head :global(.back) { --button-color: var(--shimpz-color-text-dim); --button-border: transparent; flex: none; }
  :global([dir="rtl"]) .head :global(.back .routine-icon) { transform: scaleX(-1); }
  /* A full-screen modal is a sheet over the whole viewport: no chamfer, no shadow, its content scrolling below the header. */
  :global(dialog.shimpz-modal.routine-modal--full) { width: 100dvw; max-width: none; height: 100dvh; max-height: none; margin: 0; }
  .frame--full { height: 100dvh; max-height: 100dvh; border: 0; clip-path: none; box-shadow: none; }
  :global([dir="rtl"]) .frame--full { clip-path: none; }
  /* On a phone every Routine modal is a full-screen sheet, and a status tag sits under the title. */
  @media (max-width: 600px) {
    .head { align-items: flex-start; }
    .title { flex-wrap: wrap; align-self: center; row-gap: 0.35rem; }
    h2 { flex-basis: 100%; }
    :global(dialog.shimpz-modal.routine-modal) { width: 100dvw; max-width: none; height: 100dvh; max-height: none; margin: 0; }
    .frame { height: 100dvh; max-height: 100dvh; clip-path: none; }
  }
  @media (forced-colors: active) { .frame { border-color: CanvasText; } }
</style>
