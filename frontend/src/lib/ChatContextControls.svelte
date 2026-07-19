<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import AssistantIcon from '$lib/AssistantIcon.svelte';
  import { locale } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain } from '$lib/modelContext.js';
  import {
    createTeam,
    selectAllTeamAssistants,
    selectOnlyTeamAssistant,
    teamContext,
    toggleTeamAssistant,
    unselectAllTeamAssistants,
  } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  const COPY = {
    en: {
      team: 'Team', noTeam: 'Create Team', teamTitle: 'Choose a Team', teamLead: 'Change the private workspace for this conversation.',
      addTeam: 'Add Team', createTitle: 'Create a Team', createLead: 'Give this isolated local workspace a clear name.',
      teamName: 'Team name', teamPlaceholder: 'Marketing', create: 'Create Team', creating: 'Creating…',
      brain: 'Brain', brainTitle: 'Choose a Brain', brainLead: 'Select the model that coordinates this Team.', modelLoading: 'Loading model settings…',
      assistants: 'Assistants', assistantTitle: 'Choose Assistants', assistantLead: 'Only selected Assistants can lend Powers to the next turns.',
      assistantEmpty: 'No running Assistants are available in this Team.', selectAll: 'Select all', unselectAll: 'Unselect all', onlyThis: 'Only this',
      selected: '{selected} of {total}', current: 'Current', close: 'Close', cancel: 'Cancel',
    },
    pt: {
      team: 'Time', noTeam: 'Criar Time', teamTitle: 'Escolha um Time', teamLead: 'Troque o ambiente privado desta conversa.',
      addTeam: 'Adicionar Time', createTitle: 'Criar um Time', createLead: 'Dê um nome claro para este ambiente local isolado.',
      teamName: 'Nome do Time', teamPlaceholder: 'Marketing', create: 'Criar Time', creating: 'Criando…',
      brain: 'Brain', brainTitle: 'Escolha um Brain', brainLead: 'Selecione o modelo que coordena este Time.', modelLoading: 'Carregando modelos…',
      assistants: 'Assistants', assistantTitle: 'Escolha os Assistants', assistantLead: 'Somente os Assistants selecionados podem fornecer Powers nos próximos turnos.',
      assistantEmpty: 'Nenhum Assistant em execução está disponível neste Time.', selectAll: 'Selecionar todos', unselectAll: 'Desmarcar todos', onlyThis: 'Somente este',
      selected: '{selected} de {total}', current: 'Atual', close: 'Fechar', cancel: 'Cancelar',
    },
  };

  let teamDialog = $state();
  let brainDialog = $state();
  let assistantDialog = $state();
  let createDialog = $state();
  let teamTrigger = $state();
  let brainTrigger = $state();
  let assistantTrigger = $state();
  let teamName = $state('');
  let creating = $state(false);
  let dialogError = $state('');

  let copy = $derived($locale === 'pt' ? COPY.pt : COPY.en);
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
  let assistantCount = $derived(
    copy.selected
      .replace('{selected}', String(selectedCount))
      .replace('{total}', String(runningAssistants.length)),
  );
  let controlsDisabled = $derived(disabled || $teamContext.phase === 'loading');

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
    if (!creating) close(createDialog, teamTrigger);
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
    } catch (error) {
      dialogError = error instanceof Error ? error.message : 'The Team could not be created.';
    } finally {
      creating = false;
    }
  }

  async function chooseBrain(brain) {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId || controlsDisabled || $modelContext.phase === 'saving') return;
    try {
      await selectTeamBrain(fetch, teamId, brain.provider, brain.model);
      close(brainDialog, brainTrigger);
    } catch {
      // The shared model context owns the bounded visible error.
    }
  }
</script>

