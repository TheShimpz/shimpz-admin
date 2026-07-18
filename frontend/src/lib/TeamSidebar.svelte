<script>
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import AssistantIcon from '$lib/AssistantIcon.svelte';
  import { assistantStoreHref } from '$lib/assistantIntent.js';
  import { locale } from '$lib/i18n.js';
  import {
    createTeam,
    loadTeamContext,
    selectTeam,
    teamContext,
    toggleTeamFile,
  } from '$lib/teamContext.js';

  let { active = '' } = $props();

  const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
  const COPY = {
    en: {
      sidebar: 'Team workspace',
      team: 'Team',
      selectTeam: 'Choose a Team',
      loading: 'Loading local Team…',
      assistants: 'Assistants',
      assistantEmpty: 'No Assistants installed.',
      storeDetail: 'Open {name} in the Store',
      files: 'Files',
      fileEmpty: 'No Team files yet.',
      fileHelp: 'Select up to 8 files for the next message.',
      fileReadOnly: 'Files can be attached from Chat.',
      retry: 'Retry local data',
      create: 'Create Team',
      createTitle: 'Create your first Team',
      createLead: 'Give this isolated local workspace a clear name.',
      name: 'Team name',
      placeholder: 'Marketing',
      cancel: 'Cancel',
      creating: 'Creating…',
      createAction: 'Create Team',
    },
    pt: {
      sidebar: 'Área do Time',
      team: 'Time',
      selectTeam: 'Escolha um Time',
      loading: 'Carregando Time local…',
      assistants: 'Assistants',
      assistantEmpty: 'Nenhum Assistant instalado.',
      storeDetail: 'Abrir {name} na Store',
      files: 'Arquivos',
      fileEmpty: 'Ainda não há arquivos neste Time.',
      fileHelp: 'Selecione até 8 arquivos para a próxima mensagem.',
      fileReadOnly: 'Os arquivos podem ser anexados pelo Chat.',
      retry: 'Tentar dados locais novamente',
      create: 'Criar Time',
      createTitle: 'Crie seu primeiro Time',
      createLead: 'Dê um nome claro para este ambiente local isolado.',
      name: 'Nome do Time',
      placeholder: 'Marketing',
      cancel: 'Cancelar',
      creating: 'Criando…',
      createAction: 'Criar Time',
    },
  };

  let createDialog = $state();
  let teamName = $state('');
  let creating = $state(false);
  let dialogError = $state('');

  let copy = $derived($locale === 'pt' ? COPY.pt : COPY.en);
  let storeLocale = $derived($locale === 'pt' ? 'pt' : 'en');
  let requestedTeamId = $derived.by(() => {
    const candidate = page.url.searchParams.get('capsule') ?? '';
    return TEAM_ID_RE.test(candidate) ? candidate : '';
  });
  let installed = $derived.by(() => {
    const catalog = new Map($teamContext.catalog.map((assistant) => [assistant.id, assistant]));
    return $teamContext.installedAssistants.map((runtime) => {
      const assistant = catalog.get(runtime.assistant);
      return {
        id: runtime.assistant,
        name: assistant?.name ?? runtime.assistant,
        status: runtime.status,
        href: assistantStoreHref(storeLocale, runtime.assistant),
      };
    });
  });

  function updateLocationTeam(id) {
    const next = new URL(page.url);
    next.searchParams.set('capsule', id);
    replaceState(next, page.state);
  }

  async function changeTeam(event) {
    const id = event.currentTarget.value;
    if (!id || id === $teamContext.selectedTeamId) return;
    const previousId = $teamContext.selectedTeamId;
    updateLocationTeam(id);
    try {
      await selectTeam(fetch, id);
    } catch {
      if (previousId) updateLocationTeam(previousId);
      // The store exposes a safe, localized-ready error state next to the selector.
    }
  }

  function openCreateDialog() {
    teamName = '';
    dialogError = '';
    createDialog?.showModal();
  }

  function closeCreateDialog() {
    if (creating) return;
    createDialog?.close();
  }

  function cancelCreateDialog(event) {
    event.preventDefault();
    closeCreateDialog();
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (creating || !teamName.trim()) return;
    creating = true;
    dialogError = '';
    try {
      const created = await createTeam(fetch, teamName);
      createDialog?.close();
      window.location.assign(`/assistants/?capsule=${encodeURIComponent(created.id)}`);
    } catch (error) {
      dialogError = error instanceof Error ? error.message : 'The Team could not be created.';
    } finally {
      creating = false;
    }
  }

  async function retry() {
    try {
      await loadTeamContext(fetch, $teamContext.selectedTeamId);
    } catch {
      // The shared context owns the visible fail-closed error state.
    }
  }

  $effect(() => {
    const preferredId = requestedTeamId;
    if (
      $teamContext.phase === 'ready' &&
      preferredId &&
      preferredId !== $teamContext.selectedTeamId &&
      $teamContext.teams.some((team) => team.id === preferredId)
    ) {
      selectTeam(fetch, preferredId).catch(() => {});
    }
  });

  onMount(() => {
    if ($teamContext.phase === 'idle') {
      loadTeamContext(fetch, requestedTeamId).catch(() => {});
    }
  });
