<script>
  import { NavItem, ShimpzBrand, WorkspaceShell } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import AdminNotice from '$lib/AdminNotice.svelte';
  import { t } from '$lib/i18n.js';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import NotificationCenter from '$lib/NotificationCenter.svelte';
  import PlatformReleaseStatus from '$lib/PlatformReleaseStatus.svelte';
  import TeamSidebar from '$lib/TeamSidebar.svelte';

  let { active = '', authenticated = false, profile = '', children } = $props();
  let chat = $derived(active === 'chat');
  let mobile = $state(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
  );

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
    <div class="mobile-navigation">
      {#if profile === 'local'}<PlatformReleaseStatus />{/if}
      <nav aria-label={$t('shell.primaryNav')}>
        <NavItem href="/assistants/" active={active === 'assistants'} index="01">{$t('store.nav')}</NavItem>
        <NavItem href="/chat/" active={active === 'chat'} index="02">{$t('chat.nav')}</NavItem>
      </nav>
    </div>
  {:else}
    <div class="shell-sidebar">
      <div class="sidebar-brand">
        <ShimpzBrand product="Admin" href="/chat/" ariaLabel={$t('shell.adminHome')} />
        <NotificationCenter />
      </div>
      <div class="sidebar-controls">
        <LocaleMenu wide />
        <nav aria-label={$t('shell.primaryNav')}>
          <NavItem href="/assistants/" active={active === 'assistants'} index="01">{$t('store.nav')}</NavItem>
          <NavItem href="/chat/" active={active === 'chat'} index="02">{$t('chat.nav')}</NavItem>
        </nav>
      </div>
      <div class="team-sidebar-region"><TeamSidebar {active} /></div>
      {#if profile === 'local'}<PlatformReleaseStatus />{/if}
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
    <ShimpzBrand product="Admin" href="/chat/" ariaLabel={$t('shell.adminHome')} />
    <div class="mobile-appbar-actions">
      <LocaleMenu compact />
      <NotificationCenter />
    </div>
  </div>
{/snippet}

<WorkspaceShell
  class={['admin-workspace-shell', authenticated && 'authenticated', chat && 'chat-mode']}
  sidebar={authenticated ? sidebar : undefined}
  header={authenticated ? (mobile ? mobileHeader : undefined) : header}
  skipLabel={$t('shell.skipContent')}
  mainId="admin-content"
  content={authenticated ? 'full' : 'contained'}
  padding={authenticated ? 'none' : 'default'}
  fixed={authenticated}
  scroll={chat ? 'hidden' : 'auto'}
>
  {#if authenticated}
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
  .shell-sidebar { display: grid; min-width: 0; min-height: 100%; grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .sidebar-brand { display: grid; min-width: 0; min-height: 3.75rem; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-2); padding-inline: var(--shimpz-space-4); }
  .sidebar-controls { display: grid; min-width: 0; gap: var(--shimpz-space-3); padding: 0 var(--shimpz-space-4) var(--shimpz-space-3); border-block-end: 1px solid var(--shimpz-color-border); }
  nav { display: grid; gap: var(--shimpz-space-2); }
  .team-sidebar-region { min-width: 0; min-height: 0; overflow: auto; }
  .mobile-team-region { min-width: 0; }
  .mobile-appbar,
  .mobile-navigation { display: none; }
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
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--shimpz-space-2);
      padding-inline: var(--shimpz-space-3);
    }
    .mobile-appbar-actions {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: var(--shimpz-space-1);
    }
    .mobile-appbar-actions :global(button) {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }
    .mobile-navigation {
      display: grid;
      min-width: 0;
      border-block-start: 1px solid var(--shimpz-color-border);
      background: var(--shimpz-color-surface);
    }
    .mobile-navigation nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0;
    }
    .mobile-navigation :global(.shimpz-nav-item) {
      min-width: 0;
      border-block: 0;
      border-inline-start: 0;
    }
    .mobile-navigation :global(.shimpz-nav-item:last-child) {
      border-inline-end: 0;
    }
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