<div class="context-controls" aria-label="Chat context">
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
      <p>Team // context</p>
      <h2 id="chat-team-dialog-title">{copy.teamTitle}</h2>
      <span>{copy.teamLead}</span>
    </header>
    <div class="choice-list" role="radiogroup" aria-labelledby="chat-team-dialog-title">
      {#each $teamContext.teams as team (team.id)}
        <button
          type="button"
          class:active={team.id === $teamContext.selectedTeamId}
          role="radio"
          aria-checked={team.id === $teamContext.selectedTeamId}
          onclick={() => chooseTeam(team.id)}
        >
          <strong>{team.name}</strong>
          {#if team.id === $teamContext.selectedTeamId}<small>{copy.current}</small>{/if}
        </button>
      {/each}
    </div>
    <footer>
      <button class="secondary" type="button" onclick={() => close(teamDialog, teamTrigger)}>{copy.close}</button>
      <button class="primary" type="button" onclick={openCreate}>{copy.addTeam}</button>
    </footer>
  </div>
</dialog>

<dialog bind:this={brainDialog} aria-labelledby="chat-brain-dialog-title" oncancel={(event) => cancelDialog(event, brainDialog, brainTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>Brain // context</p>
      <h2 id="chat-brain-dialog-title">{copy.brainTitle}</h2>
      <span>{copy.brainLead}</span>
    </header>
    {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
      <p class="dialog-status" role="status">{copy.modelLoading}</p>
    {:else}
      <div class="choice-list" role="radiogroup" aria-labelledby="chat-brain-dialog-title">
        {#each brainOptions as brain (brain.value)}
          <button
            type="button"
            class:active={brain.value === selectedBrain?.value}
            role="radio"
            aria-checked={brain.value === selectedBrain?.value}
            disabled={$modelContext.phase === 'saving'}
            onclick={() => chooseBrain(brain)}
          >
            <span><strong>{brain.title}</strong><small>{brain.providerTitle}</small></span>
            {#if brain.value === selectedBrain?.value}<small>{copy.current}</small>{/if}
          </button>
        {/each}
      </div>
    {/if}
    {#if $modelContext.error}<p class="dialog-error" role="alert">{$modelContext.error}</p>{/if}
    <footer><button class="secondary" type="button" onclick={() => close(brainDialog, brainTrigger)}>{copy.close}</button></footer>
  </div>
</dialog>

<dialog bind:this={assistantDialog} aria-labelledby="chat-assistant-dialog-title" oncancel={(event) => cancelDialog(event, assistantDialog, assistantTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>Assistants // context</p>
      <h2 id="chat-assistant-dialog-title">{copy.assistantTitle}</h2>
      <span>{copy.assistantLead}</span>
    </header>
    <div class="bulk-actions">
      <button type="button" onclick={selectAllTeamAssistants}>{copy.selectAll}</button>
      <button type="button" onclick={unselectAllTeamAssistants}>{copy.unselectAll}</button>
    </div>
    {#if runningAssistants.length > 0}
      <fieldset class="assistant-choices">
        <legend class="visually-hidden">{copy.assistantTitle}</legend>
        {#each runningAssistants as assistant (assistant.id)}
          <div class="assistant-choice">
            <label>
              <input
                type="checkbox"
                checked={$teamContext.selectedAssistantIds.includes(assistant.id)}
                onchange={() => toggleTeamAssistant(assistant.id)}
              />
              <span class="checkmark" aria-hidden="true"></span>
              <AssistantIcon assistant={assistant.id} size={34} />
              <strong>{assistant.name}</strong>
            </label>
            <button type="button" onclick={() => selectOnlyTeamAssistant(assistant.id)}>{copy.onlyThis}</button>
          </div>
        {/each}
      </fieldset>
    {:else}
      <p class="dialog-status">{copy.assistantEmpty}</p>
    {/if}
    <footer><button class="primary" type="button" onclick={() => close(assistantDialog, assistantTrigger)}>{copy.close}</button></footer>
  </div>
</dialog>

<dialog bind:this={createDialog} aria-labelledby="chat-create-team-title" oncancel={cancelCreate}>
  <form class="dialog-panel" onsubmit={submitCreate}>
    <header>
      <p>Team // initialize</p>
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
      <button class="secondary" type="button" onclick={closeCreate} disabled={creating}>{copy.cancel}</button>
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

  button:focus-visible,
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
    display: grid;
    max-height: calc(100dvh - 2rem);
    gap: 1rem;
    padding: clamp(1.25rem, 4vw, 2rem);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    overflow: auto;
  }

  header { display: grid; gap: 0.45rem; }
  header p { margin: 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
  header h2 { margin: 0; font-size: clamp(1.4rem, 4vw, 2.1rem); letter-spacing: -0.05em; }
  header span { color: var(--text-dim); font-size: 0.74rem; line-height: 1.55; }

  .choice-list { display: grid; gap: 0.4rem; min-height: 0; overflow: auto; }
  .choice-list > button {
    display: flex;
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
  .choice-list > button:hover, .choice-list > button.active { border-color: var(--accent); background: rgba(0, 240, 255, 0.05); }
  .choice-list > button > span { display: grid; gap: 0.15rem; }
  .choice-list strong { font-size: 0.75rem; }
  .choice-list small { color: var(--accent); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.07em; text-transform: uppercase; }

  .bulk-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .bulk-actions button, .assistant-choice > button {
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

  .assistant-choices { display: grid; gap: 0.4rem; min-width: 0; margin: 0; border: 0; padding: 0; }
  .assistant-choice { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; }
  .assistant-choice label { display: grid; min-width: 0; min-height: 3.2rem; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 0.65rem; padding: 0.5rem 0.7rem; background: #050708; cursor: pointer; }
  .assistant-choice input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .checkmark { display: grid; width: 1rem; height: 1rem; place-items: center; border: 1px solid var(--border-strong); color: var(--accent-ink); }
  input:checked + .checkmark { border-color: var(--accent); background: var(--accent); }
  input:checked + .checkmark::after { content: '✓'; font-size: 0.65rem; }
  input:focus-visible + .checkmark { outline: 2px solid var(--accent); outline-offset: 2px; }
  .assistant-choice strong { overflow: hidden; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }

  .dialog-status, .dialog-error { margin: 0; color: var(--text-faint); font-size: 0.7rem; line-height: 1.5; }
  .dialog-error { color: var(--danger); }
  .field { display: grid; gap: 0.35rem; }
  .field > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .field input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: #020304; color: var(--text); font-family: var(--font-mono); }

  footer { display: flex; justify-content: flex-end; gap: 0.6rem; }
  footer button { min-height: 2.6rem; border: 0; padding: 0 0.9rem; cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  footer .secondary { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-dim); }
  footer .primary { background: var(--accent); color: #001013; }
  footer button:disabled { cursor: not-allowed; opacity: 0.42; }

  @media (max-width: 640px) {
    .context-controls {
      grid-auto-columns: minmax(8rem, 1fr);
      grid-auto-flow: column;
      grid-template-columns: none;
      overflow-x: auto;
      overscroll-behavior-inline: contain;
    }
    footer { align-items: stretch; flex-direction: column-reverse; }
  }
</style>
