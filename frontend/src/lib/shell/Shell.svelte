<script>
  import { Button, Modal, ShimpzBrand, WorkspaceShell } from '@shimpz/frontend';
  import { getContext, onDestroy, onMount, untrack } from 'svelte';
  import AdminNotice from '#lib/shell/Notice.svelte';
  import { adminSocket, connectAdminSocket, servedRevision, trackActivity, watchTopic } from '#lib/session/socket.js';
  import { warmAssistantSources } from '#lib/assistants/sources.js';
  import { PATHS } from '#lib/icons.js';
  import { INITIAL_VIEW_READINESS } from '#lib/shell/initialView.js';
  import { teamContext } from '#lib/teams/context.js';
  import { dataUnavailable } from '#lib/session/synced.js';
  import { locale, t } from '#lib/i18n/index.js';
  import LocaleMenu from '#lib/i18n/LocaleMenu.svelte';
  import PlatformReleaseStatus from '#lib/space/ReleaseStatus.svelte';
  import { reloadFresh, versionState } from '#lib/space/version.js';
  import SecurityAlert from '#lib/auth/SecurityAlert.svelte';
  import SecurityDialog from '#lib/auth/SecurityDialog.svelte';
  import SessionExpiryWarning from '#lib/session/ExpiryWarning.svelte';
  import { readSession, SESSION_ENDED, setSessionContext } from '#lib/session/context.js';
  import SupervisorMenu from '#lib/shell/SupervisorMenu.svelte';
  import TeamDialogs from '#lib/teams/Dialogs.svelte';
  import TeamNavigation from '#lib/teams/Navigation.svelte';
  import TeamSidebar from '#lib/teams/Sidebar.svelte';

  let { active = '', authenticated = false, children } = $props();
  let chat = $derived(active === 'chat');
  let mobile = $state(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  let teamDialogs = $state();
  let teamDrawer = $state();
  let teamDrawerTrigger = $state();
  let createButton = $state();
  let securityDialog = $state();
  let securityTrigger = $state();

  function closeTeamDrawer() {
    teamDrawer?.close();
  }

  function createTeam() {
    closeTeamDrawer();
    teamDialogs?.openCreate();
  }

  function deleteTeam(team) {
    closeTeamDrawer();
    teamDialogs?.openDelete(team);
  }

  function restoreTeamFocus() {
    queueMicrotask(() => (mobile ? teamDrawerTrigger : createButton)?.focus());
  }

  onMount(() => {
    const query = window.matchMedia('(max-width: 820px)');
    const update = () => { mobile = query.matches; };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  // The signed-in shell owns the tab's one session socket (ADR-0114): every screen reads through it, and Admin closing
  // it as signed out hands the page back to the sign-in flow, which clears every protected cache.
  const sessionEnded = getContext(SESSION_ENDED);
  let reconnecting = $derived(['reconnecting', 'failed'].includes($adminSocket.phase));
  // The one message about Admin's availability, the most pressing first: offline, then reconnecting or unreachable,
  // then data Admin keeps failing to read while it is read again on its own.
  let availability = $derived(
    reconnecting
      ? $adminSocket.offline
        ? 'shell.offline'
        : $adminSocket.phase === 'failed' ? 'shell.reconnectFailed' : 'shell.reconnecting'
      : $dataUnavailable ? 'shell.dataUnavailable' : '',
  );

  // A tab built from another commit than the Admin it reaches is stale: it says so over every page and reloads only when
  // the person asks, since a reload would lose a draft or a turn under way.
  let stale = $derived(versionState(__ADMIN_REVISION__, $servedRevision) === 'stale');

  // What the session bootstrap answers changed (an admitted origin, for instance): read it again over HTTP. The sign-in
  // flow read it just before the socket first opened.
  async function refreshSession(_topic, cause) {
    if (cause === 'open') return;
    try {
      const session = await readSession();
      if (session?.authenticated === false) sessionEnded?.();
      else if (session?.authenticated === true) setSessionContext(session);
    } catch {
      // The next change or reconnect asks again.
    }
  }

  // Opened as the shell starts, before any screen inside it reads, and closed with it.
  if (untrack(() => authenticated)) {
    const disconnect = connectAdminSocket({ onSignedOut: () => sessionEnded?.() });
    // The person's own input, and nothing the page does on its own, keeps the session alive.
    const stops = [
      watchTopic('session', refreshSession),
      trackActivity(),
    ];
    onDestroy(() => {
      for (const stop of stops) stop();
      disconnect();
    });
  }

  // Once the first view is up and the Team context is ready, the Store's data and icons are read while the browser is
  // idle, so opening the Store shows them at once; the session's end drops what this reads (clearAssistantSources).
  const booting = getContext(INITIAL_VIEW_READINESS)?.booting;
  const warmUp = { started: false, idle: null, stop: null };
  $effect(() => {
    if (!authenticated || warmUp.started || ($booting ?? false) || $teamContext.phase !== 'ready') return;
    warmUp.started = true;
    const whenIdle = globalThis.requestIdleCallback ?? ((run) => globalThis.setTimeout(run, 200));
    warmUp.idle = whenIdle(() => {
      warmUp.idle = null;
      warmUp.stop = warmAssistantSources(untrack(() => $locale));
    }, { timeout: 2000 });
  });
  onDestroy(() => {
    if (warmUp.idle !== null) (globalThis.cancelIdleCallback ?? globalThis.clearTimeout)(warmUp.idle);
    warmUp.stop?.();
  });
</script>

{#snippet securityButton()}
  <Button bind:element={securityTrigger} class="security-open" variant="ghost" size="sm" type="button" aria-haspopup="dialog" onclick={() => securityDialog?.open()}>
    <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"></path></svg>
    {$t('security.open')}
  </Button>
{/snippet}

{#snippet supervisorMenu()}
  <SupervisorMenu onsecurity={() => securityDialog?.open()} />
{/snippet}

{#snippet sidebar()}
  {#if mobile}
    <div class="mobile-footer">
      <PlatformReleaseStatus />
      {@render securityButton()}
      <LocaleMenu compact />
    </div>
  {:else}
    <div class="shell-sidebar">
      <div class="team-sidebar-region">
        <TeamNavigation
          {active}
          bind:createButton
          oncreate={createTeam}
          ondelete={deleteTeam}
          account={supervisorMenu}
        />
        <TeamSidebar {active} />
      </div>
      <div class="sidebar-footer">
        <LocaleMenu wide />
        <PlatformReleaseStatus />
      </div>
    </div>
  {/if}
{/snippet}

{#snippet header()}
  <div class="topbar">
    <ShimpzBrand />
    <div class="locale-full"><LocaleMenu /></div>
    <div class="locale-compact"><LocaleMenu compact /></div>
  </div>
{/snippet}

{#snippet mobileHeader()}
  <div class="mobile-appbar">
    <Button
      bind:element={teamDrawerTrigger}
      variant="ghost"
      size="sm"
      iconOnly
      type="button"
      aria-label={$t('teamNavigation.open')}
      aria-haspopup="dialog"
      onclick={() => teamDrawer?.showModal()}
    >
      <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
    </Button>
    <ShimpzBrand product="Admin" href="/chat/" ariaLabel={$t('shell.adminHome')} />
  </div>
{/snippet}

<WorkspaceShell
  class={['admin-workspace-shell', authenticated && 'authenticated', chat && 'chat-mode']}
  sidebar={authenticated ? sidebar : undefined}
  header={authenticated ? (mobile ? mobileHeader : undefined) : header}
  content={authenticated ? 'full' : 'contained'}
  padding={authenticated ? 'none' : 'default'}
  fixed={authenticated}
  scroll={chat ? 'hidden' : 'auto'}
>
  {#if authenticated}
    <TeamDialogs bind:this={teamDialogs} onsettled={restoreTeamFocus} />
    <SecurityDialog
      bind:this={securityDialog}
      onclose={() => queueMicrotask(() => (mobile ? securityTrigger : document.querySelector('.supervisor-menu .trigger'))?.focus())}
    />
    {#if mobile}
      <Modal class="team-drawer" bind:element={teamDrawer} labelledBy="team-drawer-title">
        <div class="team-drawer-head">
          <h2 id="team-drawer-title">{$t('teamNavigation.label')}</h2>
          <Button variant="ghost" size="sm" iconOnly type="button" aria-label={$t('teamNavigation.close')} onclick={closeTeamDrawer}>
            <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS.close.join('')}></path></svg>
          </Button>
        </div>
        <TeamNavigation
          {active}
          oncreate={createTeam}
          ondelete={deleteTeam}
          onnavigate={closeTeamDrawer}
        />
      </Modal>
    {/if}
    <div class:chat-layout={chat} class="authenticated-content">
      <div class="admin-notice-region">
        {#if availability}
          <!-- The one place that speaks about Admin's availability; pages never add their own. -->
          <p class="socket-status" class:failed={reconnecting && ($adminSocket.phase === 'failed' || $adminSocket.offline)} role="status">
            {$t(availability)}
          </p>
        {/if}
        {#if stale}
          <p class="version-status" role="status">
            <span>{$t('shell.versionStale')}</span>
            <Button variant="ghost" size="sm" type="button" onclick={reloadFresh}>{$t('shell.versionReload')}</Button>
          </p>
        {/if}
        <SecurityAlert /><AdminNotice />
      </div>
      <SessionExpiryWarning />
      {#if mobile}<div class="mobile-team-region"><TeamSidebar {active} /></div>{/if}
      <div class="authenticated-page">{@render children()}</div>
    </div>
  {:else}
    {@render children()}
  {/if}
</WorkspaceShell>

<style>
  .authenticated-content,
  .authenticated-page { min-width: 0; }
  .authenticated-content { min-height: 100%; container-type: inline-size; }
  .admin-notice-region { width: 100%; }
  /* Reconnecting reads as a square full-width warning in the design system's yellow; a reconnect that gave up, in its
     danger colour. */
  .socket-status { margin: 0; padding: var(--gap-item) var(--gap-group); color: var(--shimpz-color-yellow); background: color-mix(in srgb, var(--shimpz-color-yellow) 12%, var(--shimpz-color-bg)); font-size: 0.8rem; text-align: center; border-radius: 0; }
  .version-status { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: var(--gap-item); margin: 0; padding: var(--gap-inside) var(--gap-group); color: var(--shimpz-color-cyan); background: color-mix(in srgb, var(--shimpz-color-cyan) 10%, var(--shimpz-color-bg)); font-size: 0.8rem; text-align: center; border-radius: 0; }
  .version-status :global(.shimpz-button) { --button-color: var(--shimpz-color-cyan); --button-border: color-mix(in srgb, var(--shimpz-color-cyan) 40%, transparent) !important; }
  .socket-status.failed { color: var(--shimpz-color-danger); background: color-mix(in srgb, var(--shimpz-color-danger) 14%, var(--shimpz-color-bg)); }
  .admin-notice-region :global(.admin-toast) { margin-block-end: 0; border: 0; }
  .authenticated-page {
    width: min(
      calc(100% - var(--shimpz-page-padding) - var(--shimpz-page-padding)),
      var(--shimpz-content-width)
    );
    margin-inline: auto;
    padding-block: var(--shimpz-page-padding);
  }
  .chat-layout { display: grid; height: 100%; min-height: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
  .chat-layout .authenticated-page { width: 100%; min-height: 0; margin: 0; padding: 0; overflow: hidden; }
  .shell-sidebar { display: grid; min-width: 0; min-height: 100%; grid-template-rows: minmax(0, 1fr) auto; }
  .sidebar-footer { display: grid; min-width: 0; gap: var(--gap-item); padding-block-start: var(--gap-group); }
  .sidebar-footer > :global(.shimpz-dropdown) { width: auto; margin-inline: var(--gap-group); }
  .sidebar-footer > :global(.security-open) { justify-self: stretch; margin-inline: var(--gap-group); }
  /* The sidebar ends with the Admin version alone. */
  .sidebar-footer > :global(.platform-release) { justify-content: center; min-height: 0; padding: 0.25rem var(--gap-group) 1.25rem; border-block-start: 0; font-size: 0.64rem; letter-spacing: 0.02em; }
  .sidebar-footer > :global(.platform-release .indicator) { display: none; }

  .menu-icon { width: 1.25rem; height: 1.25rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  :global(dialog.shimpz-modal.team-drawer) { margin: 0; width: min(20rem, calc(100dvw - 3rem)); max-height: 100dvh; height: 100dvh; background: var(--shimpz-color-surface); border-inline-end: 1px solid var(--shimpz-color-border); }
  .team-drawer-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: var(--gap-group) var(--gap-group) 0; }
  .team-drawer-head h2 { margin: 0; color: var(--shimpz-color-text-dim); font: 700 0.72rem/1 var(--shimpz-font-mono); letter-spacing: 0.09em; text-transform: uppercase; }
  .team-sidebar-region { min-width: 0; min-height: 0; overflow: auto; }
  .mobile-team-region { min-width: 0; }
  .mobile-appbar,
  .mobile-footer { display: none; }
  .topbar { display: grid; min-height: 3.75rem; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--gap-group); padding-inline: var(--shimpz-page-padding); }
  .locale-compact { display: none; }
  @media (max-width: 820px) {
    :global(.admin-workspace-shell.authenticated) {
      grid-template-rows: minmax(0, 1fr) auto;
    }
    :global(.admin-workspace-shell.authenticated > [data-slot="workspace-stage"]) {
      grid-row: 1;
    }
    :global(.admin-workspace-shell.authenticated > [data-slot="workspace-sidebar"]) {
      grid-row: 2;
      min-width: 0;
      border-block-end: 0;
      overflow: visible;
    }
    :global(.admin-workspace-shell.authenticated [data-slot="workspace-main"]) {
      overscroll-behavior: contain;
    }
    .mobile-appbar {
      display: grid;
      min-height: 3.75rem;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--gap-item);
      padding-inline: var(--gap-group);
    }
    .mobile-footer {
      display: flex;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: var(--gap-item);
      padding-inline-end: var(--gap-group);
      border-block-start: 1px solid var(--shimpz-color-border);
      background: var(--shimpz-color-surface);
    }
    .mobile-footer > :global(:last-child) { margin-inline-start: auto; }
    .mobile-footer > :global(.platform-release) { border-block-start: 0; }
    .mobile-footer :global(.shimpz-dropdown .trigger) { min-width: 2.75rem; min-height: 2.75rem; }
    .mobile-team-region :global(.context-error) {
      border-inline: 0;
    }
    .mobile-team-region :global(.context-error button) {
      min-height: 2.75rem;
    }
    .chat-layout {
      grid-template-rows: auto auto minmax(0, 1fr);
    }
  }
  @media (max-width: 380px) { .locale-full { display: none; } .locale-compact { display: block; } }
</style>
