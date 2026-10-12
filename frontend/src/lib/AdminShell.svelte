<script>
  import { Button, Modal, ShimpzBrand, WorkspaceShell } from '@shimpz/frontend';
  import { getContext, onDestroy, onMount, untrack } from 'svelte';
  import AdminNotice from '#lib/AdminNotice.svelte';
  import { adminSocket, connectAdminSocket, trackActivity, watchTopic } from '#lib/adminSocket.js';
  import { t } from '#lib/i18n.js';
  import LocaleMenu from '#lib/LocaleMenu.svelte';
  import PlatformReleaseStatus from '#lib/PlatformReleaseStatus.svelte';
  import SecurityAlert from '#lib/SecurityAlert.svelte';
  import SecurityDialog from '#lib/SecurityDialog.svelte';
  import SpaceResources from '#lib/SpaceResources.svelte';
  import SessionExpiryWarning from '#lib/SessionExpiryWarning.svelte';
  import { SESSION_ENDED, setSessionContext } from '#lib/sessionContext.js';
  import SupervisorMenu from '#lib/SupervisorMenu.svelte';
  import { teamListChanged } from '#lib/teamContext.js';
  import TeamDialogs from '#lib/TeamDialogs.svelte';
  import TeamNavigation from '#lib/TeamNavigation.svelte';
  import TeamSidebar from '#lib/TeamSidebar.svelte';

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

  // What the session bootstrap answers changed (an admitted origin, for instance): read it again over HTTP. The sign-in
  // flow read it just before the socket first opened.
  async function refreshSession(_topic, cause) {
    if (cause === 'open') return;
    try {
      const response = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      const session = response.ok ? await response.json() : null;
      if (session?.authenticated === false) sessionEnded?.();
      else if (session?.authenticated === true) setSessionContext(session);
    } catch {
      // The next change or reconnect asks again.
    }
  }

  // Teams made or removed elsewhere (another tab, the CLI) change the list; a reopened socket reads it again too. The
  // Team context reads it itself as the shell first opens, and reads a change announced while it loads once it is done.
  function refreshTeams(_topic, cause) {
    if (cause !== 'open') teamListChanged(fetch);
  }

  // Opened as the shell starts, before any screen inside it reads, and closed with it.
  if (untrack(() => authenticated)) {
    const disconnect = connectAdminSocket({ onSignedOut: () => sessionEnded?.() });
    // The person's own input, and nothing the page does on its own, keeps the session alive.
    const stops = [watchTopic('teams', refreshTeams), watchTopic('session', refreshSession), trackActivity()];
    onDestroy(() => {
      for (const stop of stops) stop();
      disconnect();
    });
  }
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
        <SpaceResources>
          {#snippet lead()}<PlatformReleaseStatus />{/snippet}
        </SpaceResources>
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
            <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
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
        {#if reconnecting}
          <p class="socket-status" class:failed={$adminSocket.phase === 'failed'} role="status">
            {$t($adminSocket.phase === 'failed' ? 'shell.reconnectFailed' : 'shell.reconnecting')}
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
  .sidebar-footer > :global(.platform-release) { justify-content: center; border-block-start: 0; }

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
