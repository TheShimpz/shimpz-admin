<script>
  import { Button, Notice } from '@shimpz/frontend';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import { t } from '$lib/i18n.js';
  import {
    clearModelContext,
    loadModelContext,
    modelContext,
    preloadModelProviders,
  } from '$lib/modelContext.js';
  import { ASSISTANT_RUNTIME_UPDATED_EVENT } from '$lib/notifications.js';
  import { loadTeamContext, refreshTeamInventory, selectTeam, teamContext } from '$lib/teamContext.js';
  import { TEAM_ID_RE } from '$lib/validate.js';

  let { active = '' } = $props();

  let runtimeRefresh = null;
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

  function refreshUpdatedAssistants() {
    if (runtimeRefresh || !$teamContext.selectedTeamId) return;
    runtimeRefresh = refreshTeamInventory(fetch)
      .catch(() => {
        // The shared context owns its bounded, fail-closed error state.
      })
      .finally(() => {
        runtimeRefresh = null;
      });
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
    preloadModelProviders(fetch).catch(() => {});
    if ($teamContext.phase === 'idle') {
      loadTeamContext(fetch, requestedTeamId).catch(() => {});
    }
    window.addEventListener(ASSISTANT_RUNTIME_UPDATED_EVENT, refreshUpdatedAssistants);
    return () => window.removeEventListener(ASSISTANT_RUNTIME_UPDATED_EVENT, refreshUpdatedAssistants);
  });
</script>

{#if $teamContext.phase === 'error' && active !== 'chat'}
  <Notice class="context-error" variant="error">
    <p>{$teamContext.error}</p>
    <Button variant="secondary" size="compact" type="button" onclick={retry}>{$t('teamSidebar.retry')}</Button>
  </Notice>
{/if}

<style>
  :global(.context-error) {
    display: grid;
    min-width: 0;
    gap: 0.6rem;
    padding: 0.75rem 1.15rem;
  }

  :global(.context-error) p {
    margin: 0;
    color: var(--danger);
    font-size: 0.67rem;
    line-height: 1.45;
  }

</style>
