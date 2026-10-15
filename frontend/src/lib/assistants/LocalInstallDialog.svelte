<script>
  import { ChoiceItem, Notice } from '@shimpz/frontend';
  import ActionDialog from '#lib/assistants/ActionDialog.svelte';
  import DialogTarget from '#lib/assistants/DialogTarget.svelte';
  import { t } from '#lib/i18n/index.js';

  let {
    open = $bindable(false),
    snapshot = null,
    snapshots = [],
    team = null,
    busy = false,
    // Whether a change may be sent now; while Admin reconnects the install waits for it.
    ready = true,
    error = '',
    onconfirm,
    oncancel,
    onselect,
  } = $props();

  let copy = $derived($t('store'));
  let title = $derived($t('store.localConfirmTitle', {
    assistant: snapshot?.name ?? snapshot?.assistant_id ?? '',
  }));
</script>

<ActionDialog
  bind:open
  titleId="local-assistant-install-title"
  kicker={copy.localKicker}
  {title}
  lead={copy.localLead}
  {error}
  primaryLabel={busy ? copy.localInstalling : copy.localInstall}
  secondaryLabel={copy.assistantActionCancel}
  primaryDisabled={!ready || !snapshot || !team}
  {busy}
  {onconfirm}
  {oncancel}
>
  {#snippet body()}
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
      <DialogTarget
        label={copy.localExactImage}
        name={`v${snapshot.assistant_version} · ${snapshot.platform}`}
        id={snapshot.image_id}
        nameDir="ltr"
      />
    {/if}
    {#if team}
      <DialogTarget label={copy.assistantDestinationTeam} name={team.name} id={team.id} />
    {/if}
  {/snippet}
</ActionDialog>

<style>
  .local-build-selector { display: grid; gap: var(--gap-item); }
  .local-build-selector > span {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .local-build-selector ul { display: grid; gap: var(--gap-item); margin: 0; padding: 0; list-style: none; }
</style>
