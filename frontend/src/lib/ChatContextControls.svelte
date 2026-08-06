<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import {
    AssistantIcon,
    Button,
    ChoiceItem,
    DialogFrame,
    Modal,
    Notice,
    TextAction,
    TextField,
  } from '@shimpz/frontend';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';
  import { LocalApiError } from '$lib/localApi.js';
  import { modelContext, selectTeamBrain } from '$lib/modelContext.js';
  import {
    createTeam,
    deleteTeam,
    MAX_SELECTED_ASSISTANTS,
    selectAllTeamAssistants,
    teamContext,
    toggleTeamAssistant,
    unselectAllTeamAssistants,
  } from '$lib/teamContext.js';

  let { disabled = false } = $props();


  let teamDialog = $state();
  let brainDialog = $state();
  let assistantDialog = $state();
  let createDialog = $state();
  let deleteDialog = $state();
  let teamTrigger = $state();
  let brainTrigger = $state();
  let assistantTrigger = $state();
  let teamName = $state('');
  let creating = $state(false);
  let dialogError = $state('');
  let deletingTeam = $state();
  let deleteName = $state('');
  let supervisorPassword = $state('');
  let deleting = $state(false);
  let deleteError = $state('');
  let deleteErrorDetail = $state('');

  let copy = $derived($t('chatContext'));
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === $teamContext.selectedTeamId) ?? null,
  );
  let brainOptions = $derived(
    $modelContext.providers.flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      provider: provider.id,
      providerTitle: provider.title,
      model: model.id,
      title: model.title,
    }))),
  );
  let selectedBrain = $derived(
    brainOptions.find((entry) => (
      entry.provider === $modelContext.provider && entry.model === $modelContext.model
    )) ?? null,
  );
  let runningAssistants = $derived.by(() => {
    const catalog = new Map($teamContext.catalog.map((entry) => [entry.id, entry.name]));
    return $teamContext.installedAssistants
      .filter((entry) => entry.status === 'running')
      .map((entry) => ({
        id: entry.assistant,
        name: catalog.get(entry.assistant) ?? entry.assistant,
      }));
  });
  let selectedCount = $derived($teamContext.selectedAssistantIds.length);
  let assistantLimitApplies = $derived(runningAssistants.length > MAX_SELECTED_ASSISTANTS);
  let assistantCount = $derived(
    $t(assistantLimitApplies ? 'chatContext.selectedLimited' : 'chatContext.selected', {
      selected: selectedCount,
      total: runningAssistants.length,
      limit: MAX_SELECTED_ASSISTANTS,
    }),
  );
  let supervisorPasswordError = $derived(deleteError === copy.wrongPassword ? deleteError : '');
  let controlsDisabled = $derived(disabled || $teamContext.phase === 'loading');
  let requiresTeam = $derived(
    $teamContext.phase === 'ready' && $teamContext.teams.length === 0,
  );

  $effect(() => {
    if (!requiresTeam || createDialog?.open) return;
    queueMicrotask(() => {
      if (requiresTeam && !createDialog?.open) open(createDialog);
    });
  });

  function open(dialog) {
    if (!dialog?.open) dialog?.showModal();
  }

  function close(dialog, trigger) {
    dialog?.close();
    queueMicrotask(() => trigger?.focus());
  }

  function cancelDialog(event, dialog, trigger) {
    event.preventDefault();
    close(dialog, trigger);
  }

  async function chooseTeam(id) {
    if (controlsDisabled || !id || id === $teamContext.selectedTeamId) {
      close(teamDialog, teamTrigger);
      return;
    }
    const next = new URL(page.url);
    next.searchParams.set('team', id);
    await goto(next, { replaceState: true, keepFocus: true, noScroll: true });
    close(teamDialog, teamTrigger);
  }

  function openCreate() {
    teamDialog?.close();
    teamName = '';
    dialogError = '';
    queueMicrotask(() => open(createDialog));
  }

  function closeCreate() {
    if (!creating && !requiresTeam) close(createDialog, teamTrigger);
  }

  function cancelCreate(event) {
    event.preventDefault();
    closeCreate();
  }

  function recoverRequiredCreate() {
    if (!requiresTeam || creating) return;
    queueMicrotask(() => {
      if (requiresTeam && !creating && !createDialog?.open) open(createDialog);
    });
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (creating || !teamName.trim()) return;
    creating = true;
    dialogError = '';
    try {
      const created = await createTeam(fetch, teamName);
      createDialog?.close();
      window.location.assign(`/assistants/?team=${encodeURIComponent(created.id)}`);
    } catch {
      dialogError = copy.createFailed;
    } finally {
      creating = false;
    }
  }

  function resetDeleteForm() {
    deleteName = '';
    supervisorPassword = '';
  }

  function openDelete(team) {
    teamDialog?.close();
    deletingTeam = team;
    deleteError = '';
    deleteErrorDetail = '';
    resetDeleteForm();
    queueMicrotask(() => open(deleteDialog));
  }

  function closeDelete() {
    if (deleting) return;
    deleteDialog?.close();
    deletingTeam = undefined;
    deleteError = '';
    deleteErrorDetail = '';
    resetDeleteForm();
    queueMicrotask(() => teamTrigger?.focus());
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
      deleteError = wrongPassword
        ? copy.wrongPassword
        : copy.deleteFailed;
      deleteErrorDetail = known && !wrongPassword
        ? `${error.status > 0 ? `HTTP ${error.status} · ` : ''}${error.message}`
        : '';
      supervisorPassword = '';
    } finally {
      deleting = false;
    }
    if (!deleted) return;

    resetDeleteForm();
    deleteDialog?.close();
    deletingTeam = undefined;
    showAdminNotice({
      tone: 'success',
      label: $t('chatContext.deleteSuccessLabel'),
      message: $t('chatContext.deleteSuccessMessage', { team: target.name }),
    });
    const next = new URL(page.url);
    if ($teamContext.selectedTeamId) next.searchParams.set('team', $teamContext.selectedTeamId);
    else next.searchParams.delete('team');
    await goto(next, { replaceState: true, keepFocus: true, noScroll: true });
    queueMicrotask(() => teamTrigger?.focus());
  }

  async function chooseBrain(brain) {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId || controlsDisabled || $modelContext.phase === 'saving') return;
    if (brain.provider === $modelContext.provider && brain.model === $modelContext.model) {
      close(brainDialog, brainTrigger);
      return;
    }
    try {
      await selectTeamBrain(fetch, teamId, brain.provider, brain.model);
      close(brainDialog, brainTrigger);
    } catch {
      // The shared model context owns the bounded visible error.
    }
  }

  async function openAssistantStore() {
    assistantDialog?.close();
    const next = new URL('/assistants/', page.url);
    if ($teamContext.selectedTeamId) next.searchParams.set('team', $teamContext.selectedTeamId);
    await goto(next);
  }

