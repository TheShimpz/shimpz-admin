<script>
  import { ActionLink, Button } from '@shimpz/frontend';

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
  let inventoryReady = $derived($teamContext.phase === 'ready');
  let installedCount = $derived($teamContext.installedAssistants.length);

  function monogram(name) {
    const words = name.trim().split(/\s+/u).filter(Boolean);
    const letters = words.length > 1 ? [...words[0]][0] + [...words.at(-1)][0] : [...words[0]].slice(0, 2).join('');
    return letters.toLocaleUpperCase();
  }

  function chatHref(team) {
    return `/chat/?team=${encodeURIComponent(team.id)}`;
  }

  function storeHref(team) {
    return `/assistants/?team=${encodeURIComponent(team.id)}`;
  }
</script>

<div class="team-navigation">
  <div class="head">
    <span class="head-label" aria-hidden="true">{copy.label}</span>
    <Button
      bind:element={createButton}
      class="new-team"
      variant="ghost"
      size="sm"
      iconOnly
      type="button"
      aria-label={copy.newTeam}
      title={copy.newTeam}
      onclick={oncreate}
      disabled={busy}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
    </Button>
  </div>
  {#if $teamContext.teams.length > 0}
    <nav aria-label={copy.label}>
      <ul class="teams">
        {#each $teamContext.teams as team (team.id)}
          {@const selected = team.id === $teamContext.selectedTeamId}
          <li class={['team', selected && 'is-selected']}>
            <div class="row">
              <ActionLink class="team-link" variant="ghost" href={chatHref(team)} onclick={onnavigate}>
                <span class="monogram" aria-hidden="true">{monogram(team.name)}</span>
                <span class="name">{team.name}</span>
              </ActionLink>
              <div class="row-actions">
              {#if !selected}
                <ActionLink
                  class="row-action"
                  variant="ghost"
                  href={storeHref(team)}
                  aria-label={$t('teamNavigation.openStore', { team: team.name })}
                  title={$t('teamNavigation.openStore', { team: team.name })}
                  onclick={onnavigate}
                >
                  {#snippet icon()}
                    <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"></path></svg>
                  {/snippet}
                </ActionLink>
              {/if}
              <TeamActionsMenu
                label={$t('teamNavigation.actions', { team: team.name })}
                deleteLabel={copy.deleteTeam}
                ondelete={() => ondelete(team)}
              />
              </div>
            </div>
            {#if selected}
              <ul class="destinations">
                <li>
                  <ActionLink
                    class={['destination', active === 'chat' && 'is-here']}
                    variant="ghost"
                    href={chatHref(team)}
                    aria-current={active === 'chat' ? 'page' : undefined}
                    onclick={onnavigate}
                  >
                    {#snippet icon()}<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"></path></svg>{/snippet}
                    <span class="destination-label">{copy.chat}</span>
                  </ActionLink>
                </li>
                <li>
                  <ActionLink
                    class={['destination', active === 'assistants' && 'is-here']}
                    variant="ghost"
                    href={storeHref(team)}
                    aria-current={active === 'assistants' ? 'page' : undefined}
                    onclick={onnavigate}
                  >
                    {#snippet icon()}
                      <svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"></path></svg>
                    {/snippet}
                    <span class="destination-label">{copy.store}</span>
                    {#if inventoryReady}
                      <span class="count" aria-hidden="true">{installedCount}</span>
                      <span class="sr-only">{$t('teamNavigation.installed', { count: installedCount })}</span>
                    {/if}
                  </ActionLink>
                </li>
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
</div>

<style>
  .team-navigation { display: grid; min-width: 0; gap: var(--shimpz-space-2); padding: var(--shimpz-space-4) var(--shimpz-space-3); }
  .head { display: flex; min-height: 2.25rem; align-items: center; justify-content: space-between; padding-inline-start: var(--shimpz-space-2); }
  .head-label { color: var(--shimpz-color-text-dim); font: 700 0.66rem/1 var(--shimpz-font-mono); letter-spacing: 0.12em; text-transform: uppercase; }
  .head :global(.new-team) { width: 2.25rem; height: 2.25rem; min-height: 0; padding: 0; border: 1px solid var(--shimpz-color-border); clip-path: none; color: var(--shimpz-color-text-muted); }
  .head :global(.new-team:hover), .head :global(.new-team:focus-visible) { color: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); }
  .head svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  ul { display: grid; margin: 0; padding: 0; list-style: none; }
  .teams { gap: 2px; }
  .row { --row-bg: var(--shimpz-color-bg); position: relative; display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); align-items: center; border: 1px solid transparent; background: var(--row-bg); transition: background var(--shimpz-duration-fast) var(--shimpz-ease), border-color var(--shimpz-duration-fast) var(--shimpz-ease); }
  .row:hover, .row:focus-within { --row-bg: var(--shimpz-color-surface); }
  .is-selected > .row { --row-bg: var(--shimpz-color-surface-high); border-color: color-mix(in srgb, var(--shimpz-color-cyan) 45%, var(--shimpz-color-border)); }
  /* Row actions overlay the end of the name so collapsed Teams keep their full width until hover or focus. */
  .row-actions { position: absolute; inset-block: 0; inset-inline-end: 0; display: flex; align-items: center; padding-inline-start: 1.5rem; background: linear-gradient(to right, transparent, var(--row-bg) 1.5rem); opacity: 0; transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease); }
  :global([dir="rtl"]) .row-actions { background: linear-gradient(to left, transparent, var(--row-bg) 1.5rem); }
  .row:hover .row-actions, .row:focus-within .row-actions, .is-selected > .row .row-actions { opacity: 1; }
  .row :global(.team-link) { min-width: 0; height: auto; min-height: 2.75rem; justify-content: flex-start; padding: 0.4rem 0.5rem; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-muted); }
  .row :global(.team-link .action-link-content) { display: flex; min-width: 0; align-items: center; gap: 0.7rem; }
  .row :global(.team-link:hover), .is-selected > .row :global(.team-link) { color: var(--shimpz-color-text); }
  .monogram { display: grid; flex: 0 0 auto; width: 1.9rem; height: 1.9rem; place-items: center; color: var(--shimpz-color-text-dim); background: var(--shimpz-color-bg); border: 1px solid var(--shimpz-color-border); font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.04em; }
  .is-selected .monogram { color: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .name { min-width: 0; overflow: hidden; font: 500 0.9rem/1.2 var(--shimpz-font-sans); letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
  .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.25rem; height: 2.25rem; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-dim); }
  .row :global(.row-action:hover), .row :global(.team-actions > .shimpz-button:hover),
  .row :global(.team-actions > .shimpz-button[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  .row :global(.row-action svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .destinations { gap: 1px; margin: 2px 0 var(--shimpz-space-2); padding-inline-start: calc(0.5rem + 0.95rem); }
  .destinations :global(.destination) { width: 100%; height: auto; min-height: 2.25rem; justify-content: flex-start; padding-block: 0.35rem; padding-inline: 1.2rem 0.6rem; border: 0; clip-path: none; color: var(--shimpz-color-text-dim); font: 600 0.72rem/1 var(--shimpz-font-mono); letter-spacing: 0.06em; text-transform: uppercase; background: linear-gradient(var(--shimpz-color-border), var(--shimpz-color-border)) no-repeat left / 1px 100%; }
  .destinations :global(.destination .action-link-content) { display: flex; width: 100%; align-items: center; justify-content: flex-start; gap: 0.6rem; }
  .destinations :global(.destination svg) { width: 0.95rem; height: 0.95rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .destinations :global(.destination:hover) { color: var(--shimpz-color-text); }
  .destinations :global(.destination.is-here) { color: var(--shimpz-color-cyan); background: linear-gradient(var(--shimpz-color-cyan), var(--shimpz-color-cyan)) no-repeat left / 1px 100%, color-mix(in srgb, var(--shimpz-color-cyan) 7%, transparent); }
  :global([dir="rtl"]) .destinations :global(.destination) { background-position: right; }
  .count { margin-inline-start: auto; min-width: 1.4rem; padding: 0.15rem 0.35rem; color: var(--shimpz-color-text-muted); border: 1px solid var(--shimpz-color-border); font-size: 0.62rem; font-variant-numeric: tabular-nums; text-align: center; }
  @media (pointer: coarse) {
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .row-actions { position: static; padding: 0; background: none; opacity: 1; }
    .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.75rem; height: 2.75rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .row, .row-actions { transition: none; }
  }
</style>
