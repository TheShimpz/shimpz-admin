<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import AssistantIcon from '$lib/AssistantIcon.svelte';
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
  let adminPassword = $state('');
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
    adminPassword = '';
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
    if (deleting || !target || deleteName !== target.name || !adminPassword) return;
    deleting = true;
    deleteError = '';
    deleteErrorDetail = '';
    let deleted = false;
    try {
      await deleteTeam(fetch, target.id, deleteName, adminPassword);
      deleted = true;
    } catch (error) {
      const known = error instanceof LocalApiError;
      const wrongPassword = known && error.status === 403 && error.message === 'admin password is incorrect';
      deleteError = wrongPassword
        ? copy.wrongPassword
        : copy.deleteFailed;
      deleteErrorDetail = known && !wrongPassword
        ? `${error.status > 0 ? `HTTP ${error.status} · ` : ''}${error.message}`
        : '';
      adminPassword = '';
    } finally {
      deleting = false;
    }
    if (!deleted) return;

    resetDeleteForm();
    deleteDialog?.close();
    deletingTeam = undefined;
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
  <button
    bind:this={teamTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(teamDialog)}
    disabled={controlsDisabled}
    aria-haspopup="dialog"
  >
    <span>{copy.team}</span>
    <strong>{activeTeam?.name ?? copy.noTeam}</strong>
  </button>
  <button
    bind:this={brainTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(brainDialog)}
    disabled={controlsDisabled || !activeTeam || $modelContext.phase === 'idle'}
    aria-haspopup="dialog"
  >
    <span>{copy.brain}</span>
    <strong>{selectedBrain?.title ?? copy.modelLoading}</strong>
  </button>
  <button
    bind:this={assistantTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(assistantDialog)}
    disabled={controlsDisabled || !activeTeam}
    aria-haspopup="dialog"
  >
    <span>{copy.assistants}</span>
    <strong>{assistantCount}</strong>
  </button>
</div>

