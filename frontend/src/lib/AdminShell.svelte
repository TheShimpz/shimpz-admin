<script>
  import { NavItem, ShimpzBrand, WorkspaceShell } from '@shimpz/frontend';
  import AdminNotice from '$lib/AdminNotice.svelte';
  import { t } from '$lib/i18n.js';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import NotificationCenter from '$lib/NotificationCenter.svelte';
  import TeamSidebar from '$lib/TeamSidebar.svelte';

  let { active = '', authenticated = false, children } = $props();
  let chat = $derived(active === 'chat');
</script>

{#snippet sidebar()}
  <div class="shell-sidebar">
    <div class="sidebar-brand">
      <ShimpzBrand product="Admin" href="/chat/" ariaLabel={$t('shell.adminHome')} />
      <NotificationCenter />
    </div>
    <div class="sidebar-controls">
      <LocaleMenu wide />
      <nav aria-label={$t('shell.adminHome')}>
        <NavItem href="/assistants/" active={active === 'assistants'} index="01">{$t('store.nav')}</NavItem>
        <NavItem href="/chat/" active={active === 'chat'} index="02">{$t('chat.nav')}</NavItem>
      </nav>
    </div>
    <div class="team-sidebar-region"><TeamSidebar {active} /></div>
  </div>
{/snippet}

{#snippet header()}
  <div class="topbar">
    <ShimpzBrand />
    <div class="locale-full"><LocaleMenu /></div>
    <div class="locale-compact"><LocaleMenu compact /></div>
  </div>
{/snippet}

<WorkspaceShell
  class={[authenticated && 'authenticated', chat && 'chat-mode']}
  sidebar={authenticated ? sidebar : undefined}
  header={authenticated ? undefined : header}
  skipLabel={$t('shell.skipContent')}
  mainId="admin-content"
  content={chat ? 'full' : 'contained'}
  padding={chat ? 'none' : 'default'}
  fixed={authenticated}
  scroll={chat ? 'hidden' : 'auto'}
>

  {#if authenticated}<AdminNotice />{/if}
  {@render children()}
</WorkspaceShell>

<style>
  .shell-sidebar { display: grid; min-width: 0; min-height: 100%; grid-template-rows: auto auto minmax(0, 1fr); }
  .sidebar-brand { display: grid; min-width: 0; min-height: 3.75rem; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-2); padding-inline: var(--shimpz-space-4); }
  .sidebar-controls { display: grid; min-width: 0; gap: var(--shimpz-space-3); padding: 0 var(--shimpz-space-4) var(--shimpz-space-3); border-block-end: 1px solid var(--shimpz-color-border); }
  nav { display: grid; gap: var(--shimpz-space-2); }
  .team-sidebar-region { min-width: 0; min-height: 0; overflow: auto; }
  .topbar { display: grid; min-height: 3.75rem; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-3); padding-inline: var(--shimpz-page-padding); }
  .locale-compact { display: none; }
  @media (max-width: 820px) {
    .shell-sidebar { min-height: 0; }
    .team-sidebar-region { max-height: 9rem; }
  }
  @media (max-width: 380px) { .locale-full { display: none; } .locale-compact { display: block; } }
</style>
