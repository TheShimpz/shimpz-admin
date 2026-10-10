<script>
  import { onDestroy, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { ActionLink, Button, ShimpzBrand, TextField } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';

  import { t } from '$lib/i18n.js';
  import { loadTeamRoutines, retainTeamRoutines, routineContext } from '$lib/routineContext.js';
  import { loadActionConfirmation, saveActionConfirmation } from '$lib/actionConfirmation.js';
  import TeamActionsMenu from '$lib/TeamActionsMenu.svelte';
  import { renameTeam, reorderTeams, teamContext } from '$lib/teamContext.js';
  import TeamRoutinesDialog from '$lib/TeamRoutinesDialog.svelte';

  let {
    active = '',
    oncreate = () => {},
    ondelete = () => {},
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

  // Each Team's Action confirmation setting (ADR-0112) as its actions menu reads and changes it; a failure is reported.
  function confirmationSetting(team) {
    const report = (message) => (error) => {
      showAdminNotice({ tone: 'error', label: copy.confirmActions, message });
      throw error;
    };
    return {
      load: () => loadActionConfirmation(fetch, team.id).catch(report(copy.confirmActionsUnavailable)),
      save: (enabled) => saveActionConfirmation(fetch, team.id, enabled).catch(report(copy.confirmActionsFailed)),
    };
  }

  // The Team whose Routines modal is open; the menu item exists only for a Team that has Routines. Leaving it returns
  // focus to that Team's Routines button, or to its actions once it has no Routine left.
  let routinesOpen = $state('');

  async function closeRoutines(teamId) {
    routinesOpen = '';
    await tick();
    const row = list?.querySelector(`[data-team-row="${teamId}"]`);
    (row?.querySelector('.routines-action') ?? row?.querySelector('[aria-haspopup="menu"]'))?.focus();
  }

  // Renaming edits the name in place: Enter or leaving the field saves it, Escape keeps the current name. One save runs
  // at a time; Enter and Escape return focus to the Team link, while leaving the field keeps focus where the user put it.
  let renaming = $state('');
  let renameDraft = $state('');
  let renameSaving = $state(false);

  function renameFieldId(teamId) {
    return `team-rename-${teamId}`;
  }

  async function focusTeamLink(teamId) {
    await tick();
    document.querySelector(`[data-team-link="${teamId}"]`)?.focus();
  }

  async function startRename(team) {
    if (renameSaving) return;
    renaming = team.id;
    renameDraft = team.name;
    await tick();
    const field = document.getElementById(renameFieldId(team.id));
    field?.focus();
    field?.select();
  }

  async function commitRename(team, restoreFocus) {
    if (renaming !== team.id || renameSaving) return;
    const name = renameDraft.trim();
    if (!name || name === team.name) {
      renaming = '';
      if (restoreFocus) await focusTeamLink(team.id);
      return;
    }
    renameSaving = true;
    // Focus returns only if the user left it in the field while the name was saving.
    const stillHere = () => {
      const active = document.activeElement;
      return restoreFocus && (!active || active === document.body || active.id === renameFieldId(team.id));
    };
    try {
      await renameTeam(fetch, team.id, name);
      const restore = stillHere();
      if (renaming === team.id) renaming = '';
      if (restore) await focusTeamLink(team.id);
    } catch (error) {
      showAdminNotice({ tone: 'error', label: copy.rename, message: error?.message || copy.renameFailed });
      if (stillHere()) document.getElementById(renameFieldId(team.id))?.focus();
    } finally {
      renameSaving = false;
    }
  }

  function renameKeydown(event, team) {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void commitRename(team, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      renaming = '';
      void focusTeamLink(team.id);
    }
  }

  function teamRoutines(teamId) {
    return $routineContext.get(teamId) ?? { routines: [], runs: [], incidents: [], failed: false };
  }

  // A Team offers its Routines while it lists any, and while its newest listing failed: a failure never reads as a Team
  // without Routines, and its list says so with a retry.
  function offersRoutines(teamId) {
    const listed = teamRoutines(teamId);
    return listed.routines.length > 0 || listed.failed;
  }

  // A Team's Routines need the person when a run is held for recovery or waits for their approval, connection, or
  // permission, or a Routine is paused or waiting to be asked again. The chat shows no run, so this is where a run that
  // waits for the person is found.
  function routinesNeedAttention(teamId) {
    const listed = teamRoutines(teamId);
    return listed.incidents.length > 0 ||
      listed.runs.some((run) => run.status === 'held' || run.status === 'frozen') ||
      listed.routines.some((routine) => routine.state === 'paused' || routine.needs_reconfirm);
  }

  // Loads follow the Team list's membership, not every Team context transition such as a selection or a new order.
  let routineTeams = $derived(JSON.stringify($teamContext.teams.map((team) => team.id).sort()));

  $effect(() => {
    const ids = JSON.parse(routineTeams);
    retainTeamRoutines(ids);
    for (const id of ids) loadTeamRoutines(fetch, id).catch(() => {});
  });

  // Teams keep the Supervisor's order: drag a row's handle, or Move up / Move down in its actions menu. The order
  // moves at once and is saved behind it; a refusal restores the last saved order.
  let canReorder = $derived($teamContext.teams.length > 1);
  let announcement = $state('');
  let list = $state();

  async function announce(message) {
    announcement = '';
    await tick();
    announcement = message;
  }

  async function saveOrder(ids, team) {
    const position = ids.indexOf(team.id) + 1;
    try {
      const saving = reorderTeams(fetch, ids);
      void announce($t('teamNavigation.moved', { team: team.name, position, total: ids.length }));
      await saving;
    } catch (error) {
      showAdminNotice({
        tone: 'error',
        label: copy.order,
        message: error?.status === 409 ? copy.orderStale : copy.orderFailed,
      });
    }
  }

  function teamIds() {
    return $teamContext.teams.map((item) => item.id);
  }

  async function moveTeam(team, delta) {
    const ids = teamIds();
    const from = ids.indexOf(team.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, team.id);
    const saved = saveOrder(ids, team);
    // The moved row's actions button takes the focus back, so the next move is one menu away.
    await tick();
    list?.querySelector(`[data-team-row="${team.id}"] [aria-haspopup="menu"]`)?.focus();
    await saved;
  }

  // Pointer dragging works for mouse, pen, and touch from the handle only, so the rest of the row keeps scrolling,
  // links, rename, and menus. It starts after a short movement, follows the pointer, and drops between rows.
  const DRAG_THRESHOLD = 6;
  // Rows glide to a new place unless the Supervisor asked for reduced motion.
  const settle = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  const SCROLL_EDGE = 48;
  let gesture = null;
  let dragId = $state('');
  let dragOffset = $state(0);
  let dropIndex = $state(-1);

  // The drop slot among the other rows, and whether it actually changes the order.
  let dropTarget = $derived.by(() => {
    if (!dragId || dropIndex < 0) return null;
    const ids = teamIds();
    if (ids.indexOf(dragId) === dropIndex) return null;
    const others = ids.filter((id) => id !== dragId);
    return dropIndex < others.length ? { id: others[dropIndex], side: 'before' } : { id: others.at(-1), side: 'after' };
  });

  function scrollParent(element) {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if (/(auto|scroll)/u.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  }

  function handleDown(event, team) {
    if (!canReorder || gesture || renaming || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const scroller = scrollParent(list);
    gesture = {
      team,
      handle,
      pointerId: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      scroller,
      startScroll: scroller?.scrollTop ?? 0,
      active: false,
      frame: 0,
    };
  }

  function track() {
    if (!gesture?.active) return;
    dragOffset = gesture.y - gesture.startY + (gesture.scroller?.scrollTop ?? 0) - gesture.startScroll;
    let index = 0;
    for (const row of list?.querySelectorAll(':scope > li') ?? []) {
      if (row.dataset.teamRow === gesture.team.id) continue;
      const box = row.querySelector('.row').getBoundingClientRect();
      if (gesture.y > box.top + box.height / 2) index += 1;
    }
    dropIndex = index;
  }

  // Holding the pointer near the top or bottom edge of the scrolling list scrolls it, faster the closer it gets.
  function autoScroll() {
    if (!gesture?.active) return;
    // A handle that left the page (its row was removed, or the layout swapped this navigation out) ends the drag, so
    // the loop never re-arms and never keeps a removed list or scroller alive.
    if (!gesture.handle.isConnected) {
      cancelDrag();
      return;
    }
    const scroller = gesture.scroller;
    if (scroller) {
      const box = scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
      const top = Math.max(box.top, 0) + SCROLL_EDGE;
      const bottom = Math.min(box.bottom, window.innerHeight) - SCROLL_EDGE;
      const step = gesture.y < top ? -Math.ceil((top - gesture.y) / 4) : gesture.y > bottom ? Math.ceil((gesture.y - bottom) / 4) : 0;
      if (step) {
        scroller.scrollTop += step;
        track();
      }
    }
    gesture.frame = requestAnimationFrame(autoScroll);
  }

  function handleMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.y = event.clientY;
    if (!gesture.active) {
      if (Math.abs(gesture.y - gesture.startY) < DRAG_THRESHOLD) return;
      gesture.active = true;
      dragId = gesture.team.id;
      gesture.frame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    track();
  }

  function endGesture() {
    const ended = gesture;
    gesture = null;
    if (!ended) return null;
    cancelAnimationFrame(ended.frame);
    if (ended.handle.hasPointerCapture?.(ended.pointerId)) ended.handle.releasePointerCapture(ended.pointerId);
    const result = { ...ended, dropIndex, moved: ended.active };
    dragId = '';
    dragOffset = 0;
    dropIndex = -1;
    return result;
  }

  // A drag never doubles as a click on whatever sits under the pointer when it ends.
  function suppressNextClick() {
    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  }

  function handleUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const ended = endGesture();
    if (!ended.moved) return;
    suppressNextClick();
    const ids = teamIds().filter((id) => id !== ended.team.id);
    if (ended.dropIndex < 0 || teamIds().indexOf(ended.team.id) === ended.dropIndex) return;
    ids.splice(ended.dropIndex, 0, ended.team.id);
    void saveOrder(ids, ended.team);
  }

  // A cancelled pointer, a lost capture, or Escape drops nothing: the order was never changed during the drag.
  function cancelDrag() {
    endGesture();
  }

  onDestroy(cancelDrag);

  function dragKeydown(event) {
    if (event.key !== 'Escape' || !gesture?.active) return;
    // Escape ends only the drag, never an enclosing dialog such as the mobile Team drawer.
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  }
</script>

<svelte:window onkeydowncapture={dragKeydown} />

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
      <ul bind:this={list} class={['teams', dragId && 'is-reordering']}>
        {#each $teamContext.teams as team, index (team.id)}
          {@const selected = team.id === $teamContext.selectedTeamId}
          <li
            class={[
              'team',
              selected && 'is-selected',
              dragId === team.id && 'is-dragging',
              dropTarget?.id === team.id && `drop-${dropTarget.side}`,
            ]}
            data-team-row={team.id}
            animate:flip={{ duration: settle }}
            style:transform={dragId === team.id ? `translateY(${dragOffset}px)` : undefined}
          >
            <div class={['row', 'glitch-host', renaming === team.id && 'is-renaming']}>
              {#if renaming === team.id}
                <div class="team-rename">
                  <span class="monogram" aria-hidden="true">{monogram(renameDraft.trim() || team.name)}</span>
                  <TextField
                    id={renameFieldId(team.id)}
                    class="rename-field"
                    label={$t('teamNavigation.renameLabel', { team: team.name })}
                    visuallyHiddenLabel
                    bind:value={renameDraft}
                    autocomplete="off"
                    spellcheck="false"
                    onkeydown={(event) => renameKeydown(event, team)}
                    readonly={renameSaving}
                    onblur={() => commitRename(team, false)}
                  />
                </div>
              {:else}
              <ActionLink
                class="team-link"
                data-team-link={team.id}
                variant="ghost"
                href={chatHref(team)}
                aria-current={selected && active === 'chat' ? 'page' : undefined}
                onclick={onnavigate}
              >
                <span class="monogram" aria-hidden="true">{monogram(team.name)}</span>
                <span class="name glitch-text">{team.name}</span>
              </ActionLink>
              {/if}
              <div class="row-actions">
                {#if canReorder}
                  <!-- Pointer only: keyboard and assistive technology reorder from the actions menu. -->
                  <span
                    class="drag-handle"
                    aria-hidden="true"
                    title={$t('teamNavigation.dragHandle', { team: team.name })}
                    onpointerdown={(event) => handleDown(event, team)}
                    onpointermove={handleMove}
                    onpointerup={handleUp}
                    onpointercancel={cancelDrag}
                    onlostpointercapture={(event) => { if (gesture?.pointerId === event.pointerId) cancelDrag(); }}
                  >
                    <svg class="glitch-icon" viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"></path></svg>
                  </span>
                {/if}
                <ActionLink
                  class={['row-action', 'glitch-host', selected && active === 'assistants' && 'is-here']}
                  variant="ghost"
                  href={storeHref(team)}
                  aria-label={$t('teamNavigation.openStore', { team: team.name })}
                  title={$t('teamNavigation.openStore', { team: team.name })}
                  aria-current={selected && active === 'assistants' ? 'page' : undefined}
                  onclick={onnavigate}
                >
                  {#snippet icon()}
                    <svg class="glitch-icon" viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"></path></svg>
                  {/snippet}
                </ActionLink>
                {#if offersRoutines(team.id)}
                  {@const failed = teamRoutines(team.id).failed}
                  {@const attention = failed || routinesNeedAttention(team.id)}
                  {@const routinesLabel = $t(failed
                    ? 'teamNavigation.routinesUnavailable'
                    : attention ? 'teamNavigation.routinesAttention' : 'teamNavigation.routines', { team: team.name })}
                  <!-- The attention dot sits beside the button, not in it, so the button's hover glitch never moves it. -->
                  <span class="routines-slot">
                  <Button
                    class={['row-action', 'routines-action', 'glitch-host', routinesOpen === team.id && 'is-here']}
                    variant="ghost"
                    size="sm"
                    iconOnly
                    type="button"
                    aria-label={routinesLabel}
                    title={routinesLabel}
                    aria-haspopup="dialog"
                    onclick={() => (routinesOpen = team.id)}
                  >
                    <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
                  </Button>
                  {#if attention}<span class="attention" aria-hidden="true"></span>{/if}
                  </span>
                {/if}
                <TeamActionsMenu
                  label={$t('teamNavigation.actions', { team: team.name })}
                  deleteLabel={copy.deleteTeam}
                  renameLabel={copy.rename}
                  onrename={() => startRename(team)}
                  ondelete={() => ondelete(team)}
                  routinesLabel={$t('routine.list.open')}
                  onroutines={offersRoutines(team.id)
                    ? () => (routinesOpen = team.id)
                    : null}
                  moveUpLabel={copy.moveUp}
                  moveDownLabel={copy.moveDown}
                  onmoveup={canReorder ? () => moveTeam(team, -1) : null}
                  onmovedown={canReorder ? () => moveTeam(team, 1) : null}
                  first={index === 0}
                  last={index === $teamContext.teams.length - 1}
                  confirmLabel={copy.confirmActions}
                  confirmation={confirmationSetting(team)}
                />
              </div>
            </div>
            {#if routinesOpen === team.id}
              <TeamRoutinesDialog
                teamId={team.id}
                teamName={team.name}
                routines={teamRoutines(team.id).routines}
                runs={teamRoutines(team.id).runs}
                incidents={teamRoutines(team.id).incidents}
                failed={teamRoutines(team.id).failed}
                onclose={() => closeRoutines(team.id)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    </nav>
  {/if}
  <p class="sr-only" role="status">{announcement}</p>
</div>

<style>
  /* Team rows are full bleed across the sidebar; only the header keeps the sidebar's inset. */
  .team-navigation {
    --team-hover-bg: color-mix(in srgb, var(--shimpz-color-cyan) 7%, var(--shimpz-color-bg));
    --team-scanlines: repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 6%, transparent) 2px 3px);
    display: grid;
    min-width: 0;
    gap: var(--gap-item);
    padding-block: var(--gap-group);
  }
  /* The header is a faint cyberpunk plate: a cyan glow behind the mark, soft scanlines, and a base hairline that fades
     from cyan through magenta. It runs edge to edge, up to the top of the sidebar. */
  .head {
    position: relative; display: flex; min-height: 2.45rem; align-items: center; justify-content: space-between;
    /* The mark lines up with the Team rows' monograms; the new-Team button with their row actions. */
    margin-block-start: calc(-1 * var(--gap-group)); padding: var(--gap-group) var(--gap-item) var(--gap-group) var(--gap-group);
    background:
      repeating-linear-gradient(0deg, rgb(0 240 255 / 3%) 0 1px, transparent 1px 3px),
      radial-gradient(120% 160% at 0% 0%, rgb(0 240 255 / 11%), transparent 62%),
      linear-gradient(180deg, color-mix(in srgb, var(--shimpz-color-cyan) 3%, var(--shimpz-color-bg)), var(--shimpz-color-bg));
  }
  .head::after {
    position: absolute; inset-inline: 0; inset-block-end: 0; height: 1px; content: "";
    background: linear-gradient(90deg, rgb(0 240 255 / 45%), rgb(255 42 109 / 25%) 55%, transparent);
  }
  /* The symbol artwork sits inside ~29% transparent margin; crop the frame to the drawn mark (137–1029 × 151–1025 of
     its 1254 canvas) so the mark keeps its size while the box hugs it and lines up with the Team rows. */
  .head :global(.head-mark) { width: 2.45rem; height: 2.45rem; overflow: hidden; }
  .head :global(.head-mark img) { width: 2.45rem; height: 2.45rem; transform: scale(1.4) translate(3.5%, 3.1%); }
  /* Borderless controls; hover and focus answer with the cyberpunk treatment: a chamfered cyan scanline tint and a
     short chromatic glitch on entry. The chamfered fill is a layer, never a clip on the control, so a keyboard focus ring is never cut. */
  .head :global(.new-team) { position: relative; isolation: isolate; width: 2.25rem; height: 2.25rem; min-height: 0; padding: 0; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-muted); }
  .head :global(.new-team::before), .row::before { content: ""; position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); pointer-events: none; }
  .head :global(.new-team:hover:not(:disabled)), .head :global(.new-team:focus-visible) { color: var(--shimpz-color-cyan); background: transparent; border: 0; box-shadow: none; }
  .head :global(.new-team:hover:not(:disabled)::before), .head :global(.new-team:focus-visible::before) { background: var(--team-scanlines), var(--team-hover-bg); }
  .head svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  ul { display: grid; margin: 0; padding: 0; list-style: none; }
  .teams { gap: 2px; } /* a seam between the rows' own backgrounds, not rhythm */
  .row { --row-bg: var(--shimpz-color-bg); position: relative; isolation: isolate; display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .row::before { background-color: var(--row-bg); transition: background-color var(--shimpz-duration-fast) var(--shimpz-ease); }
  /* The selected Team keeps the hover treatment: the same tint and scanlines. */
  .row:hover, .row:focus-within, .is-selected > .row { --row-bg: var(--team-hover-bg); }
  .row:hover::before, .row:focus-within::before, .is-selected > .row::before { background-image: var(--team-scanlines); }
  .row:hover .monogram { animation: admin-glitch-icon 280ms steps(1, end); }
  /* Row actions always stay visible beside the name, so a Team's Routines and actions are found without hovering. */
  .row-actions { display: flex; align-items: center; padding-inline-end: var(--gap-item); }
  .row :global(.team-link) { min-width: 0; height: auto; min-height: 2.75rem; justify-content: flex-start; padding: var(--gap-inside) var(--gap-group); border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-muted); }
  .team-rename { display: flex; min-width: 0; overflow: hidden; min-height: 2.75rem; align-items: center; gap: var(--gap-item); padding: var(--gap-inside) var(--gap-group); }
  .team-rename :global(.rename-field) { display: block; flex: 1 1 0; width: auto; min-width: 0; }
  .team-rename :global(.rename-field input) { width: 100%; min-width: 0; height: 1.9rem; min-height: 0; padding: 0 var(--gap-inside); color: var(--shimpz-color-text); font: 500 0.95rem/1 var(--shimpz-font-sans); background: color-mix(in srgb, var(--shimpz-color-cyan) 6%, var(--shimpz-color-bg)); border: 0; border-block-end: 1px solid var(--shimpz-color-cyan); clip-path: none; box-shadow: none; }
  .team-rename :global(.rename-field input:focus) { outline: none; box-shadow: 0 1px 0 0 var(--shimpz-color-cyan); }
  .row.is-renaming .row-actions { display: none; }
  .row :global(.team-link .action-link-content) { display: flex; min-width: 0; align-items: center; gap: var(--gap-item); }
  .row :global(.team-link:hover), .is-selected > .row :global(.team-link) { color: var(--shimpz-color-text); }
  .monogram { display: grid; flex: 0 0 auto; width: 1.9rem; height: 1.9rem; place-items: center; color: var(--shimpz-color-text-dim); background: var(--shimpz-color-bg); border: 1px solid var(--shimpz-color-border); font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.04em; }
  .is-selected .monogram { color: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .name { min-width: 0; overflow: hidden; font: 500 0.9rem/1.2 var(--shimpz-font-sans); letter-spacing: 0; text-overflow: ellipsis; text-transform: none; white-space: nowrap; }
  .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.25rem; height: 2.25rem; min-width: 0; min-height: 0; padding: 0; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-dim); }
  .row :global(.row-action:hover), .row :global(.row-action.is-here), .row :global(.team-actions > .shimpz-button:hover),
  .row :global(.team-actions > .shimpz-button[aria-expanded="true"]) { color: var(--shimpz-color-cyan); background: transparent; box-shadow: none; }
  .row :global(.row-action svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .routines-slot { position: relative; display: inline-flex; flex: none; }
  /* A Routine that needs the person, or a list that failed to load: a small yellow dot; the button's name says which. */
  /* The dot's offsets place it on the Routines icon's corner: geometry, not rhythm. */
  .attention { position: absolute; inset-block-start: 0.45rem; inset-inline-end: 0.4rem; width: 0.4rem; height: 0.4rem; border-radius: 50%; background: var(--shimpz-color-yellow); box-shadow: 0 0 0.35rem var(--shimpz-color-yellow); pointer-events: none; }
  @media (forced-colors: active) { .attention { background: Highlight; box-shadow: none; } }
  /* Reordering: a grip in the row actions, the lifted row following the pointer, and a cyan-to-magenta drop line with
     a leading tick in the gap where the row will land. */
  .team { position: relative; }
  .drag-handle { display: grid; width: 1.5rem; height: 2.25rem; flex: 0 0 auto; place-items: center; color: var(--shimpz-color-text-dim); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .drag-handle:hover { color: var(--shimpz-color-cyan); }
  .drag-handle svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 2.8; stroke-linecap: square; }
  .teams.is-reordering, .teams.is-reordering .drag-handle { cursor: grabbing; user-select: none; -webkit-user-select: none; }
  .is-dragging { z-index: 3; }
  .is-dragging > .row { --row-bg: color-mix(in srgb, var(--shimpz-color-cyan) 12%, var(--shimpz-color-surface-raised)); filter: drop-shadow(0 0.6rem 1rem rgb(0 0 0 / 60%)) drop-shadow(0 0 0.4rem rgb(0 240 255 / 30%)); }
  .is-dragging > .row::before { background-image: var(--team-scanlines); }
  .is-dragging .drag-handle, .is-dragging .monogram { color: var(--shimpz-color-cyan); }
  .is-dragging .monogram { border-color: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .drop-before::before, .drop-after::after {
    position: absolute; z-index: 4; inset-inline: 0; height: 6px; content: ""; pointer-events: none;
    background:
      linear-gradient(var(--shimpz-color-cyan), var(--shimpz-color-cyan)) 0 50% / 6px 6px no-repeat,
      linear-gradient(90deg, var(--shimpz-color-cyan), var(--shimpz-color-magenta)) 0 50% / 100% 2px no-repeat;
    filter: drop-shadow(0 0 4px rgb(0 240 255 / 75%));
  }
  :global([dir="rtl"]) .drop-before::before, :global([dir="rtl"]) .drop-after::after { background-position: 100% 50%, 0 50%; }
  /* Centre the 6px drop line on the 2px seam between rows. */
  .drop-before::before { inset-block-start: -4px; }
  .drop-after::after { inset-block-end: -4px; }
  @media (pointer: coarse) {
    .row-actions { padding: 0; }
    .row :global(.row-action), .row :global(.team-actions > .shimpz-button) { width: 2.75rem; height: 2.75rem; }
    .drag-handle { width: 2.25rem; height: 2.75rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .row::before { transition: none; }
    .row .name, .row .monogram, .row :global(svg), .head :global(svg) { animation: none !important; }
  }
  @media (forced-colors: active) {
    .drop-before::before, .drop-after::after { background: Highlight; filter: none; }
    .is-selected > .row { outline: 1px solid Highlight; }
  }
</style>
