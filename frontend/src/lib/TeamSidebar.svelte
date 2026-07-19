<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import { locale } from '$lib/i18n.js';
  import { clearModelContext, loadModelContext, modelContext } from '$lib/modelContext.js';
  import {
    loadTeamContext,
    selectTeam,
    teamContext,
    toggleTeamFile,
  } from '$lib/teamContext.js';

  let { active = '' } = $props();

  const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
  const COPY = {
    en: {
      sidebar: 'Team files',
      files: 'Files',
      fileEmpty: 'No Team files yet.',
      fileHelp: 'Select up to 8 files for the next message.',
      fileReadOnly: 'Files can be attached from Chat.',
      retry: 'Retry local data',
    },
    pt: {
      sidebar: 'Arquivos do Time',
      files: 'Arquivos',
      fileEmpty: 'Ainda não há arquivos neste Time.',
      fileHelp: 'Selecione até 8 arquivos para a próxima mensagem.',
      fileReadOnly: 'Os arquivos podem ser anexados pelo Chat.',
      retry: 'Tentar dados locais novamente',
    },
  };

  let copy = $derived($locale === 'pt' ? COPY.pt : COPY.en);
  let requestedTeamId = $derived.by(() => {
    const candidate = page.url.searchParams.get('team') ?? '';
    return TEAM_ID_RE.test(candidate) ? candidate : '';
  });

  function updateLocationTeam(id) {
    const next = new URL(page.url);
    next.searchParams.set('team', id);
    return goto(next, { replaceState: true, keepFocus: true, noScroll: true });
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
      const previousId = $teamContext.selectedTeamId;
      selectTeam(fetch, preferredId).catch(() => {
        if (previousId) updateLocationTeam(previousId).catch(() => {});
      });
    }
  });

  $effect(() => {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId) {
      if ($modelContext.teamId) clearModelContext();
    } else if ($modelContext.teamId !== teamId || $modelContext.phase === 'idle') {
      loadModelContext(fetch, teamId).catch(() => {});
    }
  });

  onMount(() => {
    if ($teamContext.phase === 'idle') {
      loadTeamContext(fetch, requestedTeamId).catch(() => {});
    }
  });
</script>

<div class="team-sidebar" role="region" aria-label={copy.sidebar}>
  {#if $teamContext.phase === 'error' && active !== 'chat'}
    <div class="context-error" role="alert">
      <p>{$teamContext.error}</p>
      <button type="button" onclick={retry}>{copy.retry}</button>
    </div>
  {/if}

  {#if $teamContext.selectedTeamId}
    <section class="files-section" aria-labelledby="sidebar-files-title">
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

<style>
  .team-sidebar {
    display: flex;
    min-width: 0;
    min-height: 100%;
    flex-direction: column;
    padding: 0;
  }

  .files-section,
  .context-error {
    display: grid;
    min-width: 0;
    gap: 0.6rem;
    padding: 0.75rem 1.15rem;
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

  .muted,
  .section-help {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.69rem;
    line-height: 1.5;
  }

  .section-help { font-size: 0.62rem; }

  .context-error {
    border-inline-start: 2px solid var(--danger);
    background: rgba(255, 96, 125, 0.045);
  }

  .context-error p {
    margin: 0;
    color: var(--danger);
    font-size: 0.67rem;
    line-height: 1.45;
  }

  .context-error button {
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

  .context-error button:hover { background: rgba(0, 240, 255, 0.055); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .file-list {
    display: grid;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .file-list li { min-width: 0; }

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

  .file-list label { cursor: pointer; }

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

  input:checked + .file-mark::after { content: '✓'; }
  input:focus-visible + .file-mark { outline: 2px solid var(--accent); outline-offset: 2px; }

  .file-name {
    overflow: hidden;
    font-size: 0.7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
