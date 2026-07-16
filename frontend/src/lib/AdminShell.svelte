<script>
  import ShimpzBrand from '$lib/ShimpzBrand.svelte';
  import { t } from '$lib/i18n.js';

  let { active = '', authenticated = false, actions, children } = $props();

  const navigation = [
    { id: 'integrations', label: 'workspace.title', href: '/' },
    { id: 'capsules', label: 'workspace.capsulesKicker', href: '/capsules/' },
    { id: 'assistants', label: 'store.nav', href: '/assistants/' },
  ];
</script>

<a class="skip-link" href="#admin-content">Skip to content</a>

<div class="admin-shell">
  <header class="topbar">
    <ShimpzBrand />

    {#if authenticated}
      <nav aria-label="Admin">
        {#each navigation as item (item.id)}
          <a href={item.href} class:active={active === item.id} aria-current={active === item.id ? 'page' : undefined}>
            {$t(item.label)}
          </a>
        {/each}
      </nav>
    {/if}

    {#if actions}
      <div class="actions">{@render actions()}</div>
    {/if}
  </header>

  <main id="admin-content">
    {@render children()}
  </main>

  <footer>
    <span><i aria-hidden="true"></i> Local Space</span>
  </footer>
</div>

<style>
  .skip-link {
    position: fixed;
    z-index: 120;
    top: 0.75rem;
    left: 1rem;
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
    width: min(100% - 2rem, 1180px);
    min-height: 100vh;
    margin: 0 auto;
  }

  .topbar {
    display: grid;
    min-height: 5.25rem;
    grid-template-columns: minmax(12rem, 1fr) auto minmax(12rem, 1fr);
    align-items: center;
    gap: 1rem;
    border-bottom: 1px solid var(--border);
  }

  nav {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  nav a {
    position: relative;
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

  nav a::after {
    position: absolute;
    right: 0.9rem;
    bottom: 0.35rem;
    left: 0.9rem;
    height: 1px;
    background: transparent;
    content: '';
  }

  nav a:hover,
  nav a.active {
    color: var(--text);
  }

  nav a.active::after {
    background: linear-gradient(90deg, var(--accent), var(--accent-alt));
    box-shadow: 0 0 8px rgba(0, 240, 255, 0.45);
  }

  .actions {
    display: flex;
    min-width: 0;
    grid-column: 3;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
  }

  main {
    min-height: calc(100vh - 9.2rem);
    padding: clamp(1.75rem, 4vw, 3.25rem) 0;
  }

  footer {
    display: flex;
    min-height: 3.75rem;
    align-items: center;
    gap: 1rem;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  footer span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  footer i {
    width: 0.45rem;
    height: 0.45rem;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.55);
  }

  @media (max-width: 760px) {
    .topbar {
      grid-template-columns: 1fr auto;
      padding: 0.8rem 0;
    }

    nav {
      grid-row: 2;
      grid-column: 1 / -1;
      justify-content: center;
      border-top: 1px solid var(--border);
      padding-top: 0.4rem;
    }

    .actions {
      grid-column: 2;
      grid-row: 1;
    }
  }

  @media (max-width: 520px) {
    .admin-shell {
      width: min(100% - 1.25rem, 1180px);
    }

    footer { padding: 1rem 0; }
  }
</style>
