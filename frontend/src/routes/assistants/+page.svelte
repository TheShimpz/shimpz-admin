<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import { t, locale } from '$lib/i18n.js';

  let phase = $state('checking');
  let currentLocale = $derived($locale);
  let storeLocale = $derived(currentLocale === 'pt' ? 'pt' : 'en');
  let storeUrl = $derived(`https://shimpz.com/${storeLocale}/assistants/embed`);

  async function checkSession() {
    phase = 'checking';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      phase = (await response.json()).authenticated ? 'ready' : 'needauth';
    } catch {
      phase = 'needauth';
    }
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      location.assign('/');
    }
  }

  onMount(checkSession);
</script>

<svelte:head>
  <title>Assistants — Shimpz Admin</title>
  <meta name="description" content="Browse the canonical Shimpz Assistant Store from the local Admin." />
</svelte:head>

<AdminShell active="assistants" authenticated={phase === 'ready'} actions={shellActions}>
  {#if phase === 'checking'}
    <section class="state" aria-live="polite">
      <div class="pulse" aria-hidden="true"><span></span></div>
      <p>{$t('store.checking')}</p>
    </section>
  {:else if phase === 'needauth'}
    <section class="state">
      <p class="kicker">Space // protected route</p>
      <h1>{$t('store.needAuthTitle')}</h1>
      <p>{$t('store.needAuthLead')}</p>
      <a class="sign-in" href="/">{$t('store.signIn')} <span aria-hidden="true">→</span></a>
    </section>
  {:else}
    <header class="store-header">
      <div>
        <p class="kicker">{$t('store.kicker')}</p>
        <h1>{$t('store.title')}</h1>
        <p class="lead">{$t('store.lead')}</p>
      </div>
      <a class="external" href={storeUrl.replace('/embed', '')} target="_blank" rel="noopener noreferrer">
        {$t('store.open')} <span aria-hidden="true">↗</span>
      </a>
    </header>

    <section class="store-frame" aria-labelledby="store-source">
      <header>
        <span id="store-source"><i aria-hidden="true"></i>{$t('store.source')}</span>
        <code>SHIMPZ // STORE</code>
      </header>
      <iframe
        src={storeUrl}
        title={$t('store.frameTitle')}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
      ></iframe>
    </section>

    <p class="trust-boundary"><span aria-hidden="true">◇</span>{$t('store.boundary')}</p>
  {/if}
</AdminShell>

{#snippet shellActions()}
  <LocaleMenu compact={phase !== 'ready'} />
  {#if phase === 'ready'}
    <button class="logout" type="button" onclick={logout} aria-label={$t('auth.logout')}>
      <span>{$t('auth.logout')}</span><b aria-hidden="true">↪</b>
    </button>
  {/if}
{/snippet}

<style>
  .logout {
    display: inline-flex;
    min-height: 2.75rem;
    align-items: center;
    gap: 0.45rem;
    border: 0;
    padding: 0 0.8rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    color: var(--text-dim);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .logout b { color: var(--accent); }
  .logout:hover { color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }

  .store-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 2rem;
    margin-bottom: 2rem;
  }

  .kicker {
    margin: 0 0 0.9rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.19em;
    text-transform: uppercase;
  }

  h1 {
    max-width: 12ch;
    margin: 0;
    font-size: clamp(2.65rem, 7vw, 5.25rem);
    line-height: 0.96;
    letter-spacing: -0.08em;
    text-wrap: balance;
  }

  .lead {
    max-width: 65ch;
    margin: 1.1rem 0 0;
    color: var(--text-dim);
    font-size: 1rem;
    line-height: 1.7;
  }

  .external,
  .sign-in {
    display: inline-flex;
    min-height: 2.9rem;
    align-items: center;
    justify-content: space-between;
    gap: 1.3rem;
    padding: 0 1rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--accent);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-decoration: none;
    text-transform: uppercase;
  }

  .external:hover,
  .sign-in:hover { filter: drop-shadow(0 0 9px rgba(0, 240, 255, 0.32)); }

  .store-frame {
    overflow: hidden;
    background: #000;
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 20px 60px rgba(0, 0, 0, 0.4);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }

  .store-frame > header {
    display: flex;
    min-height: 2.9rem;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .store-frame > header span { display: inline-flex; align-items: center; gap: 0.5rem; }
  .store-frame > header i {
    width: 0.42rem;
    height: 0.42rem;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.55);
  }
  .store-frame code { color: var(--accent); font-size: inherit; }

  iframe {
    display: block;
    width: 100%;
    height: min(72rem, calc(100vh - 12rem));
    min-height: 42rem;
    border: 0;
    background: #000;
  }

  .trust-boundary {
    display: flex;
    max-width: 78ch;
    align-items: flex-start;
    gap: 0.65rem;
    margin: 1rem 0 0;
    color: var(--text-faint);
    font-size: 0.76rem;
    line-height: 1.6;
  }
  .trust-boundary span { color: var(--accent-alt); }

  .state {
    display: flex;
    min-height: 28rem;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    border: 1px solid var(--border);
    background: radial-gradient(circle at 50% 35%, rgba(0, 240, 255, 0.055), transparent 48%), var(--surface-1);
    color: var(--text-dim);
    text-align: center;
  }
  .state h1 { max-width: 18ch; font-size: clamp(1.65rem, 4vw, 2.6rem); letter-spacing: -0.05em; }
  .state > p:not(.kicker) { max-width: 51ch; margin: 0.8rem 1rem 1.5rem; line-height: 1.65; }

  .pulse {
    position: relative;
    width: 4.6rem;
    height: 4.6rem;
    margin-bottom: 1.5rem;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
  }
  .pulse::before,
  .pulse::after,
  .pulse span {
    position: absolute;
    border: 1px solid var(--accent);
    border-radius: 50%;
    content: '';
    animation: pulse 1.8s ease-out infinite;
  }
  .pulse::before { inset: 1.5rem; }
  .pulse::after { inset: 0.8rem; animation-delay: 0.35s; }
  .pulse span { inset: 0; animation-delay: 0.7s; }

  @keyframes pulse {
    0% { opacity: 0.8; transform: scale(0.7); }
    100% { opacity: 0; transform: scale(1.12); }
  }

  @media (max-width: 720px) {
    .store-header { grid-template-columns: 1fr; align-items: start; }
    .external { width: 100%; }
    iframe { min-height: 36rem; }
  }
</style>
