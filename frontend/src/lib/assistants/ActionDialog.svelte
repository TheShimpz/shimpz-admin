<script>
  import { DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import DialogAction from '#lib/DialogAction.svelte';
  import DialogTarget from '#lib/assistants/DialogTarget.svelte';
  import { t } from '#lib/i18n/index.js';
  import { recoverFocus } from '#lib/shell/focus.js';
  let {
    open = $bindable(false),
    kicker = '',
    title,
    lead,
    targetLabel = '',
    targetName = '',
    targetId = '',
    error = '',
    primaryLabel = '',
    secondaryLabel,
    primaryVisible = true,
    primaryDisabled = false,
    busy = false,
    destructive = false,
    onconfirm,
    oncancel,
    // The dialog's own title id, distinct for each dialog a page holds.
    titleId = 'assistant-action-title',
    // What the dialog shows before its target and its error.
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
  <!-- A control the request disabled takes back the focus it dropped once enabled again. -->
  <form onsubmit={submit} {@attach recoverFocus}>
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
</style>
