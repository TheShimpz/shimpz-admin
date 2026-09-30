<script>
  import { ActionLink, Button, ShimpzBrand } from '@shimpz/frontend';

  import { t } from '$lib/i18n.js';
  import { loadTeamRoutines, retainTeamRoutines, routineContext } from '$lib/routineContext.js';
  import TeamActionsMenu from '$lib/TeamActionsMenu.svelte';
  import { teamContext } from '$lib/teamContext.js';
  import TeamRoutineTree from '$lib/TeamRoutineTree.svelte';

  let {
    active = '',
    oncreate = () => {},
    ondelete = () => {},
    // Local Teams have Routines (ADR-0086); Hosted has none yet.
    routines = false,
    onnavigate = () => {},
    createButton = $bindable(),
  } = $props();

  let copy = $derived($t('teamNavigation'));
  let busy = $derived($teamContext.phase === 'loading');

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

  // Which Teams show their Routine tree; the menu item exists only for a Team that has Routines.
  let treeOpen = $state(new Set());

  function toggleTree(teamId) {
    const next = new Set(treeOpen);
    if (!next.delete(teamId)) next.add(teamId);
    treeOpen = next;
  }

  function teamRoutines(teamId) {
    return $routineContext.get(teamId) ?? { routines: [], runs: [] };
  }

  // Loads follow the Team list itself, not every Team context transition such as a selection change.
  let routineTeams = $derived(routines ? JSON.stringify($teamContext.teams.map((team) => team.id)) : '[]');

  $effect(() => {
    const ids = JSON.parse(routineTeams);
    retainTeamRoutines(ids);
    for (const id of ids) loadTeamRoutines(fetch, id).catch(() => {});
  });
</script>

