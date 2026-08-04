<script>
  import { Button, DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';
  let {
    open = $bindable(false),
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

<Modal bind:element={dialog} labelledBy="assistant-action-title" oncancel={cancel}>
  <form onsubmit={submit}>
  <DialogFrame
    kicker={$t('store.destinationKicker')}
    {title}
    titleId="assistant-action-title"
    {lead}
  >
    {#if targetName}
      <div class="dialog-target">
        <span>{targetLabel}</span>
        <strong>{targetName}</strong>
        {#if targetId}<code>{targetId}</code>{/if}
      </div>
    {/if}
    {#if progress}<p class="dialog-progress" role="status">{progress}</p>{/if}
    {#if hint}<p class="dialog-route-hint">{hint}</p>{/if}
    {#if error}<Notice variant="error">{error}</Notice>{/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={busy} onclick={oncancel}>
        {secondaryLabel}
      </Button>
      {#if primaryVisible}
        <Button
          type="submit"
          variant={destructive ? 'danger' : 'primary'}
          disabled={busy || primaryDisabled}>
          {primaryLabel}
        </Button>
      {/if}
    {/snippet}
  </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
  .dialog-target { display: grid; gap: 0.2rem; border: 1px solid var(--border-strong); padding: 0.8rem; background: #050708; }
  .dialog-target span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .dialog-target strong { font-size: 0.9rem; }
  .dialog-target code { color: var(--accent); font-size: 0.65rem; }
  .dialog-progress { margin: 1rem 0 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .dialog-route-hint { margin: 1rem 0 0; border-inline-start: 2px solid var(--accent); padding: 0.7rem 0.85rem; color: var(--text-dim); font-size: 0.72rem; line-height: 1.5; }
</style>