<dialog bind:this={teamDialog} aria-labelledby="chat-team-dialog-title" oncancel={(event) => cancelDialog(event, teamDialog, teamTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.teamKicker}</p>
      <h2 id="chat-team-dialog-title">{copy.teamTitle}</h2>
      <span>{copy.teamLead}</span>
    </header>
    <ul class="choice-list" aria-labelledby="chat-team-dialog-title">
      {#each $teamContext.teams as team (team.id)}
        <li class="team-choice">
          <button
            class="choice-button"
            type="button"
            class:active={team.id === $teamContext.selectedTeamId}
            aria-pressed={team.id === $teamContext.selectedTeamId}
            onclick={() => chooseTeam(team.id)}
          >
            <strong>{team.name}</strong>
            {#if team.id === $teamContext.selectedTeamId}<small>{copy.current}</small>{/if}
          </button>
          <button
            class="danger-action"
            type="button"
            aria-label={$t('chatContext.deleteTeamNamed', { name: team.name })}
            onclick={() => openDelete(team)}
          >{copy.deleteTeam}</button>
        </li>
      {/each}
    </ul>
    <footer>
      <button class="secondary" type="button" onclick={() => close(teamDialog, teamTrigger)}>{copy.close}</button>
      <button class="primary" type="button" onclick={openCreate}>{copy.addTeam}</button>
    </footer>
  </div>
</dialog>

<dialog bind:this={brainDialog} aria-labelledby="chat-brain-dialog-title" oncancel={(event) => cancelDialog(event, brainDialog, brainTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.brainKicker}</p>
      <h2 id="chat-brain-dialog-title">{copy.brainTitle}</h2>
      <span>{copy.brainLead}</span>
    </header>
    {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
      <p class="dialog-status" role="status">{copy.modelLoading}</p>
    {:else}
      <ul class="choice-list" aria-labelledby="chat-brain-dialog-title">
        {#each brainOptions as brain (brain.value)}
          <li>
            <button
              class="choice-button"
              type="button"
              class:active={brain.value === selectedBrain?.value}
              aria-pressed={brain.value === selectedBrain?.value}
              disabled={$modelContext.phase === 'saving'}
              onclick={() => chooseBrain(brain)}
            >
              <span><strong>{brain.title}</strong><small>{brain.providerTitle}</small></span>
              {#if brain.value === selectedBrain?.value}<small>{copy.current}</small>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if $modelContext.error}<p class="dialog-error" role="alert">{copy.modelFailed}</p>{/if}
    <footer><button class="secondary" type="button" onclick={() => close(brainDialog, brainTrigger)}>{copy.close}</button></footer>
  </div>
</dialog>

<dialog bind:this={assistantDialog} aria-labelledby="chat-assistant-dialog-title" oncancel={(event) => cancelDialog(event, assistantDialog, assistantTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.assistantKicker}</p>
      <h2 id="chat-assistant-dialog-title">{copy.assistantTitle}</h2>
      <span>{copy.assistantLead}</span>
    </header>
    {#if runningAssistants.length > 0}
      <div class="bulk-actions">
        <button type="button" onclick={selectAllTeamAssistants}>
          {assistantLimitApplies
            ? $t('chatContext.selectMaximum', { limit: MAX_SELECTED_ASSISTANTS })
            : copy.selectAll}
        </button>
        <button type="button" onclick={unselectAllTeamAssistants}>{copy.unselectAll}</button>
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
          <div
            class="assistant-choice"
            class:selected
          >
            <label class:blocked={!selected && selectedCount >= MAX_SELECTED_ASSISTANTS}>
              <input
                class="sr-only"
                type="checkbox"
                checked={selected}
                disabled={!selected && selectedCount >= MAX_SELECTED_ASSISTANTS}
                onchange={() => toggleTeamAssistant(assistant.id)}
              />
              <AssistantIcon assistant={assistant.id} size={34} />
              <strong>{assistant.name}</strong>
            </label>
            <span class="selection-mark" class:visible={selected} aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="m5 12.5 4.2 4.2L19 7" />
              </svg>
            </span>
          </div>
        {/each}
      </fieldset>
    {:else}
      <p class="dialog-status">{copy.assistantEmpty}</p>
    {/if}
    <footer>
      <button class="secondary" type="button" onclick={() => close(assistantDialog, assistantTrigger)}>{copy.close}</button>
      <button class="primary" type="button" onclick={openAssistantStore}>{copy.openStore}</button>
    </footer>
  </div>
</dialog>

<dialog
  bind:this={deleteDialog}
  aria-labelledby="chat-delete-team-title"
  aria-describedby="chat-delete-team-lead"
  oncancel={cancelDelete}
>
  <form class="dialog-panel delete-panel" onsubmit={submitDelete}>
    <header>
      <p>{copy.deleteKicker}</p>
      <h2 id="chat-delete-team-title">{copy.deleteTitle}</h2>
      <span id="chat-delete-team-lead">
        {$t('chatContext.deleteLead', { name: deletingTeam?.name ?? '' })}
      </span>
    </header>
    <label class="field" for="chat-delete-team-name">
      <span>{copy.deleteName}</span>
      <input
        id="chat-delete-team-name"
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
    </label>
    <label class="field" for="chat-delete-team-password">
      <span>{copy.adminPassword}</span>
      <input
        id="chat-delete-team-password"
        type="password"
        bind:value={adminPassword}
        placeholder={copy.passwordPlaceholder}
        maxlength="4096"
        autocomplete="current-password"
        required
        disabled={deleting}
      />
    </label>
    {#if deleteError}
      <div class="dialog-error" role="alert">
        <strong>{deleteError}</strong>
        {#if deleteErrorDetail}<code>{copy.technicalDetail}: {deleteErrorDetail}</code>{/if}
      </div>
    {/if}
    <footer>
      <button class="secondary" type="button" onclick={closeDelete} disabled={deleting}>{copy.cancel}</button>
      <button
        class="danger"
        type="submit"
        disabled={deleting || !deletingTeam || deleteName !== deletingTeam.name || !adminPassword}
      >{deleting ? copy.deleting : copy.deleteAction}</button>
    </footer>
  </form>
</dialog>

<dialog bind:this={createDialog} aria-labelledby="chat-create-team-title" oncancel={cancelCreate}>
  <form class="dialog-panel" onsubmit={submitCreate}>
    <header>
      <p>{copy.createKicker}</p>
      <h2 id="chat-create-team-title">{copy.createTitle}</h2>
      <span>{copy.createLead}</span>
    </header>
    <label class="field" for="chat-create-team-name">
      <span>{copy.teamName}</span>
      <input
        id="chat-create-team-name"
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
    </label>
    {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}
    <footer>
      {#if !requiresTeam}
        <button class="secondary" type="button" onclick={closeCreate} disabled={creating}>{copy.cancel}</button>
      {/if}
      <button class="primary" type="submit" disabled={creating || !teamName.trim()}>{creating ? copy.creating : copy.create}</button>
    </footer>
  </form>
</dialog>

<style>
  .context-controls {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    padding: 1px;
    background: var(--border-strong);
  }

  .context-trigger {
    display: grid;
    min-width: 0;
    min-height: 2.55rem;
    align-content: center;
    gap: 0.1rem;
    border: 0;
    padding: 0.45rem 0.65rem;
    background: #050708;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }

  .context-trigger:hover { background: rgba(0, 240, 255, 0.055); }
  .context-trigger:disabled { cursor: not-allowed; opacity: 0.4; }
  .context-trigger span { color: var(--accent); font-family: var(--font-mono); font-size: 0.47rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
  .context-trigger strong { overflow: hidden; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }

  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  dialog {
    width: min(32rem, calc(100dvw - 1rem));
    max-height: calc(100dvh - 2rem);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  dialog::backdrop { background: rgba(0, 0, 0, 0.82); backdrop-filter: blur(8px); }

  .dialog-panel {
    --dialog-pad: clamp(1.25rem, 4vw, 2rem);
    display: grid;
    max-height: calc(100dvh - 2rem);
    gap: 1rem;
    padding: var(--dialog-pad);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    overflow: auto;
  }

  header { display: grid; gap: 0.45rem; }
  header p { margin: 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
  header h2 { margin: 0; font-size: clamp(1.4rem, 4vw, 2.1rem); letter-spacing: -0.05em; }
  header span { color: var(--text-dim); font-size: 0.74rem; line-height: 1.55; }

  .choice-list { display: grid; gap: 0.4rem; min-height: 0; margin: 0; padding: 0; overflow: auto; list-style: none; }
  .choice-list > li { min-width: 0; }
  .choice-button {
    display: flex;
    width: 100%;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border: 1px solid var(--border-strong);
    padding: 0.65rem 0.8rem;
    background: #050708;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }
  .choice-button:hover, .choice-button.active { border-color: var(--accent); background: rgba(0, 240, 255, 0.05); }
  .choice-button > span { display: grid; gap: 0.15rem; }
  .choice-list strong { font-size: 0.75rem; }
  .choice-list small { color: var(--accent); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.07em; text-transform: uppercase; }

  .team-choice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.4rem; }
  .danger-action {
    min-width: 4.5rem;
    border: 1px solid rgba(255, 46, 99, 0.42);
    padding: 0 0.65rem;
    background: rgba(255, 46, 99, 0.035);
    color: var(--danger);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.5rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .danger-action:hover { border-color: var(--danger); background: rgba(255, 46, 99, 0.1); }

  .bulk-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .bulk-actions button {
    min-height: 2rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.65rem;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.52rem;
    text-transform: uppercase;
  }

  .selection-limit { margin: -0.45rem 0 0; color: var(--text-faint); font-size: 0.64rem; line-height: 1.45; }

  .assistant-choices {
    display: grid;
    min-width: 0;
    gap: 1px;
    margin: 0 calc(0px - var(--dialog-pad));
    border: 0;
    border-block: 1px solid var(--border-strong);
    padding: 0.45rem 0;
  }
  .assistant-choice { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) 2.5rem; align-items: stretch; gap: 0; padding: 0 var(--dialog-pad); background: transparent; }
  .assistant-choice.selected { background: rgba(0, 240, 255, 0.065); }
  .assistant-choice:focus-within strong { color: var(--accent); }
  .assistant-choice label { display: grid; min-width: 0; min-height: 3.2rem; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.65rem; padding: 0.5rem 0.7rem; background: transparent; cursor: pointer; }
  .assistant-choice label.blocked { cursor: not-allowed; opacity: 0.42; }
  .assistant-choice strong { overflow: hidden; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
  .selection-mark { display: grid; place-items: center; color: var(--success); opacity: 0; }
  .selection-mark.visible { opacity: 1; }
  .selection-mark svg { width: 1.15rem; height: 1.15rem; fill: none; filter: drop-shadow(0 0 5px rgba(5, 255, 161, 0.42)); stroke: currentColor; stroke-linecap: square; stroke-linejoin: miter; stroke-width: 2; }

  .dialog-status, .dialog-error { margin: 0; color: var(--text-faint); font-size: 0.7rem; line-height: 1.5; }
  .dialog-error { display: grid; gap: 0.25rem; color: var(--danger); }
  .dialog-error strong { font-weight: 600; }
  .dialog-error code { color: var(--text-faint); font-size: 0.6rem; white-space: normal; overflow-wrap: anywhere; }
  .field { display: grid; gap: 0.35rem; }
  .field > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .field input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: #020304; color: var(--text); font-family: var(--font-mono); }

  footer {
    display: flex;
    gap: 0;
    margin: 0 calc(0px - var(--dialog-pad)) calc(0px - var(--dialog-pad));
  }
  footer button { width: 100%; min-height: 2.9rem; flex: 1 1 0; border: 0; padding: 0 0.9rem; cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  footer button + button { box-shadow: inset 1px 0 0 var(--border-strong); }
  footer .secondary { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-dim); }
  footer .primary { background: var(--accent); color: #001013; }
  footer .danger { background: var(--danger); color: #160007; }
  footer button:disabled { cursor: not-allowed; opacity: 0.42; }

  @media (max-width: 640px) {
    .context-trigger { min-height: 2.4rem; padding: 0.35rem 0.4rem; }
    .context-trigger span { font-size: 0.4rem; letter-spacing: 0.06em; }
    .context-trigger strong { font-size: 0.52rem; }
  }
</style>