<div class="team-navigation">
  <div class="head">
    <ShimpzBrand class="head-mark" variant="symbol" decorative />
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
              <ActionLink
                class="team-link"
                variant="ghost"
                href={chatHref(team)}
                aria-current={selected && active === 'chat' ? 'page' : undefined}
                onclick={onnavigate}
              >
                <span class="monogram" aria-hidden="true">{monogram(team.name)}</span>
                <span class="name">{team.name}</span>
              </ActionLink>
              <div class="row-actions">
                <ActionLink
                  class={['row-action', selected && active === 'assistants' && 'is-here']}
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
                  routinesLabel={$t('routine.list.open')}
                  onroutines={routines && teamRoutines(team.id).routines.length > 0
                    ? () => toggleTree(team.id)
                    : null}
                />
              </div>
            </div>
            {#if routines && treeOpen.has(team.id) && teamRoutines(team.id).routines.length > 0}
              <TeamRoutineTree
                teamId={team.id}
                routines={teamRoutines(team.id).routines}
                runs={teamRoutines(team.id).runs}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
</div>

<style>
  /* Team rows are full bleed across the sidebar; only the header keeps the sidebar's inset. */
  .team-navigation { display: grid; min-width: 0; gap: var(--shimpz-space-2); padding-block: var(--shimpz-space-4); }
  .head { display: flex; min-height: 2.25rem; align-items: center; justify-content: space-between; padding-inline: calc(var(--shimpz-space-3) + var(--shimpz-space-2)) var(--shimpz-space-3); }
  .head :global(.head-mark img) { width: 1.75rem; height: 1.75rem; }
  /* Borderless controls; hover and focus answer with the cyberpunk treatment: a chamfered cyan scanline tint and a
     short chromatic glitch on entry. The chamfered fill is a layer, never a clip on the control, so a keyboard focus ring is never cut. */
  .head :global(.new-team) { position: relative; isolation: isolate; width: 2.25rem; height: 2.25rem; min-height: 0; padding: 0; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-muted); }
  .head :global(.new-team::before), .row::before { content: ""; position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); pointer-events: none; }
  .head :global(.new-team:hover:not(:disabled)), .head :global(.new-team:focus-visible) { color: var(--shimpz-color-cyan); background: transparent; border: 0; box-shadow: none; }
  .head :global(.new-team:hover:not(:disabled)::before), .head :global(.new-team:focus-visible::before) { background: var(--team-scanlines), var(--team-hover-bg); }
  .head :global(.new-team:hover:not(:disabled) svg), .head :global(.new-team:focus-visible svg) { filter: var(--team-split-icon); animation: team-glitch-icon 280ms steps(1, end); }
  .head svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  .team-navigation {
    --team-hover-bg: color-mix(in srgb, var(--shimpz-color-cyan) 7%, var(--shimpz-color-bg));
    /* Routine nodes align with the Team name; their guide line runs under the monogram's center. */
    --routine-indent: calc(var(--shimpz-space-3) + 2.6rem);
    --routine-guide: calc(var(--shimpz-space-3) + 0.95rem);
    --team-scanlines: repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 6%, transparent) 2px 3px);
    --team-split-text: -1px 0 color-mix(in srgb, var(--shimpz-color-magenta) 70%, transparent), 1px 0 color-mix(in srgb, var(--shimpz-color-cyan) 70%, transparent);
    --team-split-icon: drop-shadow(-1px 0 var(--shimpz-color-magenta)) drop-shadow(1px 0 var(--shimpz-color-cyan));
  }
  ul { display: grid; margin: 0; padding: 0; list-style: none; }
  .teams { gap: 2px; }
  .row { --row-bg: var(--shimpz-color-bg); position: relative; isolation: isolate; display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); align-items: center; }
  .row::before { background-color: var(--row-bg); transition: background-color var(--shimpz-duration-fast) var(--shimpz-ease); }
  /* The selected Team keeps the hover treatment: the same tint and scanlines. */
  .row:hover, .row:focus-within, .is-selected > .row { --row-bg: var(--team-hover-bg); }
  .row:hover::before, .row:focus-within::before, .is-selected > .row::before { background-image: var(--team-scanlines); }
  .row:hover .name, .row:focus-within .name { text-shadow: var(--team-split-text); animation: team-glitch-text 280ms steps(1, end); }
  .row:hover .monogram { animation: team-glitch-icon 280ms steps(1, end); }
  /* Row actions overlay the end of the name so collapsed Teams keep their full width until hover or focus. */
  .row-actions { position: absolute; inset-block: 0; inset-inline-end: 0; display: flex; align-items: center; padding-inline: 1.5rem var(--shimpz-space-2); background: linear-gradient(to right, transparent, var(--row-bg) 1.5rem); opacity: 0; transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease); }
  :global([dir="rtl"]) .row-actions { background: linear-gradient(to left, transparent, var(--row-bg) 1.5rem); }
  .row:hover .row-actions, .row:focus-within .row-actions, .is-selected > .row .row-actions { opacity: 1; }
  .row :global(.team-link) { min-width: 0; height: auto; min-height: 2.75rem; justify-content: flex-start; padding: 0.4rem var(--shimpz-space-3); border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-muted); }
  .row :global(.team-link .action-link-content) { display: flex; min-width: 0; align-items: center; gap: 0.7rem; }
  .row :global(.team-link:hover), .is-selected > .row :global(.team-link) { color: var(--shimpz-color-text); }
  .monogram { display: grid; flex: 0 0 auto; width: 1.9rem; height: 1.9rem; place-items: center; color: var(--shimpz-color-text-dim); background: var(--shimpz-color-bg); border: 1px solid var(--shimpz-color-border); font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.04em; }
  .is-selected .monogram { color: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .name { min-width: 0; overflow: hidden; font: 500 0.9rem/1.2 var(--shimpz-font-sans); letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
  .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.25rem; height: 2.25rem; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-dim); }
  .row :global(.row-action:hover), .row :global(.row-action.is-here), .row :global(.team-actions > .shimpz-button:hover),
  .row :global(.team-actions > .shimpz-button[aria-expanded="true"]) { color: var(--shimpz-color-cyan); background: transparent; box-shadow: none; }
  .row :global(.row-action:hover svg), .row :global(.team-actions > .shimpz-button:hover svg) { filter: var(--team-split-icon); animation: team-glitch-icon 280ms steps(1, end); }
  @keyframes team-glitch-text {
    0% { transform: translateX(1px); text-shadow: -2px 0 var(--shimpz-color-magenta), 2px 0 var(--shimpz-color-cyan); }
    30% { transform: translateX(-1px); text-shadow: 2px 0 var(--shimpz-color-magenta), -2px 0 var(--shimpz-color-cyan); }
    60% { transform: translateX(0); clip-path: inset(0 0 45% 0); }
    80%, 100% { transform: none; clip-path: none; }
  }
  @keyframes team-glitch-icon {
    0% { transform: translateX(-1px); filter: drop-shadow(-2px 0 var(--shimpz-color-magenta)) drop-shadow(2px 0 var(--shimpz-color-cyan)); }
    35% { transform: translateX(1px); filter: drop-shadow(2px 0 var(--shimpz-color-magenta)) drop-shadow(-2px 0 var(--shimpz-color-cyan)); }
    70%, 100% { transform: none; }
  }
  .row :global(.row-action svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  @media (pointer: coarse) {
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .row-actions { position: static; padding: 0; background: none; opacity: 1; }
    .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.75rem; height: 2.75rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .row::before, .row-actions { transition: none; }
    .row .name, .row .monogram, .row :global(svg), .head :global(svg) { animation: none !important; }
  }
  @media (forced-colors: active) {
    .is-selected > .row { outline: 1px solid Highlight; }
  }
</style>