</script>

<div class="context-controls" aria-label={copy.contextAria}>
  <Button
    bind:element={teamTrigger}
    variant="ghost"
    class="context-trigger"
    type="button"
    onclick={() => open(teamDialog)}
    disabled={controlsDisabled}
    aria-haspopup="dialog"
  >
    <span>{copy.team}</span>
    <strong>{activeTeam?.name ?? copy.noTeam}</strong>
  </Button>
  <Button
    bind:element={brainTrigger}
    variant="ghost"
    class="context-trigger"
    type="button"
    onclick={() => open(brainDialog)}
    disabled={controlsDisabled || !activeTeam || $modelContext.phase === 'idle'}
    aria-haspopup="dialog"
  >
    <span>{copy.brain}</span>
    <strong>{selectedBrain?.title ?? copy.modelLoading}</strong>
  </Button>
  <Button
    bind:element={assistantTrigger}
    variant="ghost"
    class="context-trigger"
    type="button"
    onclick={() => open(assistantDialog)}
    disabled={controlsDisabled || !activeTeam}
    aria-haspopup="dialog"
  >
    <span>{copy.assistants}</span>
    <strong>{assistantCount}</strong>
  </Button>
</div>

<Modal bind:element={teamDialog} labelledBy="chat-team-dialog-title" oncancel={(event) => cancelDialog(event, teamDialog, teamTrigger)}>
  <DialogFrame kicker={copy.teamKicker} title={copy.teamTitle} titleId="chat-team-dialog-title" lead={copy.teamLead}>
    <ul class="choice-list" aria-labelledby="chat-team-dialog-title">
      {#each $teamContext.teams as team (team.id)}
        <li class="team-choice">
          <ChoiceItem
            title={team.name}
            description={team.id}
            meta={team.id === $teamContext.selectedTeamId ? copy.current : undefined}
            selected={team.id === $teamContext.selectedTeamId}
            onclick={() => chooseTeam(team.id)}
          />
          <Button
            variant="danger"
            size="compact"
            type="button"
            aria-label={$t('chatContext.deleteTeamNamed', { name: team.name })}
            onclick={() => openDelete(team)}
          >{copy.deleteTeam}</Button>
        </li>
      {/each}
    </ul>
    {#snippet footer()}
      <Button variant="secondary" type="button" onclick={() => close(teamDialog, teamTrigger)}>{copy.close}</Button>
      <Button type="button" onclick={openCreate}>{copy.addTeam}</Button>
    {/snippet}
  </DialogFrame>
</Modal>

<Modal bind:element={brainDialog} labelledBy="chat-brain-dialog-title" oncancel={(event) => cancelDialog(event, brainDialog, brainTrigger)}>
  <DialogFrame kicker={copy.brainKicker} title={copy.brainTitle} titleId="chat-brain-dialog-title" lead={copy.brainLead}>
    {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
      <p class="dialog-status" role="status">{copy.modelLoading}</p>
    {:else}
      <ul class="choice-list" aria-labelledby="chat-brain-dialog-title">
        {#each brainOptions as brain (brain.value)}
          <li>
            <ChoiceItem
              title={brain.title}
              description={brain.providerTitle}
              selected={brain.value === selectedBrain?.value}
              disabled={$modelContext.phase === 'saving'}
              onclick={() => chooseBrain(brain)}
            />
          </li>
        {/each}
      </ul>
    {/if}
    {#if $modelContext.error}<Notice variant="error">{copy.modelFailed}</Notice>{/if}
    {#snippet footer()}<Button variant="secondary" type="button" onclick={() => close(brainDialog, brainTrigger)}>{copy.close}</Button>{/snippet}
  </DialogFrame>
</Modal>

<Modal size="lg" bind:element={assistantDialog} labelledBy="chat-assistant-dialog-title" oncancel={(event) => cancelDialog(event, assistantDialog, assistantTrigger)}>
  <DialogFrame kicker={copy.assistantKicker} title={copy.assistantTitle} titleId="chat-assistant-dialog-title" lead={copy.assistantLead}>
    {#if runningAssistants.length > 0}
      <div class="bulk-actions">
        <TextAction type="button" onclick={selectAllTeamAssistants}>
          {#snippet icon()}
            <svg viewBox="0 0 24 24" focusable="false"><path d="m4 12 4 4L19 5"/><path d="M4 20h16"/></svg>
          {/snippet}
          {assistantLimitApplies
            ? $t('chatContext.selectMaximum', { limit: MAX_SELECTED_ASSISTANTS })
            : copy.selectAll}
        </TextAction>
        <TextAction type="button" onclick={unselectAllTeamAssistants}>
          {#snippet icon()}
            <svg viewBox="0 0 24 24" focusable="false"><path d="M5 5l14 14M19 5 5 19"/></svg>
          {/snippet}
          {copy.unselectAll}
        </TextAction>
      </div>
    {/if}
    {#if assistantLimitApplies}
      <p class="selection-limit">
        {$t('chatContext.selectionLimit', { limit: MAX_SELECTED_ASSISTANTS })}
      </p>
    {/if}
    {#if runningAssistants.length > 0}
      <fieldset class="assistant-choices">
        <legend class="sr-only">{copy.assistantTitle}</legend>
        {#each runningAssistants as assistant (assistant.id)}
          {@const selected = $teamContext.selectedAssistantIds.includes(assistant.id)}
          {#snippet leading()}
            <AssistantIcon
              assistant={assistant.id}
              src={`/api/teams/${$teamContext.selectedTeamId}/assistants/${assistant.id}/icon`}
              size={34}
            />
          {/snippet}
          {#snippet trailing()}
            {#if selected}<span class="selection-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="m5 12.5 4.2 4.2L19 7" />
              </svg>
            </span>{/if}
          {/snippet}
          <ChoiceItem
            title={assistant.name}
            {selected}
            {leading}
            {trailing}
            disabled={!selected && selectedCount >= MAX_SELECTED_ASSISTANTS}
            onclick={() => toggleTeamAssistant(assistant.id)}
          />
        {/each}
      </fieldset>
    {:else}
      <p class="dialog-status">{copy.assistantEmpty}</p>
    {/if}
    {#snippet footer()}
      <Button variant="secondary" type="button" onclick={() => close(assistantDialog, assistantTrigger)}>{copy.close}</Button>
      <Button type="button" onclick={openAssistantStore}>{copy.openStore}</Button>
    {/snippet}
  </DialogFrame>
</Modal>

<Modal
  bind:element={deleteDialog}
  labelledBy="chat-delete-team-title"
  oncancel={cancelDelete}
>
  <form onsubmit={submitDelete}>
    <DialogFrame
      kicker={copy.deleteKicker}
      title={copy.deleteTitle}
      titleId="chat-delete-team-title"
      lead={$t('chatContext.deleteLead', { name: deletingTeam?.name ?? '' })}
    >
    <TextField
        id="chat-delete-team-name"
        label={copy.deleteName}
        type="text"
        bind:value={deleteName}
        placeholder={$t('chatContext.deleteNamePlaceholder', { name: deletingTeam?.name ?? '' })}
        maxlength="80"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        required
        disabled={deleting}
      />
    <TextField
        id="chat-delete-team-password"
        label={copy.supervisorPassword}
        type="password"
        bind:value={supervisorPassword}
        placeholder={copy.passwordPlaceholder}
        maxlength="4096"
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
      <Button variant="secondary" type="button" onclick={closeDelete} disabled={deleting}>{copy.cancel}</Button>
      <Button
        variant="danger"
        type="submit"
        disabled={deleting || !deletingTeam || deleteName !== deletingTeam.name || !supervisorPassword}
      >{deleting ? copy.deleting : copy.deleteAction}</Button>
    {/snippet}
    </DialogFrame>
  </form>
</Modal>

<Modal bind:element={createDialog} labelledBy="chat-create-team-title" oncancel={cancelCreate} onclose={recoverRequiredCreate}>
  <form onsubmit={submitCreate}>
    <DialogFrame kicker={copy.createKicker} title={copy.createTitle} titleId="chat-create-team-title" lead={copy.createLead}>
    <TextField
        id="chat-create-team-name"
        label={copy.teamName}
        type="text"
        bind:value={teamName}
        placeholder={copy.teamPlaceholder}
        maxlength="80"
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        required
        disabled={creating}
      />
    {#if dialogError}<Notice variant="error">{dialogError}</Notice>{/if}
    {#snippet footer()}
      {#if !requiresTeam}
        <Button variant="secondary" type="button" onclick={closeCreate} disabled={creating}>{copy.cancel}</Button>
      {/if}
      <Button type="submit" disabled={creating || !teamName.trim()}>{creating ? copy.creating : copy.create}</Button>
    {/snippet}
    </DialogFrame>
  </form>
</Modal>

<style>
  .context-controls { display: grid; min-width: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; padding: 1px; background: var(--border-strong); }
  :global(.context-trigger) { width: 100%; min-width: 0; justify-content: flex-start; padding: 0.45rem 0.6rem; text-align: start; clip-path: none; }
  :global(.context-trigger > span) { display: grid; min-width: 0; gap: 0.1rem; justify-items: start; }
  :global(.context-trigger > span > span) { color: var(--accent); font: 700 0.53rem/1.2 var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; }
  :global(.context-trigger > span > strong) { max-width: 100%; overflow: hidden; font: 500 0.68rem/1.3 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  form { margin: 0; }
  .choice-list { display: grid; min-height: 0; gap: 0.4rem; margin: 0; padding: 0; overflow: auto; list-style: none; }
  .choice-list > li { min-width: 0; }
  .team-choice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.4rem; }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .bulk-actions :global(svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: square; stroke-linejoin: bevel; }
  .selection-limit { margin: -0.45rem 0 0; color: var(--text-faint); font-size: 0.64rem; line-height: 1.45; }
  .assistant-choices { display: grid; min-width: 0; gap: 1px; margin: 0; border: 0; padding: 0.45rem 0; }
  .selection-mark { display: grid; place-items: center; color: var(--success); }
  .selection-mark svg { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 2; }
  .dialog-status { margin: 0; color: var(--text-faint); font-size: 0.7rem; line-height: 1.5; }
  @media (max-width: 640px) { :global(.context-trigger) { padding: 0.4rem; } :global(.context-trigger > span > span) { font-size: 0.48rem; } :global(.context-trigger > span > strong) { font-size: 0.58rem; } }
</style>
