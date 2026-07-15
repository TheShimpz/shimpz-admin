<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import AuthScreen from '$lib/AuthScreen.svelte';
  import IntegrationDrawer from '$lib/IntegrationDrawer.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import { t, locale, fieldContent } from '$lib/i18n.js';

  let authPhase = $state('checking'); // checking | setup | login | ready
  let pw = $state('');
  let pw2 = $state('');
  let authError = $state('');
  let authBusy = $state(false);

  let integrations = $state([]);
  let categories = $state([]);
  let activeCat = $state('CHANNEL');
  let drawer = $state(null);
  let values = $state({});
  let results = $state({});
  let busy = $state({});
  let loadError = $state('');

  let saveBusy = $state(false);
  let saveMsg = $state('');
  let saveNote = $state('');
  let generated = $state([]);

  let currentLocale = $derived($locale);
  let shown = $derived(integrations.filter((integration) => integration.category === activeCat));

  function badgeLabel(integration) {
    if (!integration.reconfigurable) return $t('integration.managed');
    return integration.configured ? $t('integration.configured') : $t('integration.notSet');
  }

  function content(field) {
    const localized = fieldContent(currentLocale, field.key);
    return {
      help: localized.help ?? field.help,
      steps: localized.steps ?? field.guide?.steps ?? null,
      link: field.guide?.link ?? null,
      linkLabel: localized.linkLabel ?? field.guide?.link_label ?? null,
    };
  }

  async function load() {
    loadError = '';
    try {
      const response = await fetch('/api/integrations');
      if (response.status === 401) {
        authPhase = 'login';
        return;
      }
      if (!response.ok) {
        loadError = `Integrations failed: HTTP ${response.status}`;
        return;
      }

      const state = await response.json();
      integrations = state.integrations ?? [];
      categories = state.categories ?? [];
      if (!categories.includes(activeCat)) activeCat = categories[0] ?? '';
      if (drawer) drawer = integrations.find((integration) => integration.group === drawer.group) ?? null;
    } catch {
      loadError = $t('auth.unreachable');
    }
  }

  async function checkSession() {
    authPhase = 'checking';
    authError = '';
    loadError = '';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      if (!session.initialized) authPhase = 'setup';
      else if (!session.authenticated) authPhase = 'login';
      else {
        authPhase = 'ready';
        await load();
      }
    } catch {
      loadError = $t('auth.unreachable');
    }
  }

  async function doSetup() {
    if (authBusy) return;
    authError = '';
    if (pw.length < 12) {
      authError = $t('auth.tooShort');
      return;
    }
    if (pw !== pw2) {
      authError = $t('auth.mismatch');
      return;
    }

    authBusy = true;
    try {
      const bootstrap_token = new URLSearchParams(location.search).get('token') ?? '';
      const response = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, bootstrap_token }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        authError = body.detail ?? `HTTP ${response.status}`;
        return;
      }
      pw = pw2 = '';
      authPhase = 'ready';
      await load();
    } catch {
      authError = $t('auth.unreachable');
    } finally {
      authBusy = false;
    }
  }

  async function doLogin() {
    if (authBusy) return;
    authError = '';
    authBusy = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!response.ok) {
        authError = response.status === 401 ? $t('auth.badPassword') : `HTTP ${response.status}`;
        return;
      }
      pw = '';
      authPhase = 'ready';
      await load();
    } catch {
      authError = $t('auth.unreachable');
    } finally {
      authBusy = false;
    }
  }

  async function doLogout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      pw = pw2 = '';
      drawer = null;
      authPhase = 'login';
    }
  }

  async function validateField(key) {
    const value = (values[key] ?? '').trim();
    if (!value) {
      delete results[key];
      return;
    }

    busy[key] = true;
    try {
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      results[key] = response.ok
        ? await response.json()
        : { ok: false, detail: `HTTP ${response.status}` };
    } catch {
      results[key] = { ok: false, detail: $t('auth.unreachable') };
    } finally {
      busy[key] = false;
    }
  }

  function openDrawer(integration) {
    if (!integration.reconfigurable) return;
    drawer = integration;
    values = {};
    results = {};
    generated = [];
    saveMsg = saveNote = '';
  }

  function closeDrawer() {
    drawer = null;
  }

  async function saveIntegration() {
    if (!drawer || saveBusy) return;
    saveBusy = true;
    saveMsg = saveNote = '';
    try {
      const payload = {};
      for (const [key, value] of Object.entries(values)) {
        if ((value ?? '').trim()) payload[key] = value.trim();
      }
      const response = await fetch(`/api/integrations/${drawer.group}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const body = await response.json().catch(() => ({}));
      if (body.results) {
        for (const [key, result] of Object.entries(body.results)) results[key] = { key, ...result };
      }
      if (!response.ok || !body.applied) {
        saveMsg = 'error';
        saveNote = body.detail ?? $t('integration.saveFailed');
        return;
      }
      generated = body.generated ?? [];
      saveMsg = 'ok';
      saveNote = recreateNote(body.recreate);
      values = {};
      await load();
    } catch {
      saveMsg = 'error';
      saveNote = $t('auth.unreachable');
    } finally {
      saveBusy = false;
    }
  }

  function recreateNote(recreate) {
    if (!recreate) return '';
    if (!recreate.target) return recreate.note ?? '';
    return recreate.ok
      ? `${$t('integration.liveOk')} (${recreate.target})`
      : `${$t('integration.applyFailed')}: ${recreate.detail ?? ''}`;
  }

  async function doToggle(enabled) {
    if (!drawer || saveBusy) return;
    saveBusy = true;
    saveMsg = saveNote = '';
    try {
      const response = await fetch(`/api/integrations/${drawer.group}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      saveMsg = response.ok ? 'ok' : 'error';
      saveNote = response.ok ? recreateNote(body.recreate) : (body.detail ?? `HTTP ${response.status}`);
      await load();
    } catch {
      saveMsg = 'error';
      saveNote = $t('auth.unreachable');
    } finally {
      saveBusy = false;
    }
  }

  onMount(checkSession);
</script>

<svelte:head>
  <title>Shimpz Capsule Admin</title>
  <meta
    name="description"
    content="Manage Shimpz Capsules, Space-wide Drivers, and integrations from your local control plane."
  />
</svelte:head>

<AdminShell active="integrations" authenticated={authPhase === 'ready'} actions={shellActions}>
  {#if authPhase !== 'ready'}
    <AuthScreen
      phase={authPhase}
      bind:password={pw}
      bind:confirmation={pw2}
      error={authError || loadError}
      busy={authBusy}
      onSubmit={authPhase === 'setup' ? doSetup : doLogin}
      onRetry={checkSession}
    />
  {:else}
    <section class="workspace-header" aria-labelledby="workspace-title">
      <div>
        <p class="kicker">{$t('workspace.kicker')}</p>
        <h1 id="workspace-title">{$t('workspace.title')}</h1>
        <p class="workspace-lead">{$t('workspace.lead')}</p>
      </div>

      <a class="capsule-link" href="/capsules/">
        <span class="capsule-kicker">{$t('workspace.capsulesKicker')}</span>
        <strong>{$t('workspace.capsulesTitle')}</strong>
        <span>{$t('workspace.capsulesLead')}</span>
        <b>{$t('workspace.openCapsules')} <span aria-hidden="true">→</span></b>
      </a>
    </section>

    {#if loadError}<div class="page-message error" role="alert">{loadError}</div>{/if}

    <nav class="category-tabs" aria-label="Integration categories">
      {#each categories as category (category)}
        <button
          type="button"
          class:active={category === activeCat}
          aria-pressed={category === activeCat}
          onclick={() => (activeCat = category)}
        >
          {$t(`category.${category}`)}
        </button>
      {/each}
    </nav>

    {#if shown.length}
      <div class="integration-grid">
        {#each shown as integration (integration.group)}
          <button
            class="integration-card"
            type="button"
            disabled={!integration.reconfigurable}
            onclick={() => openDrawer(integration)}
          >
            <img src={`/integrations/${integration.logo}`} alt="" width="44" height="44" />
            <span class="integration-copy">
              <strong>{integration.public_name}</strong>
              <span>{integration.blurb}</span>
            </span>
            <span
              class="badge"
              class:configured={integration.configured && integration.reconfigurable}
              class:managed={!integration.reconfigurable}
            >{badgeLabel(integration)}</span>
            {#if integration.reconfigurable}<span class="arrow" aria-hidden="true">↗</span>{/if}
          </button>
        {/each}
      </div>
    {:else if !loadError}
      <div class="empty-state">{$t('workspace.empty')}</div>
    {/if}
  {/if}
</AdminShell>

{#if drawer}
  <IntegrationDrawer
    integration={drawer}
    bind:values
    {results}
    {busy}
    {saveBusy}
    {saveMsg}
    {saveNote}
    {generated}
    contentFor={content}
    onClose={closeDrawer}
    onValidate={validateField}
    onSave={saveIntegration}
    onToggle={doToggle}
  />
{/if}

{#snippet shellActions()}
  <LocaleMenu compact={authPhase !== 'ready'} />
  {#if authPhase === 'ready'}
    <button class="logout" type="button" onclick={doLogout}>
      <span class="logout-text">{$t('auth.logout')}</span><span aria-hidden="true">↪</span>
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

  .logout:hover {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .workspace-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(19rem, 25rem);
    align-items: end;
    gap: clamp(2rem, 7vw, 6rem);
    margin-bottom: clamp(2rem, 5vw, 3.5rem);
  }

  .kicker,
  .capsule-kicker {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .kicker {
    margin: 0 0 0.9rem;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.5rem, 7vw, 5rem);
    line-height: 0.98;
    letter-spacing: -0.075em;
  }

  .workspace-lead {
    max-width: 55ch;
    margin: 1.1rem 0 0;
    color: var(--text-dim);
    font-size: 1.02rem;
    line-height: 1.7;
  }

  .capsule-link {
    position: relative;
    display: grid;
    gap: 0.35rem;
    padding: 1.35rem;
    background: linear-gradient(145deg, var(--surface-2), var(--surface-1));
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    box-shadow: inset 0 0 0 1px var(--border-strong);
    color: var(--text);
    text-decoration: none;
    transition: transform 0.15s var(--ease), filter 0.15s var(--ease), box-shadow 0.15s var(--ease);
  }

  .capsule-link::before {
    position: absolute;
    top: 0;
    right: var(--cut);
    left: var(--cut);
    height: 1px;
    background: linear-gradient(90deg, var(--accent), var(--accent-alt));
    content: '';
  }

  .capsule-link:hover {
    box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.6);
    filter: drop-shadow(0 0 12px rgba(0, 240, 255, 0.16));
    transform: translateY(-2px);
  }

  .capsule-link strong {
    font-family: var(--font-mono);
    font-size: 1.08rem;
    letter-spacing: -0.025em;
  }

  .capsule-link > span:not(.capsule-kicker) {
    color: var(--text-dim);
    font-size: 0.8rem;
    line-height: 1.5;
  }

  .capsule-link b {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.65rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .page-message {
    padding: 0.8rem 1rem;
    margin: 0 0 1.25rem;
    border-inline-start: 2px solid currentColor;
    background: var(--surface-1);
    font-size: 0.85rem;
  }

  .error {
    color: var(--danger);
  }

  .category-tabs {
    display: flex;
    gap: 0.35rem;
    padding-bottom: 0.75rem;
    margin-bottom: 1.25rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .category-tabs button {
    min-height: 2.55rem;
    flex: none;
    border: 1px solid var(--border-strong);
    padding: 0 0.85rem;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .category-tabs button:hover {
    border-color: var(--text-faint);
    color: var(--text);
  }

  .category-tabs button.active {
    border-color: transparent;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    color: var(--accent-ink);
  }

  .integration-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  .integration-card {
    position: relative;
    display: grid;
    min-height: 7.5rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.9rem;
    border: 0;
    padding: 1.15rem;
    background: linear-gradient(145deg, var(--surface-2), var(--surface-1));
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text);
    cursor: pointer;
    text-align: start;
    transition: transform 0.12s var(--ease), box-shadow 0.15s var(--ease), filter 0.15s var(--ease);
  }

  .integration-card:hover:not(:disabled) {
    box-shadow: inset 0 0 0 1px rgba(0, 240, 255, 0.55);
    filter: drop-shadow(0 0 9px rgba(0, 240, 255, 0.13));
    transform: translateY(-2px);
  }

  .integration-card:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .integration-card img {
    object-fit: contain;
  }

  .integration-copy {
    display: grid;
    min-width: 0;
    gap: 0.25rem;
  }

  .integration-copy strong {
    font-family: var(--font-mono);
    font-size: 0.94rem;
    letter-spacing: -0.02em;
  }

  .integration-copy > span {
    color: var(--text-dim);
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .badge {
    padding: 0.16rem 0.42rem;
    border: 1px solid var(--border-strong);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.52rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .badge.configured {
    border-color: rgba(5, 255, 161, 0.4);
    color: var(--success);
  }

  .badge.managed {
    color: var(--text-faint);
  }

  .arrow {
    position: absolute;
    right: 1rem;
    bottom: 0.8rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }

  .empty-state {
    padding: 3rem 1.25rem;
    border: 1px dashed var(--border-strong);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    text-align: center;
  }

  @media (max-width: 850px) {
    .workspace-header {
      grid-template-columns: 1fr;
      align-items: start;
      gap: 2rem;
    }

    .capsule-link {
      width: min(100%, 31rem);
    }
  }

  @media (max-width: 680px) {
    .integration-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 520px) {
    .logout-text {
      display: none;
    }

    .integration-card {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .badge {
      grid-column: 2;
      justify-self: start;
    }
  }
</style>