</script>

<div class="team-sidebar" role="region" aria-label={copy.sidebar}>
  <section class="team-section team-picker" aria-labelledby="sidebar-team-title">
    <div class="section-heading">
      <h2 id="sidebar-team-title">{copy.team}</h2>
    </div>

    {#if $teamContext.teams.length > 0}
      <label for="sidebar-team-select" class="visually-hidden">{copy.selectTeam}</label>
      <div class="team-controls">
        <select
          id="sidebar-team-select"
          value={$teamContext.selectedTeamId}
          onchange={changeTeam}
          disabled={$teamContext.phase === 'loading'}
        >
          {#each $teamContext.teams as team (team.id)}
            <option value={team.id}>{team.name}</option>
          {/each}
        </select>
        <button
          class="create-team-icon"
          type="button"
          onclick={openCreateDialog}
          aria-label={copy.create}
          title={copy.create}
        >
          <span aria-hidden="true">＋</span>
        </button>
      </div>
    {:else if $teamContext.phase === 'loading' || $teamContext.phase === 'idle'}
      <p class="muted" role="status">{copy.loading}</p>
    {/if}

    {#if $teamContext.phase === 'error'}
      <div class="context-error" role="alert">
        <p>{$teamContext.error}</p>
        <button type="button" onclick={retry}>{copy.retry}</button>
      </div>
    {/if}

    {#if $teamContext.phase === 'ready' && $teamContext.teams.length === 0}
      <button class="create-team" type="button" onclick={openCreateDialog}>
        <span class="create-team-label">{copy.create}</span>
        <span class="create-team-symbol" aria-hidden="true">＋</span>
      </button>
    {/if}
  </section>

  {#if $teamContext.selectedTeamId}
    <section class="team-section" aria-labelledby="sidebar-assistants-title">
      <div class="section-heading">
        <h2 id="sidebar-assistants-title">{copy.assistants}</h2>
        {#if $teamContext.phase === 'ready'}<b>{installed.length}</b>{/if}
      </div>

      {#if installed.length > 0}
        <ul class="assistant-list">
          {#each installed as assistant (assistant.id)}
            <li>
              {#if assistant.href}
                <a
                  href={assistant.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={copy.storeDetail.replace('{name}', assistant.name)}
                >
                  <AssistantIcon assistant={assistant.id} size={34} />
                  <span>
                    <strong>{assistant.name}</strong>
                    <small>{assistant.status}</small>
                  </span>
                  <i aria-hidden="true">↗</i>
                </a>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if $teamContext.phase === 'ready'}
        <p class="muted">{copy.assistantEmpty}</p>
      {/if}
    </section>

    <section class="team-section files-section" aria-labelledby="sidebar-files-title">
      <div class="section-heading">
        <h2 id="sidebar-files-title">{copy.files}</h2>
        {#if $teamContext.phase === 'ready'}<b>{$teamContext.files.length}</b>{/if}
      </div>

      {#if $teamContext.files.length > 0}
        <p class="section-help">{active === 'chat' ? copy.fileHelp : copy.fileReadOnly}</p>
        <ul class="file-list">
          {#each $teamContext.files as file (file.id)}
            <li>
              {#if active === 'chat'}
                <label>
                  <input
                    type="checkbox"
                    checked={$teamContext.selectedFileIds.includes(file.id)}
                    onchange={() => toggleTeamFile(file.id)}
                  />
                  <span class="file-mark" aria-hidden="true"></span>
                  <span class="file-name">{file.name}</span>
                </label>
              {:else}
                <div class="file-row">
                  <span class="file-glyph" aria-hidden="true">◇</span>
                  <span class="file-name">{file.name}</span>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if $teamContext.phase === 'ready'}
        <p class="muted">{copy.fileEmpty}</p>
      {/if}
    </section>
  {/if}
</div>

<dialog bind:this={createDialog} oncancel={cancelCreateDialog} aria-labelledby="team-create-title">
  <form class="dialog-panel" onsubmit={submitCreate}>
    <header>
      <p>Team // initialize</p>
      <h2 id="team-create-title">{copy.createTitle}</h2>
      <span>{copy.createLead}</span>
    </header>

    <label for="team-create-name">{copy.name}</label>
    <input
      id="team-create-name"
      type="text"
      bind:value={teamName}
      placeholder={copy.placeholder}
      maxlength="80"
      autocomplete="off"
      autocapitalize="words"
      spellcheck="false"
      required
      disabled={creating}
    />

    {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}

    <footer>
      <button class="secondary" type="button" onclick={closeCreateDialog} disabled={creating}>
        {copy.cancel}
      </button>
      <button class="primary" type="submit" disabled={creating || !teamName.trim()}>
        {creating ? copy.creating : copy.createAction}
      </button>
    </footer>
  </form>
</dialog>

<style>
  .team-sidebar {
    display: flex;
    min-width: 0;
    min-height: 100%;
    flex-direction: column;
    padding: 0.8rem 0;
  }

  .team-section {
    display: grid;
    min-width: 0;
    gap: 0.75rem;
    padding: 1rem 1.15rem 1.2rem;
    border-bottom: 1px solid var(--admin-divider);
  }

  .section-heading {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
  }

  .section-heading h2 {
    margin: 0;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.63rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .section-heading b {
    min-width: 1.45rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 600;
    text-align: end;
  }

  select {
    width: 100%;
    min-height: 2.65rem;
    border: 1px solid var(--border-strong);
    padding: 0 2rem 0 0.75rem;
    background: #050708;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .team-controls {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) 2.65rem;
    gap: 0.55rem;
  }

  select:focus-visible,
  button:focus-visible,
  a:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .muted,
  .section-help {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.69rem;
    line-height: 1.5;
  }

  .section-help {
    font-size: 0.62rem;
  }

  .context-error {
    display: grid;
    gap: 0.6rem;
    border-inline-start: 2px solid var(--danger);
    padding: 0.65rem;
    background: rgba(255, 96, 125, 0.045);
  }

  .context-error p {
    margin: 0;
    color: var(--danger);
    font-size: 0.67rem;
    line-height: 1.45;
  }

  .context-error button,
  .create-team,
  .create-team-icon {
    min-height: 2.35rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.7rem;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .create-team {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    border-color: var(--accent);
  }

  .create-team-label {
    grid-column: 2;
  }

  .create-team-symbol {
    grid-column: 3;
    justify-self: end;
  }

  .create-team-icon {
    display: grid;
    width: 2.65rem;
    min-height: 2.65rem;
    place-items: center;
    border-color: var(--accent);
    padding: 0;
  }

  .create-team:hover,
  .create-team-icon:hover,
  .context-error button:hover {
    background: rgba(0, 240, 255, 0.055);
  }

  .assistant-list,
  .file-list {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .assistant-list a {
    display: grid;
    min-width: 0;
    min-height: 3.15rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    padding: 0.45rem;
    border: 1px solid transparent;
    color: var(--text);
    text-decoration: none;
  }

  .assistant-list a:hover {
    border-color: var(--border-strong);
    background: rgba(0, 240, 255, 0.035);
  }

  .assistant-list a > span {
    display: grid;
    min-width: 0;
    gap: 0.15rem;
  }

  .assistant-list strong,
  .file-name {
    overflow: hidden;
    font-size: 0.7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .assistant-list small {
    color: var(--success);
    font-family: var(--font-mono);
    font-size: 0.5rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .assistant-list i {
    color: var(--accent);
    font-style: normal;
  }

  .file-list li {
    min-width: 0;
  }

  .file-list label,
  .file-row {
    display: grid;
    min-width: 0;
    min-height: 2.35rem;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.6rem;
    padding: 0 0.45rem;
  }

  .file-list label {
    cursor: pointer;
  }

  .file-list input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .file-mark,
  .file-glyph {
    display: grid;
    width: 1rem;
    height: 1rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.6rem;
  }

  input:checked + .file-mark {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }

  input:checked + .file-mark::after {
    content: '✓';
  }

  input:focus-visible + .file-mark {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  dialog {
    width: min(34rem, calc(100vw - 2rem));
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(8px);
  }

  .dialog-panel {
    padding: clamp(1.35rem, 4vw, 2.1rem);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }

  .dialog-panel header {
    display: grid;
    gap: 0.6rem;
    margin-bottom: 1.35rem;
  }

  .dialog-panel header p {
    margin: 0;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .dialog-panel h2 {
    margin: 0;
    font-size: clamp(1.6rem, 4vw, 2.35rem);
    letter-spacing: -0.05em;
  }

  .dialog-panel header span {
    color: var(--text-dim);
    font-size: 0.78rem;
    line-height: 1.55;
  }

  .dialog-panel > label {
    display: block;
    margin-bottom: 0.45rem;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .dialog-panel > input {
    width: 100%;
    min-height: 3rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.85rem;
    background: #050708;
    color: var(--text);
    font: inherit;
  }

  .dialog-error {
    margin: 0.75rem 0 0;
    color: var(--danger);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .dialog-panel footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.7rem;
    margin-top: 1.35rem;
  }

  .dialog-panel button {
    min-height: 2.75rem;
    border: 0;
    padding: 0 1rem;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .dialog-panel button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .dialog-panel .secondary {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border-strong);
    color: var(--text-dim);
  }

  .dialog-panel .primary {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .team-sidebar {
      display: grid;
      min-height: 0;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      padding: 0;
    }

    .team-section {
      border-inline-end: 1px solid var(--admin-divider);
      border-bottom: 0;
    }

    .files-section {
      border-inline-end: 0;
    }
  }

  @media (max-width: 540px) {
    .team-sidebar {
      grid-template-columns: minmax(0, 1fr);
    }

    .team-section {
      border-inline-end: 0;
      border-bottom: 1px solid var(--admin-divider);
    }
  }
</style>
