<script>
  import { DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import DialogAction from '#lib/DialogAction.svelte';
  import DialogTarget from '#lib/assistants/DialogTarget.svelte';
  import { t } from '#lib/i18n/index.js';
  let {
    open = $bindable(false),
    kicker = '',
    title,
    lead,
    targetLabel = '',
    targetName = '',
    targetId = '',
    progress = '',
    hint = '',
    error = '',
    primaryLabel = '',
    secondaryLabel,
    primaryVisible = true,
    primaryDisabled = false,
    busy = false,
    destructive = false,
    onconfirm = () => {},
    oncancel = () => {},
    // The dialog's own title id, distinct for each dialog a page holds.
    titleId = 'assistant-action-title',
    // What the dialog shows before its target, its progress, and its error.
    body,
  } = $props();

  let dialog = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  function cancel(event) {
    event.preventDefault();
    if (!busy) oncancel();
  }

  function submit(event) {
    event.preventDefault();
    if (!busy && primaryVisible && !primaryDisabled) onconfirm();
  }
</script>

<Modal bind:element={dialog} labelledBy={titleId} oncancel={cancel}>
  <form onsubmit={submit}>
  <DialogFrame
    kicker={kicker || $t('store.destinationKicker')}
    {title}
    {titleId}
    {lead}
  >
    {@render body?.()}
    {#if targetName}
      <DialogTarget label={targetLabel} name={targetName} id={targetId} />
    {/if}
    {#if progress}<p class="dialog-progress" role="status">{progress}</p>{/if}
    {#if hint}<p class="dialog-route-hint">{hint}</p>{/if}
    {#if error}<Notice variant="error">{error}</Notice>{/if}
    {#snippet footer()}
      <DialogAction kind="cancel" type="button" disabled={busy} onclick={oncancel}>
        {secondaryLabel}
      </DialogAction>
      {#if primaryVisible}
        <DialogAction
          kind={destructive ? 'danger' : 'confirm'}
          type="submit"
          disabled={busy || primaryDisabled}>
          {primaryLabel}
        </DialogAction>
      {/if}
    {/snippet}
  </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
  .dialog-progress { margin: var(--gap-group) 0 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .dialog-route-hint { margin: var(--gap-group) 0 0; border-inline-start: 2px solid var(--accent); padding: var(--gap-item) var(--gap-group); color: var(--text-dim); font-size: 0.72rem; line-height: 1.5; }
</style>
