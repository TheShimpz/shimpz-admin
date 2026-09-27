<script>
  import { ActionLink, Button, NavItem } from '@shimpz/frontend';

  import { t } from '$lib/i18n.js';
  import TeamActionsMenu from '$lib/TeamActionsMenu.svelte';
  import { teamContext } from '$lib/teamContext.js';

  let {
    active = '',
    oncreate = () => {},
    ondelete = () => {},
    onnavigate = () => {},
    createButton = $bindable(),
  } = $props();

  let copy = $derived($t('teamNavigation'));
  let busy = $derived($teamContext.phase === 'loading');

  function chatHref(team) {
    return `/chat/?team=${encodeURIComponent(team.id)}`;
  }

  function storeHref(team) {
    return `/assistants/?team=${encodeURIComponent(team.id)}`;
  }
</script>

<div class="team-navigation">
  <Button
    bind:element={createButton}
    class="new-team"
    variant="secondary"
    type="button"
    onclick={oncreate}
    disabled={busy}
  >
    {#snippet icon()}<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>{/snippet}
    {copy.newTeam}
  </Button>
  {#if $teamContext.teams.length > 0}
    <nav aria-label={copy.label}>
      <ul>
        {#each $teamContext.teams as team (team.id)}
          {@const selected = team.id === $teamContext.selectedTeamId}
          <li class={['team-row', selected && active === 'assistants' && 'is-store']}>
            <NavItem
              class="team-link"
              href={chatHref(team)}
              active={selected && active === 'chat'}
              onclick={onnavigate}
            >{team.name}</NavItem>
            <ActionLink
              class={['team-store', selected && active === 'assistants' && 'is-active']}
              variant="ghost"
              href={storeHref(team)}
              aria-label={$t('teamNavigation.openStore', { team: team.name })}
              title={$t('teamNavigation.openStore', { team: team.name })}
              aria-current={selected && active === 'assistants' ? 'page' : undefined}
              onclick={onnavigate}
            >
              {#snippet icon()}
                <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"></path></svg>
              {/snippet}
            </ActionLink>
            <TeamActionsMenu
              label={$t('teamNavigation.actions', { team: team.name })}
              deleteLabel={copy.deleteTeam}
              ondelete={() => ondelete(team)}
            />
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
</div>

<style>
  .team-navigation { display: grid; min-width: 0; gap: var(--shimpz-space-3); padding: var(--shimpz-space-3) var(--shimpz-space-4); }
  .team-navigation :global(.new-team) { width: 100%; justify-content: flex-start; }
  .team-navigation :global(.new-team svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2; }
  ul { display: grid; gap: var(--shimpz-space-2); margin: 0; padding: 0; list-style: none; }
  .team-row { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto auto; align-items: stretch; }
  .team-row :global(.team-link) { min-width: 0; }
  .team-row :global(.team-link .label) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .team-row.is-store :global(.team-link) { color: var(--shimpz-color-cyan); border-color: color-mix(in srgb, var(--shimpz-color-cyan) 48%, var(--shimpz-color-border)); }
  .team-row :global(.team-store) { display: grid; width: 2.75rem; height: auto; min-height: 100%; place-items: center; padding: 0; color: var(--shimpz-color-text-dim); border: 1px solid var(--shimpz-color-border-subtle); border-inline-start: 0; clip-path: none; }
  .team-row :global(.team-store:hover), .team-row :global(.team-store.is-active) { color: var(--shimpz-color-cyan); background: var(--shimpz-color-surface-high); }
  .team-row :global(.team-store svg) { width: 1.05rem; height: 1.05rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .team-row :global(.team-actions > .shimpz-button) { height: auto; min-height: 100%; border: 1px solid var(--shimpz-color-border-subtle); border-inline-start: 0; clip-path: none; }
</style>
