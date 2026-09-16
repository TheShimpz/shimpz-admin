<script>
  import { Button, Card, DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    open = $bindable(false),
    snapshot = null,
    team = null,
    busy = false,
    error = '',
    onconfirm = () => {},
    oncancel = () => {},
  } = $props();

  let dialog = $state();
  let copy = $derived($t('store'));
  let title = $derived($t('store.localConfirmTitle', {
    assistant: snapshot?.assistant_id ?? '',
  }));

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
    if (!busy && snapshot && team) onconfirm();
  }
</script>

<Modal bind:element={dialog} labelledBy="local-assistant-install-title" oncancel={cancel}>
  <form onsubmit={submit}>
    <DialogFrame
      kicker={copy.localKicker}
      {title}
      titleId="local-assistant-install-title"
      lead={copy.localLead}
    >
      <Notice variant="warning">{copy.localRisk}</Notice>
      {#if snapshot}
        <Card class="local-install-target" padding="compact">
          <span>{copy.localExactImage}</span>
          <strong dir="ltr">v{snapshot.assistant_version} · {snapshot.platform}</strong>
          <code dir="ltr">{snapshot.image_id}</code>
        </Card>
      {/if}
      {#if team}
        <Card class="local-install-target" padding="compact">
          <span>{copy.assistantDestinationTeam}</span>
          <strong>{team.name}</strong>
          <code>{team.id}</code>
        </Card>
      {/if}
      {#if error}<Notice variant="error">{error}</Notice>{/if}
      {#snippet footer()}
        <Button type="button" variant="secondary" disabled={busy} onclick={oncancel}>
          {copy.assistantActionCancel}
        </Button>
        <Button type="submit" disabled={busy || !snapshot || !team}>
          {busy ? copy.localInstalling : copy.localInstall}
        </Button>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
  :global(.local-install-target > [data-slot="card-content"]) { display: grid; gap: 0.25rem; }
  :global(.local-install-target span) {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  :global(.local-install-target strong) { font-size: 0.85rem; }
  :global(.local-install-target code) { overflow-wrap: anywhere; color: var(--accent); font-size: 0.65rem; }
</style>
