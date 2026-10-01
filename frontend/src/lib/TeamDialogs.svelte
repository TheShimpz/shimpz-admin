<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import { DialogFrame, Modal, Notice, TextField } from '@shimpz/frontend';
  import DialogAction from '$lib/DialogAction.svelte';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';
  import { LocalApiError } from '$lib/localApi.js';
  import { createTeam, deleteTeam, teamContext } from '$lib/teamContext.js';

  let { onsettled = () => {} } = $props();

  let createDialog = $state();
  let deleteDialog = $state();
  let teamName = $state('');
  let creating = $state(false);
  let createError = $state('');
  let deletingTeam = $state();
  let deleteName = $state('');
  let supervisorPassword = $state('');
  let deleting = $state(false);
  let deleteError = $state('');
  let deleteErrorDetail = $state('');

  let copy = $derived($t('chatContext'));
  let supervisorPasswordError = $derived(deleteError === copy.wrongPassword ? deleteError : '');
  let requiresTeam = $derived(
    $teamContext.phase === 'ready' && $teamContext.teams.length === 0,
  );

  $effect(() => {
    if (!requiresTeam || createDialog?.open) return;
    queueMicrotask(() => {
      if (requiresTeam && !createDialog?.open) createDialog?.showModal();
    });
  });

  export function openCreate() {
    teamName = '';
    createError = '';
    if (!createDialog?.open) createDialog?.showModal();
  }

  export function openDelete(team) {
    deletingTeam = team;
    deleteError = '';
    deleteErrorDetail = '';
    deleteName = '';
    supervisorPassword = '';
    if (!deleteDialog?.open) deleteDialog?.showModal();
  }

  function closeCreate() {
    if (creating || requiresTeam) return;
    createDialog?.close();
    onsettled();
  }

  function cancelCreate(event) {
    event.preventDefault();
    closeCreate();
  }

  function recoverRequiredCreate() {
    if (!requiresTeam || creating) return;
    queueMicrotask(() => {
      if (requiresTeam && !creating && !createDialog?.open) createDialog?.showModal();
    });
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (creating || !teamName.trim()) return;
    creating = true;
    createError = '';
    try {
      const created = await createTeam(fetch, teamName);
      createDialog?.close();
      await goto(`/chat/?team=${encodeURIComponent(created.id)}`);
      onsettled();
    } catch {
      createError = copy.createFailed;
    } finally {
      creating = false;
    }
  }

  function closeDelete() {
    if (deleting) return;
    deleteDialog?.close();
    deletingTeam = undefined;
    deleteError = '';
    deleteErrorDetail = '';
    deleteName = '';
    supervisorPassword = '';
    onsettled();
  }

  function cancelDelete(event) {
    event.preventDefault();
    closeDelete();
  }

  async function submitDelete(event) {
    event.preventDefault();
    const target = deletingTeam;
    if (deleting || !target || deleteName !== target.name || !supervisorPassword) return;
    deleting = true;
    deleteError = '';
    deleteErrorDetail = '';
    let deleted = false;
    try {
      await deleteTeam(fetch, target.id, deleteName, supervisorPassword);
      deleted = true;
    } catch (error) {
      const known = error instanceof LocalApiError;
      const wrongPassword = known && error.status === 403 && error.message === 'Supervisor password is incorrect';
      deleteError = wrongPassword ? copy.wrongPassword : copy.deleteFailed;
      deleteErrorDetail = known && !wrongPassword
        ? `${error.status > 0 ? `HTTP ${error.status} · ` : ''}${error.message}`
        : '';
      supervisorPassword = '';
    } finally {
      deleting = false;
    }
    if (!deleted) return;

    deleteDialog?.close();
    deletingTeam = undefined;
    deleteName = '';
    supervisorPassword = '';
    showAdminNotice({
      tone: 'success',
      label: $t('chatContext.deleteSuccessLabel'),
      message: $t('chatContext.deleteSuccessMessage', { team: target.name }),
    });
    const next = new URL(page.url);
    if ($teamContext.selectedTeamId) next.searchParams.set('team', $teamContext.selectedTeamId);
    else next.searchParams.delete('team');
    await goto(next, { replaceState: true, keepFocus: true, noScroll: true });
    onsettled();
  }
</script>

<Modal
  bind:element={deleteDialog}
  labelledBy="team-delete-title"
  oncancel={cancelDelete}
>
  <form onsubmit={submitDelete}>
    <DialogFrame
      kicker={copy.deleteKicker}
      title={copy.deleteTitle}
      titleId="team-delete-title"
      lead={$t('chatContext.deleteLead', { name: deletingTeam?.name ?? '' })}
    >
      <TextField
        id="team-delete-name"
        label={copy.deleteName}
        type="text"
        bind:value={deleteName}
        placeholder={$t('chatContext.deleteNamePlaceholder', { name: deletingTeam?.name ?? '' })}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        required
        disabled={deleting}
      />
      <TextField
        id="team-delete-password"
        label={copy.supervisorPassword}
        type="password"
        bind:value={supervisorPassword}
        placeholder={copy.passwordPlaceholder}
        autocomplete="current-password"
        required
        disabled={deleting}
        error={supervisorPasswordError}
      />
      {#if deleteError && !supervisorPasswordError}
        <Notice variant="error">
          <strong>{deleteError}</strong>
          {#if deleteErrorDetail}<code>{copy.technicalDetail}: {deleteErrorDetail}</code>{/if}
        </Notice>
      {/if}
      {#snippet footer()}
        <DialogAction kind="cancel" type="button" onclick={closeDelete} disabled={deleting}>{copy.cancel}</DialogAction>
        <DialogAction
          kind="danger"
          type="submit"
          disabled={deleting || !deletingTeam || deleteName !== deletingTeam.name || !supervisorPassword}
        >{deleting ? copy.deleting : copy.deleteAction}</DialogAction>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<Modal bind:element={createDialog} labelledBy="team-create-title" oncancel={cancelCreate} onclose={recoverRequiredCreate}>
  <form onsubmit={submitCreate}>
    <DialogFrame kicker={copy.createKicker} title={copy.createTitle} titleId="team-create-title" lead={copy.createLead}>
      <TextField
        id="team-create-name"
        label={copy.teamName}
        type="text"
        bind:value={teamName}
        placeholder={copy.teamPlaceholder}
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        required
        disabled={creating}
      />
      {#if createError}<Notice variant="error">{createError}</Notice>{/if}
      {#snippet footer()}
        {#if !requiresTeam}
          <DialogAction kind="cancel" type="button" onclick={closeCreate} disabled={creating}>{copy.cancel}</DialogAction>
        {/if}
        <DialogAction kind="confirm" type="submit" disabled={creating || !teamName.trim()}>{creating ? copy.creating : copy.create}</DialogAction>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
</style>
