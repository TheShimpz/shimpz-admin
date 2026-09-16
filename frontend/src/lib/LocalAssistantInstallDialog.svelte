<script>
  import { Button, Card, ChoiceItem, DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    open = $bindable(false),
    snapshot = null,
    snapshots = [],
    team = null,
    busy = false,
    error = '',
    onconfirm = () => {},
    oncancel = () => {},
    onselect = () => {},
  } = $props();

  let dialog = $state();
  let copy = $derived($t('store'));
  let title = $derived($t('store.localConfirmTitle', {
    assistant: snapshot?.name ?? snapshot?.assistant_id ?? '',
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
      {#if snapshots.length > 1}
        <div class="local-build-selector">
          <span>{$t('store.localBuilds', { count: snapshots.length - 1 })}</span>
          <ul>
            {#each snapshots as build (build.image_id)}
              <li>
                <ChoiceItem
                  title={`v${build.assistant_version} · ${build.platform}`}
                  description={build.image_id}
                  selected={build.image_id === snapshot?.image_id}
                  disabled={busy}
                  onclick={() => onselect(build)}
                />
              </li>
            {/each}
          </ul>
        </div>
      {/if}
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
  .local-build-selector { display: grid; gap: var(--shimpz-space-2); }
  .local-build-selector > span {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .local-build-selector ul { display: grid; gap: var(--shimpz-space-2); margin: 0; padding: 0; list-style: none; }
</style>
