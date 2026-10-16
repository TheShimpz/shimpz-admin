<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { tick } from 'svelte';

  import { DialogFrame, Modal, Notice, TextField } from '@shimpz/frontend';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { showAdminNotice } from '#lib/shell/notice.js';
  import { t } from '#lib/i18n/index.js';
  import { LocalApiError } from '#lib/api.js';
  import { createTeam, deleteTeam, teamContext } from '#lib/teams/context.js';

  let { onsettled } = $props();

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

  let copy = $derived($t('teamDialogs'));
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

  // A refused request gives the field to fix the focus once the controls it disabled are enabled again, while its
  // dialog is still open; focus the person moved meanwhile stays where it is.
  async function regain(dialog, field) {
    await tick();
    const focused = document.activeElement;
    if (dialog?.open && (!focused || focused === document.body)) document.getElementById(field)?.focus();
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
    if (creating || !$commandsReady || !teamName.trim()) return;
    creating = true;
    createError = '';
    try {
      const created = await createTeam(teamName);
      createDialog?.close();
      await goto(`/chat/?team=${encodeURIComponent(created.id)}`);
      onsettled();
    } catch (error) {
      createError = outcomeUnknown(error) ? $t('shell.outcomeUnknown') : copy.createFailed;
      void regain(createDialog, 'team-create-name');
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
    if (deleting || !$commandsReady || !target || deleteName !== target.name || !supervisorPassword) return;
    deleting = true;
    deleteError = '';
    deleteErrorDetail = '';
    let deleted = false;
    try {
      await deleteTeam(target.id, deleteName, supervisorPassword);
      deleted = true;
    } catch (error) {
      const known = error instanceof LocalApiError;
      const wrongPassword = known && error.status === 403 && error.message === 'Supervisor password is incorrect';
      const unknown = outcomeUnknown(error);
      deleteError = wrongPassword ? copy.wrongPassword : unknown ? $t('shell.outcomeUnknown') : copy.deleteFailed;
      deleteErrorDetail = known && !wrongPassword && !unknown
        ? `${error.status > 0 ? `HTTP ${error.status} · ` : ''}${error.message}`
        : '';
      supervisorPassword = '';
      void regain(deleteDialog, 'team-delete-password');
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
      label: $t('teamDialogs.deleteSuccessLabel'),
      message: $t('teamDialogs.deleteSuccessMessage', { team: target.name }),
    });
    // goto refuses a location without a route (the not-found page), which has no Team selection to record.
    if (page.route.id) {
      const next = new URL(page.url.href);
      if ($teamContext.selectedTeamId) next.searchParams.set('team', $teamContext.selectedTeamId);
      else next.searchParams.delete('team');
      await goto(next, { replace: true, reset: false });
    }
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
      lead={$t('teamDialogs.deleteLead', { name: deletingTeam?.name ?? '' })}
    >
      <TextField
        id="team-delete-name"
        label={copy.deleteName}
        type="text"
        bind:value={deleteName}
        placeholder={$t('teamDialogs.deleteNamePlaceholder', { name: deletingTeam?.name ?? '' })}
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
          disabled={deleting || !$commandsReady || !deletingTeam || deleteName !== deletingTeam.name || !supervisorPassword}
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
        <DialogAction kind="confirm" type="submit" disabled={creating || !$commandsReady || !teamName.trim()}>{creating ? copy.creating : copy.create}</DialogAction>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  form { margin: 0; }
</style>
