<script>
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import ShimpzBrand from '$lib/ShimpzBrand.svelte';
  import TeamSidebar from '$lib/TeamSidebar.svelte';
  import { t } from '$lib/i18n.js';

  let { active = '', authenticated = false, onLogout, children } = $props();

  const navigation = [
    { id: 'chat', label: 'chat.nav', href: '/chat/' },
    { id: 'capsules', label: 'workspace.capsulesKicker', href: '/capsules/' },
    { id: 'assistants', label: 'store.nav', href: '/assistants/' },
  ];
</script>

<a class="skip-link" href="#admin-content">Skip to content</a>

<div class="admin-shell" class:authenticated class:chat-mode={active === 'chat'}>
  <header class="topbar">
    <div class="topbar-inner">
      <ShimpzBrand />

      {#if authenticated}
        <nav class="primary-nav" aria-label="Admin">
          {#each navigation as item (item.id)}
            <a
              href={item.href}
              class:active={active === item.id}
              aria-current={active === item.id ? 'page' : undefined}
            >
              {$t(item.label)}
            </a>
          {/each}
        </nav>
      {/if}

      <div class="header-actions">
        <LocaleMenu />
        {#if authenticated}
          <button class="logout" type="button" onclick={() => onLogout?.()} aria-label={$t('auth.logout')}>
            <span>{$t('auth.logout')}</span>
            <b aria-hidden="true">↪</b>
          </button>
        {/if}
      </div>
    </div>
  </header>

  {#if authenticated}
    <aside class="shell-sidebar">
      <div class="team-sidebar-region">
        <TeamSidebar {active} />
      </div>

      <div class="local-status">
        <i aria-hidden="true"></i>
        <span>Local Space</span>
      </div>
    </aside>
  {/if}

  <main id="admin-content" class="workspace">
    <div class="content-frame">
      {@render children()}
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
    grid-template:
      'header header' auto
      'sidebar main' minmax(0, 1fr) /
      minmax(18rem, 20rem) minmax(0, 1fr);
  }

  .admin-shell.chat-mode {
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  .topbar {
    min-width: 0;
    grid-area: header;
    border-bottom: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.82);
  }

  .topbar-inner {
    display: grid;
    width: 100%;
    min-width: 0;
    min-height: 5.25rem;
    grid-template-columns: minmax(12rem, 1fr) auto minmax(12rem, 1fr);
    align-items: center;
    gap: 1rem;
    padding: 0 clamp(1rem, 2.4vw, 2rem);
  }

  .header-actions {
    display: flex;
    min-width: 0;
    grid-column: 3;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
  }

  .logout {
    display: inline-flex;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    border: 0;
    padding: 0 0.9rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    color: var(--text-dim);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .logout b {
    color: var(--accent);
  }

  .logout:hover {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .shell-sidebar {
    display: grid;
    min-width: 0;
    min-height: 0;
    grid-area: sidebar;
    grid-template-rows: minmax(0, 1fr) auto;
    border-inline-end: 1px solid var(--border);
    background: rgba(3, 3, 3, 0.76);
    overflow: hidden;
  }

  .primary-nav {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
  }

  .primary-nav a {
    position: relative;
    min-width: 0;
    min-height: 2.75rem;
    padding: 0.8rem 0.9rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-decoration: none;
    text-transform: uppercase;
  }

  .primary-nav a:hover,
  .primary-nav a.active {
    color: var(--text);
  }

  .primary-nav a.active::after {
    position: absolute;
    right: 0.9rem;
    bottom: 0.35rem;
    left: 0.9rem;
    height: 1px;
    background: linear-gradient(90deg, var(--accent), var(--accent-alt));
    box-shadow: 0 0 8px rgba(0, 240, 255, 0.45);
    content: '';
  }

  .team-sidebar-region {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .local-status {
    display: flex;
    min-width: 0;
    min-height: 3.75rem;
    align-items: center;
    gap: 0.55rem;
    padding: 0 1.25rem;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .local-status i {
    width: 0.45rem;
    height: 0.45rem;
    flex: none;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.55);
  }

  .workspace {
    min-width: 0;
    min-height: 0;
    grid-area: main;
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
      padding: 0 0.75rem;
    }

    .logout span {
      display: none;
    }

    .header-actions {
      grid-row: 1;
      grid-column: 2;
    }

    .admin-shell.authenticated {
      grid-template:
        'header' auto
        'sidebar' auto
        'main' minmax(0, 1fr) /
        minmax(0, 1fr);
    }

    .shell-sidebar {
      grid-template-rows: minmax(0, auto) auto;
      border-inline-end: 0;
      border-bottom: 1px solid var(--border);
      overflow: visible;
    }

    .primary-nav {
      grid-row: 2;
      grid-column: 1 / -1;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      display: grid;
      width: 100%;
      padding: 0 0 0.45rem;
      border-top: 1px solid var(--border);
    }

    .primary-nav a {
      overflow: hidden;
      padding-inline: 0.35rem;
      font-size: 0.65rem;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .team-sidebar-region {
      max-height: 10rem;
    }

    .local-status {
      min-height: 2.75rem;
      padding: 0 0.75rem;
    }

    .workspace {
      padding: 1.25rem 0.75rem;
    }

    .chat-mode .shell-sidebar {
      overflow: hidden;
    }
  }

  @media (max-width: 420px) {
    .header-actions {
      gap: 0.3rem;
    }

    .logout {
      width: 2.75rem;
      padding: 0;
    }

    .primary-nav a {
      letter-spacing: 0.04em;
    }
  }
</style>
