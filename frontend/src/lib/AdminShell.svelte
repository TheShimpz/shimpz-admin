<script>
  import AdminNotice from '$lib/AdminNotice.svelte';
  import { t } from '$lib/i18n.js';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import NotificationCenter from '$lib/NotificationCenter.svelte';
  import ShimpzBrand from '$lib/ShimpzBrand.svelte';
  import TeamSidebar from '$lib/TeamSidebar.svelte';

  let { active = '', authenticated = false, children } = $props();
</script>

<a class="skip-link" href="#admin-content">Skip to content</a>

<div class="admin-shell" class:authenticated class:chat-mode={active === 'chat'}>
  {#if !authenticated}
    <header class="topbar">
      <div class="topbar-inner">
        <ShimpzBrand />

        <div class="header-actions">
          <div class="locale-full"><LocaleMenu /></div>
          <div class="locale-compact"><LocaleMenu compact /></div>
        </div>
      </div>
    </header>
  {/if}

  {#if authenticated}
    <aside class="shell-sidebar">
      <div class="sidebar-brand">
        <ShimpzBrand product="Admin" href="/chat/" ariaLabel="Shimpz Admin home" />
        <NotificationCenter />
      </div>
      <div class="sidebar-controls">
        <div class="sidebar-locale">
          <LocaleMenu wide />
        </div>
        <div class="sidebar-navigation">
          <a
            class="rail-button"
            class:active={active === 'assistants'}
            href="/assistants/"
            aria-current={active === 'assistants' ? 'page' : undefined}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z"></path>
            </svg>
            <span>{$t('store.nav')}</span>
            <small aria-hidden="true">// 01</small>
          </a>
          <a
            class="rail-button"
            class:active={active === 'chat'}
            href="/chat/"
            aria-current={active === 'chat' ? 'page' : undefined}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5.5h14v10H9l-4 3v-13Z"></path>
              <path d="M8.5 9h7M8.5 12h4.5"></path>
            </svg>
            <span>{$t('chat.nav')}</span>
            <small aria-hidden="true">// 02</small>
          </a>
        </div>
      </div>
      <div class="team-sidebar-region">
        <TeamSidebar {active} />
      </div>
    </aside>
  {/if}

  <main id="admin-content" class="workspace">
    {#if authenticated}<AdminNotice />{/if}
    <div class="content-stage">
      <div class="content-frame">
        {@render children()}
      </div>
    </div>
  </main>
</div>

<style>
  .skip-link {
    position: fixed;
    z-index: 120;
    top: 0.75rem;
    inset-inline-start: 1rem;
    padding: 0.6rem 0.85rem;
    background: var(--text);
    color: var(--bg);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    text-decoration: none;
    transform: translateY(-180%);
  }

  .skip-link:focus {
    transform: translateY(0);
  }

  .admin-shell {
    --admin-divider: var(--border-strong);
    display: grid;
    width: 100%;
    min-width: 0;
    min-height: 100vh;
    min-height: 100dvh;
    grid-template:
      'header' auto
      'main' minmax(0, 1fr) /
      minmax(0, 1fr);
  }

  .admin-shell.authenticated {
    height: 100vh;
    height: 100dvh;
    grid-template:
      'sidebar main' minmax(0, 1fr) /
      minmax(18rem, 20rem) minmax(0, 1fr);
    overflow: hidden;
  }

  .admin-shell.chat-mode {
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  .topbar {
    min-width: 0;
    grid-area: header;
    border-bottom: 1px solid var(--admin-divider);
    background: rgba(0, 0, 0, 0.82);
  }

  .topbar-inner {
    display: grid;
    width: 100%;
    min-width: 0;
    min-height: 5.25rem;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    padding: 0 clamp(1rem, 2.4vw, 2rem);
  }

  .header-actions {
    display: flex;
    min-width: 0;
    grid-column: 2;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
    margin-inline-start: auto;
  }

  .locale-compact {
    display: none;
  }

  .shell-sidebar {
    display: grid;
    min-width: 0;
    min-height: 0;
    grid-area: sidebar;
    grid-template-rows: auto auto minmax(0, 1fr);
    border-inline-end: 1px solid var(--admin-divider);
    background: rgba(3, 3, 3, 0.76);
    overflow: hidden;
  }

  .sidebar-brand {
    display: grid;
    min-width: 0;
    min-height: 4.5rem;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0 1.15rem;
  }

  .sidebar-controls {
    display: grid;
    min-width: 0;
    padding-bottom: 1rem;
  }

  .sidebar-locale {
    min-width: 0;
    padding: 0 1.15rem 0.65rem;
  }

  .sidebar-navigation {
    display: grid;
    min-width: 0;
    gap: 0.65rem;
    padding: 0.65rem 1.15rem 0;
    border-top: 1px solid var(--admin-divider);
  }

  .rail-button {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 3.15rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.7rem;
    padding: 0 0.8rem;
    background:
      linear-gradient(100deg, rgba(0, 240, 255, 0.1), transparent 58%),
      #050708;
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-decoration: none;
    text-transform: uppercase;
    transition: color 0.16s ease, filter 0.16s ease;
  }

  .rail-button::before {
    position: absolute;
    inset-block: 0.4rem;
    inset-inline-start: 0;
    width: 2px;
    background: var(--accent);
    box-shadow: 0 0 10px rgba(0, 240, 255, 0.5);
    content: '';
  }

  .rail-button:hover,
  .rail-button.active {
    color: var(--accent);
    filter: drop-shadow(0 0 8px rgba(0, 240, 255, 0.2));
  }

  .rail-button.active {
    background:
      linear-gradient(100deg, rgba(0, 240, 255, 0.17), transparent 68%),
      #050708;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .rail-button svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: square;
    stroke-linejoin: miter;
    stroke-width: 1.6;
  }

  .rail-button span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-button small {
    color: var(--text-faint);
    font-size: 0.48rem;
    letter-spacing: 0.08em;
  }

  .team-sidebar-region {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .workspace {
    display: grid;
    min-width: 0;
    min-height: 0;
    grid-area: main;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  .content-stage {
    min-width: 0;
    min-height: 0;
    grid-row: 2;
    padding: clamp(1.75rem, 4vw, 3.25rem);
    overflow: auto;
  }

  .content-frame {
    width: min(100%, 1180px);
    min-width: 0;
    min-height: 0;
    margin: 0 auto;
  }

  .chat-mode .workspace {
    overflow: hidden;
  }

  .chat-mode .content-stage {
    padding: 0;
    overflow: hidden;
  }

  .chat-mode .content-frame {
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
  }

  @media (max-width: 760px) {
    .topbar-inner {
      min-height: 4.75rem;
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 0;
      padding: 0 0.75rem;
    }

    .header-actions {
      grid-row: 1;
      grid-column: 2;
    }

    .admin-shell.authenticated {
      grid-template:
        'sidebar' auto
        'main' minmax(0, 1fr) /
        minmax(0, 1fr);
    }

    .shell-sidebar {
      grid-template-rows: auto auto minmax(0, auto);
      border-inline-end: 0;
      overflow: visible;
    }

    .team-sidebar-region {
      max-height: 10rem;
    }

    .content-stage {
      padding: 1.25rem 0.75rem;
    }

    .chat-mode .shell-sidebar {
      overflow: hidden;
    }
  }

  @media (max-width: 760px) and (max-height: 600px) {
    .chat-mode .shell-sidebar {
      grid-template-rows: auto auto minmax(0, 1fr);
    }

    .chat-mode .team-sidebar-region {
      max-height: 5.25rem;
    }
  }

  @media (max-width: 380px) {
    .locale-full {
      display: none;
    }

    .locale-compact {
      display: block;
    }
  }

  @media (max-width: 420px) {
    .header-actions { gap: 0.3rem; }
    .sidebar-locale,
    .sidebar-navigation { padding-inline: 0.75rem; }
  }
</style>
