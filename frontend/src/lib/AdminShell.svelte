<script>
  import { Button, Modal, ShimpzBrand, WorkspaceShell } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import AdminNotice from '$lib/AdminNotice.svelte';
  import { t } from '$lib/i18n.js';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import PlatformReleaseStatus from '$lib/PlatformReleaseStatus.svelte';
  import TeamDialogs from '$lib/TeamDialogs.svelte';
  import TeamNavigation from '$lib/TeamNavigation.svelte';
  import TeamSidebar from '$lib/TeamSidebar.svelte';

  let { active = '', authenticated = false, profile = '', children } = $props();
  let chat = $derived(active === 'chat');
  let mobile = $state(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );
  let teamDialogs = $state();
  let teamDrawer = $state();
  let teamDrawerTrigger = $state();
  let createButton = $state();

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
</script>

{#snippet sidebar()}
  {#if mobile}
    <div class="mobile-footer">
      {#if profile === 'local'}<PlatformReleaseStatus />{/if}
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
          routines={profile === 'local'}
        />
        <TeamSidebar {active} />
      </div>
      <div class="sidebar-footer">
        <LocaleMenu wide />
        {#if profile === 'local'}<PlatformReleaseStatus />{/if}
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
          routines={profile === 'local'}
          onnavigate={closeTeamDrawer}
        />
      </Modal>
    {/if}
    <div class:chat-layout={chat} class="authenticated-content">
      <div class="admin-notice-region"><AdminNotice /></div>
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
  .authenticated-content { min-height: 100%; }
  .admin-notice-region { width: 100%; }
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
  .sidebar-footer { display: grid; min-width: 0; gap: var(--shimpz-space-2); padding-block-start: var(--shimpz-space-3); border-block-start: 1px solid var(--shimpz-color-border); }
  .sidebar-footer > :global(.shimpz-dropdown) { width: auto; margin-inline: var(--shimpz-space-4); }
  .sidebar-footer > :global(.platform-release) { justify-content: center; border-block-start: 0; }

  .menu-icon { width: 1.25rem; height: 1.25rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
  :global(dialog.shimpz-modal.team-drawer) { margin: 0; width: min(20rem, calc(100dvw - 3rem)); max-height: 100dvh; height: 100dvh; background: var(--shimpz-color-surface); border-inline-end: 1px solid var(--shimpz-color-border); }
  .team-drawer-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; padding: var(--shimpz-space-3) var(--shimpz-space-4) 0; }
  .team-drawer-head h2 { margin: 0; color: var(--shimpz-color-text-dim); font: 700 0.72rem/1 var(--shimpz-font-mono); letter-spacing: 0.09em; text-transform: uppercase; }
  .team-sidebar-region { min-width: 0; min-height: 0; overflow: auto; }
  .mobile-team-region { min-width: 0; }
  .mobile-appbar,
  .mobile-footer { display: none; }
  .topbar { display: grid; min-height: 3.75rem; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-3); padding-inline: var(--shimpz-page-padding); }
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
      gap: var(--shimpz-space-2);
      padding-inline: var(--shimpz-space-3);
    }
    .mobile-footer {
      display: flex;
      min-width: 0;
      align-items: center;
      justify-content: space-between;
      gap: var(--shimpz-space-2);
      padding-inline-end: var(--shimpz-space-3);
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
