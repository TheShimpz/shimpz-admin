<script>
  import { Button, Notice } from '@shimpz/frontend';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import { t } from '#lib/i18n.js';
  import {
    clearModelContext,
    loadModelContext,
    modelContext,
    preloadModelProviders,
  } from '#lib/modelContext.js';
  import { backgroundFetch } from '#lib/localApi.js';
  import { loadTeamContext, selectTeam, selectedAutomatically, teamContext } from '#lib/teamContext.js';
  import { TEAM_ID_RE } from '#lib/validate.js';

  let { active = '' } = $props();

  let requestedTeamId = $derived.by(() => {
    const candidate = page.url.searchParams.get('team') ?? '';
    return TEAM_ID_RE.test(candidate) ? candidate : '';
  });

  function updateLocationTeam(id) {
    const next = new URL(page.url.href);
    next.searchParams.set('team', id);
    return goto(next, { replace: true, reset: false });
  }

  async function retry() {
    try {
      await loadTeamContext(fetch, $teamContext.selectedTeamId);
    } catch {
      // The shared context owns the visible fail-closed error state.
    }
  }

  // A Team the address asks for is selected once the context settled, also after a selection that failed: that
  // failure keeps the previous Team selected and returns the address to it, unless another Team was asked for since.
  // A Team is asked for once while the address names it, so a failure never repeats itself.
  let askedId = '';
  // The Team the person's own navigation asked for and the page has not selected yet. The address meeting a Team list
  // Admin changed (a Team made again elsewhere) selects it on the page's own account, with automatic reads.
  let addressSeen = '';
  let personAsked = '';

  $effect(() => {
    const preferredId = requestedTeamId;
    if (preferredId !== addressSeen) {
      addressSeen = preferredId;
      personAsked = preferredId;
    }
    if (preferredId === $teamContext.selectedTeamId) personAsked = '';
    if (preferredId !== askedId) askedId = '';
    if (
      ($teamContext.phase === 'ready' || $teamContext.phase === 'error') &&
      preferredId &&
      preferredId !== askedId &&
      preferredId !== $teamContext.selectedTeamId &&
      $teamContext.teams.some((team) => team.id === preferredId)
    ) {
      const previousId = $teamContext.selectedTeamId;
      askedId = preferredId;
      const read = preferredId === personAsked ? fetch : backgroundFetch;
      personAsked = '';
      selectTeam(read, preferredId).catch(() => {
        if (previousId && requestedTeamId === preferredId) updateLocationTeam(previousId).catch(() => {});
      });
    }
  });

  $effect(() => {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId) {
      if ($modelContext.teamId) clearModelContext();
    } else if ($modelContext.teamId !== teamId || $modelContext.phase === 'idle') {
      // A Team the page selected itself opens with automatic reads.
      loadModelContext(selectedAutomatically() ? backgroundFetch : fetch, teamId).catch(() => {});
    }
  });

  onMount(() => {
    preloadModelProviders(fetch).catch(() => {});
    if ($teamContext.phase === 'idle') {
      loadTeamContext(fetch, requestedTeamId).catch(() => {});
    }
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
    gap: var(--gap-item);
    padding: var(--gap-item) var(--gap-group);
  }

  :global(.context-error) p {
    margin: 0;
    color: var(--danger);
    font-size: 0.67rem;
    line-height: 1.45;
  }

</style>
