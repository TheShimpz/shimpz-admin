<script>
  import { t, locale, setLocale, LOCALES, fieldContent } from '$lib/i18n.js';

  // ── auth gate ─────────────────────────────────────────────────────────────────────────────
  let authPhase = $state('checking'); // checking | setup | login | ready
  let pw = $state('');
  let pw2 = $state('');
  let authError = $state('');
  let authBusy = $state(false);
  // ── marketplace state ─────────────────────────────────────────────────────────────────────
  let integrations = $state([]); // from GET /api/integrations
  let categories = $state([]);
  let activeCat = $state('CHANNEL');
  let drawer = $state(null); // the integration whose config drawer is open, or null
  let values = $state({}); // field inputs, keyed by field key
  let results = $state({}); // live-validate results, keyed by field key
  let busy = $state({}); // per-field validate spinner
  let loadError = $state('');
  let langOpen = $state(false);
  // ── per-integration save ──────────────────────────────────────────────────────────────────
  let saveBusy = $state(false);
  let saveMsg = $state(''); // '' | 'ok' | 'error'
  let saveNote = $state(''); // recreate note (ok) or error detail
  let generated = $state([]);
  // ── Claude-subscription OAuth (only the `anthropic` card) ───────────────────────────────────
  let claudePhase = $state('idle'); // idle | starting | awaitingAuth | connecting | connected | failed
  let claudeUrl = $state('');
  let claudeCode = $state('');
  let claudeEmail = $state('');
  let claudeError = $state('');
  let claudeBusy = $state(false);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let currentLocale = $derived($locale);
  let shown = $derived(integrations.filter((i) => i.category === activeCat));

  function badgeLabel(i) {
    if (!i.reconfigurable) return $t('integration.managed');
    return i.configured ? $t('integration.configured') : $t('integration.notSet');
  }

  // Merge localized content (i18n) over the backend field's English help/guide.
  function content(f) {
    const loc = fieldContent(currentLocale, f.key);
    return {
      help: loc.help ?? f.help,
      steps: loc.steps ?? f.guide?.steps ?? null,
      link: f.guide?.link ?? null,
      linkLabel: loc.linkLabel ?? f.guide?.link_label ?? null,
    };
  }

  async function load() {
    const r = await fetch('/api/integrations');
    if (!r.ok) {
      loadError = `integrations failed: HTTP ${r.status}`;
      return;
    }
    const s = await r.json();
    integrations = s.integrations;
    categories = s.categories;
    if (drawer) drawer = integrations.find((i) => i.group === drawer.group) ?? null; // refresh the open drawer
  }

  // ── auth: which screen to show, then login / create-password / logout ─────────────────────
  async function checkSession() {
    try {
      const s = await (await fetch('/api/session')).json();
      if (!s.initialized) authPhase = 'setup';
      else if (!s.authenticated) authPhase = 'login';
      else {
        authPhase = 'ready';
        await load();
      }
    } catch {
      loadError = 'cannot reach the admin API';
    }
  }
  async function doSetup() {
    authError = '';
    if (pw.length < 12) return (authError = $t('auth.tooShort'));
    if (pw !== pw2) return (authError = $t('auth.mismatch'));
    authBusy = true;
    try {
      const bootstrap_token = new URLSearchParams(location.search).get('token') ?? '';
      const r = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw, bootstrap_token }),
      });
      if (!r.ok) return (authError = (await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
      pw = pw2 = '';
      authPhase = 'ready';
      await load();
    } finally {
      authBusy = false;
    }
  }
  async function doLogin() {
    authError = '';
    authBusy = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (!r.ok) return (authError = $t('auth.badPassword'));
      pw = '';
      authPhase = 'ready';
      await load();
    } finally {
      authBusy = false;
    }
  }
  async function doLogout() {
    await fetch('/api/logout', { method: 'POST' });
    pw = pw2 = '';
    drawer = null;
    authPhase = 'login';
  }

  async function validateField(key) {
    const value = (values[key] ?? '').trim();
    if (!value) {
      delete results[key];
      return;
    }
    busy[key] = true;
    try {
      const r = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      results[key] = r.ok ? await r.json() : { ok: false, detail: `HTTP ${r.status}` };
    } finally {
      busy[key] = false;
    }
  }

  function openDrawer(integ) {
    if (!integ.reconfigurable) return;
    drawer = integ;
    values = {};
    results = {};
    generated = [];
    saveMsg = saveNote = '';
    claudePhase = 'idle';
    claudeUrl = claudeCode = claudeEmail = claudeError = '';
    claudeBusy = false;
    if (integ.oauth) refreshClaudeStatus(); // reflect an existing subscription login
  }
  function closeDrawer() {
    drawer = null;
  }

  // ── Claude-subscription OAuth: start → poll for the URL → paste code → poll status until connected ──
  async function refreshClaudeStatus() {
    const b = await (await fetch('/api/claude/login/status')).json().catch(() => ({}));
    if (b.loggedIn) {
      claudePhase = 'connected';
      claudeEmail = b.email ?? '';
    }
  }
  async function signInClaude() {
    claudeError = '';
    claudeBusy = true;
    claudePhase = 'starting';
    try {
      const b = await (await fetch('/api/claude/login/start', { method: 'POST' })).json().catch(() => ({}));
      if (!b.ok) return ((claudePhase = 'failed'), (claudeError = b.error ?? $t('claudeLogin.failed')));
      for (let i = 0; i < 80 && drawer?.oauth; i++) {
        await sleep(1500);
        const u = await (await fetch('/api/claude/login/url')).json().catch(() => ({}));
        if (u.url) return ((claudeUrl = u.url), (claudePhase = 'awaitingAuth'));
      }
      claudePhase = 'failed';
      claudeError = $t('claudeLogin.failed');
    } finally {
      claudeBusy = false;
    }
  }
  async function connectClaude() {
    const code = (claudeCode ?? '').trim();
    if (!code) return;
    claudeError = '';
    claudeBusy = true;
    claudePhase = 'connecting';
    try {
      const b = await (
        await fetch('/api/claude/login/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        })
      ).json().catch(() => ({}));
      if (!b.ok) return ((claudePhase = 'awaitingAuth'), (claudeError = b.error ?? $t('claudeLogin.failed')));
      for (let i = 0; i < 80 && drawer?.oauth; i++) {
        await sleep(1500);
        const st = await (await fetch('/api/claude/login/status')).json().catch(() => ({}));
        if (st.loggedIn) return ((claudePhase = 'connected'), (claudeEmail = st.email ?? ''), (claudeCode = ''));
      }
      claudePhase = 'failed';
      claudeError = $t('claudeLogin.failed');
    } finally {
      claudeBusy = false;
    }
  }

  // Save one integration's credentials → .env (+ generated internals). The recreate to make it
  // take effect live arrives in C2; C1 reports the deferral (body.recreate.note).
  async function saveIntegration() {
    if (!drawer) return;
    saveBusy = true;
    saveMsg = saveNote = '';
    try {
      const payload = {};
      for (const [k, v] of Object.entries(values)) if ((v ?? '').trim()) payload[k] = v.trim();
      const r = await fetch(`/api/integrations/${drawer.group}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: payload }),
      });
      const body = await r.json().catch(() => ({}));
      if (body.results) for (const [k, res] of Object.entries(body.results)) results[k] = { key: k, ...res };
      if (!r.ok || !body.applied) {
        saveMsg = 'error';
        saveNote = body.detail ?? $t('integration.saveFailed');
        return;
      }
      generated = body.generated ?? [];
      saveMsg = 'ok';
      saveNote = recreateNote(body.recreate);
      values = {};
      await load();
    } finally {
      saveBusy = false;
    }
  }

  // Turn the backend's recreate result into a human line: live-applied, apply-failed, or "on restart".
  function recreateNote(rec) {
    if (!rec) return '';
    if (!rec.target) return rec.note ?? '';
    return rec.ok
      ? `${$t('integration.liveOk')} (${rec.target})`
      : `${$t('integration.applyFailed')}: ${rec.detail ?? ''}`;
  }

  // Enable/disable an integration → recreate its sidecar (inert when disabled). Auto-apply groups only.
  async function doToggle(enabled) {
    if (!drawer) return;
    saveBusy = true;
    saveMsg = saveNote = '';
    try {
      const r = await fetch(`/api/integrations/${drawer.group}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await r.json().catch(() => ({}));
      saveMsg = r.ok ? 'ok' : 'error';
      saveNote = r.ok ? recreateNote(body.recreate) : (body.detail ?? '');
      await load();
    } finally {
      saveBusy = false;
    }
  }

  function pickLang(code) {
    setLocale(code);
    langOpen = false;
  }

  checkSession();
</script>

<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="logo">◇</span> {$t('app.title')} <span class="brand-sub">{$t('app.subtitle')}</span>
    </div>
    <div class="topright">
      {#if authPhase === 'ready'}
        <button class="langbtn" onclick={doLogout}>⇥ {$t('auth.logout')}</button>
      {/if}
      <div class="langwrap">
      <button class="langbtn" onclick={() => (langOpen = !langOpen)} aria-haspopup="listbox">
        🌐 {LOCALES.find((l) => l.code === currentLocale)?.name}
        <span class="chev">▾</span>
      </button>
      {#if langOpen}
        <ul class="langmenu" role="listbox">
          {#each LOCALES as l (l.code)}
            <li>
              <button class:active={l.code === currentLocale} onclick={() => pickLang(l.code)}>{l.name}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    </div>
  </header>

  {#if authPhase !== 'ready'}
    <main class="card">
      {#if loadError}<div class="banner err">{loadError}</div>{/if}
      {#if authPhase === 'setup' || authPhase === 'login'}
        <div class="pane">
          <h1>{authPhase === 'setup' ? $t('auth.setupTitle') : $t('auth.loginTitle')}</h1>
          <p class="lead">{authPhase === 'setup' ? $t('auth.setupLead') : $t('auth.loginLead')}</p>
          <div class="authform">
            <input
              type="password"
              placeholder={$t('auth.password')}
              bind:value={pw}
              autocomplete={authPhase === 'setup' ? 'new-password' : 'current-password'}
              onkeydown={(e) => e.key === 'Enter' && (authPhase === 'setup' ? doSetup() : doLogin())}
            />
            {#if authPhase === 'setup'}
              <input
                type="password"
                placeholder={$t('auth.confirm')}
                bind:value={pw2}
                autocomplete="new-password"
                onkeydown={(e) => e.key === 'Enter' && doSetup()}
              />
            {/if}
            {#if authError}<div class="banner err">{authError}</div>{/if}
            <button class="btn primary" onclick={authPhase === 'setup' ? doSetup : doLogin} disabled={authBusy}>
              {authPhase === 'setup' ? $t('auth.create') : $t('auth.signIn')}
            </button>
          </div>
        </div>
      {:else}
        <div class="pane">
          <div class="verdict working"><span class="spinner"></span><div><h1>{$t('auth.checking')}</h1></div></div>
        </div>
      {/if}
    </main>
  {:else}
    {#if loadError}<div class="banner err">{loadError}</div>{/if}

    <nav class="tabs" aria-label="categories">
      {#each categories as cat (cat)}
        <button class="tab" class:active={cat === activeCat} onclick={() => (activeCat = cat)}>
          {$t(`category.${cat}`)}
        </button>
      {/each}
    </nav>

    <div class="grid">
      {#each shown as integ (integ.group)}
        <button class="intcard" disabled={!integ.reconfigurable} onclick={() => openDrawer(integ)}>
          <img class="intlogo" src={`/integrations/${integ.logo}`} alt={integ.public_name} width="40" height="40" />
          <div class="intbody">
            <div class="intname">{integ.public_name}</div>
            <div class="intblurb">{integ.blurb}</div>
          </div>
          <span
            class="intbadge"
            class:on={integ.configured && integ.reconfigurable}
            class:managed={!integ.reconfigurable}
          >{badgeLabel(integ)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if drawer}
  <div class="drawer-backdrop" onclick={closeDrawer} role="presentation"></div>
  <aside class="drawer">
    <header class="drawer-head">
      <img class="intlogo" src={`/integrations/${drawer.logo}`} alt={drawer.public_name} width="32" height="32" />
      <div class="drawer-title">
        <h2>{drawer.public_name}</h2>
        <p class="drawer-blurb">{drawer.blurb}</p>
      </div>
      <button class="closebtn" onclick={closeDrawer} aria-label={$t('integration.close')}>✕</button>
    </header>
    <div class="drawer-body">
      {#if drawer.auto_apply}
        <div class="drawer-toggle">
          <span class="tstatus" class:on={drawer.enabled}>
            {drawer.enabled ? $t('integration.configured') : $t('integration.notSet')}
          </span>
          <button class="btn small" onclick={() => doToggle(!drawer.enabled)} disabled={saveBusy}>
            {drawer.enabled ? $t('integration.disable') : $t('integration.enable')}
          </button>
        </div>
      {/if}
      {#if drawer.oauth}
        <div class="oauth">
          {#if claudePhase === 'connected'}
            <div class="banner ok">✅ {$t('claudeLogin.connectedAs', { email: claudeEmail })}</div>
          {:else}
            {#if claudePhase === 'idle' || claudePhase === 'failed'}
              <button class="btn primary" onclick={signInClaude} disabled={claudeBusy}>{$t('claudeLogin.signIn')}</button>
            {/if}
            {#if claudePhase === 'starting'}
              <div class="verdict working"><span class="spinner"></span><span>{$t('claudeLogin.pending')}</span></div>
            {/if}
            {#if claudePhase === 'awaitingAuth' || claudePhase === 'connecting'}
              <a class="steps-link" href={claudeUrl} target="_blank" rel="noopener noreferrer">{$t('claudeLogin.authorize')} ↗</a>
              <div class="row">
                <input
                  type="text"
                  placeholder={$t('claudeLogin.pasteCode')}
                  bind:value={claudeCode}
                  autocomplete="off"
                  spellcheck="false"
                />
                <button class="btn small" onclick={connectClaude} disabled={claudeBusy || !(claudeCode ?? '').trim()}>
                  {$t('claudeLogin.connect')}
                </button>
              </div>
            {/if}
            {#if claudeError}<div class="banner err">⚠️ {claudeError}</div>{/if}
          {/if}
          <p class="hint">{$t('claudeLogin.orApiKey')}</p>
        </div>
      {/if}
      {#each drawer.fields.filter((f) => !f.generated) as f (f.key)}
        {@render fieldRow(f)}
      {/each}
    </div>
    <footer class="drawer-foot">
      {#if saveMsg === 'ok'}<div class="banner ok">✅ {$t('integration.saved')}{saveNote ? ` — ${saveNote}` : ''}</div>{/if}
      {#if saveMsg === 'error'}<div class="banner err">⚠️ {saveNote}</div>{/if}
      {#if generated.length}<p class="note">🔒 {$t('review.generatedNote')}</p>{/if}
      <button class="btn primary" onclick={saveIntegration} disabled={saveBusy}>
        {saveBusy ? $t('integration.saving') : $t('integration.save')}
      </button>
    </footer>
  </aside>
{/if}

{#snippet fieldRow(f)}
  {@const c = content(f)}
  <div class="field">
    <div class="head">
      <label for={f.key}><code>{f.key}</code></label>
      {#if f.required}<span class="tag req">{$t('field.required')}</span>{:else}<span class="tag opt">{$t('field.optional')}</span>{/if}
      {#if f.set}<span class="setmark">{$t('field.saved')} {f.masked}</span>{/if}
      {#if results[f.key]}
        <span class={results[f.key].ok ? 'res ok' : 'res err'}>
          {results[f.key].ok ? '✓' : '✗'} {results[f.key].detail}
        </span>
      {/if}
    </div>
    {#if c.help}<p class="help">{c.help}</p>{/if}
    <div class="row">
      <input
        id={f.key}
        type={f.secret ? 'password' : 'text'}
        placeholder={f.set ? $t('field.replace') : ''}
        bind:value={values[f.key]}
        onblur={() => validateField(f.key)}
        autocomplete="off"
        spellcheck="false"
      />
      <button class="btn small" onclick={() => validateField(f.key)} disabled={busy[f.key] || !(values[f.key] ?? '').trim()}>
        {busy[f.key] ? $t('field.testing') : f.live ? $t('field.test') : $t('field.check')}
      </button>
    </div>
    {#if c.steps}
      <div class="steps">
        <ol>{#each c.steps as s, i (i)}<li>{s}</li>{/each}</ol>
        {#if c.link}
          <a class="steps-link" href={c.link} target="_blank" rel="noopener noreferrer">{c.linkLabel ?? $t('field.open')} ↗</a>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .shell {
    max-width: 760px;
    margin: 0 auto;
    padding: 1.5rem 1.1rem 4rem;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.4rem;
  }
  .brand {
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: 0.2px;
  }
  .logo {
    color: var(--accent);
  }
  .brand-sub {
    color: var(--text-dim);
    font-weight: 400;
  }
  .langwrap {
    position: relative;
  }
  .langbtn {
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .chev {
    color: var(--text-faint);
  }
  .langmenu {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 6px);
    margin: 0;
    padding: 0.3rem;
    list-style: none;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--shadow);
    z-index: 20;
    min-width: 150px;
  }
  .langmenu button {
    display: block;
    width: 100%;
    text-align: start;
    background: none;
    border: none;
    color: var(--text);
    padding: 0.45rem 0.6rem;
    border-radius: var(--r-sm);
    cursor: pointer;
    font-size: 0.9rem;
  }
  .langmenu button:hover {
    background: var(--surface-3);
  }
  .langmenu button.active {
    color: var(--accent);
  }

  .stepper {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 1rem;
    overflow-x: auto;
    padding-bottom: 0.2rem;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-faint);
    flex: none;
  }
  .node .dot {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 0.75rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .node .lbl {
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .node.cur .dot {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  .node.cur .lbl {
    color: var(--text);
    font-weight: 600;
  }
  .node.done .dot {
    background: var(--accent-strong);
    color: #fff;
    border-color: var(--accent-strong);
  }

  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
    padding: 1.6rem 1.5rem 1.2rem;
  }
  .pane h1 {
    font-size: 1.35rem;
    margin: 0 0 0.4rem;
  }
  .lead {
    color: var(--text-dim);
    margin: 0 0 1.2rem;
  }
  .needs {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 1rem 1.1rem;
  }
  .needs-title {
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .needs ul {
    margin: 0.2rem 0 0.6rem;
    padding-inline-start: 1.2rem;
    color: var(--text-dim);
  }
  .note {
    color: var(--text-dim);
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
  }

  .field {
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--border);
  }
  .field:last-child {
    border-bottom: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .head code {
    font-size: 0.9rem;
  }
  .tag {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  .tag.req {
    background: rgba(240, 104, 95, 0.14);
    color: var(--danger);
  }
  .tag.opt {
    background: var(--surface-3);
    color: var(--text-faint);
  }
  .setmark {
    color: var(--accent);
    font-size: 0.78rem;
  }
  .res {
    font-size: 0.8rem;
  }
  .res.ok {
    color: var(--accent);
  }
  .res.err {
    color: var(--danger);
  }
  .help {
    color: var(--text-dim);
    font-size: 0.86rem;
    margin: 0.35rem 0 0.5rem;
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    padding: 0.6rem 0.8rem;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.86rem;
    transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
  }
  input:focus {
    outline: none;
    border-color: var(--accent-strong);
    box-shadow: var(--ring);
  }

  .btn {
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    padding: 0.6rem 1rem;
    font-size: 0.9rem;
    cursor: pointer;
    transition: transform 0.05s var(--ease), background 0.15s var(--ease), opacity 0.15s;
  }
  .btn:active {
    transform: translateY(1px);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn.small {
    padding: 0.55rem 0.8rem;
    font-size: 0.82rem;
    flex: none;
  }
  .btn.ghost {
    background: transparent;
  }
  .btn.primary {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
    color: #fff;
    font-weight: 600;
  }
  .btn.accent {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .hint {
    color: var(--text-faint);
    font-size: 0.82rem;
    margin: 0.5rem 0 0;
  }

  .steps {
    margin-top: 0.5rem;
    border-inline-start: 2px solid var(--border-strong);
    padding-inline-start: 0.85rem;
  }
  .steps ol {
    margin: 0.2rem 0;
    padding-inline-start: 1.1rem;
    font-size: 0.84rem;
    color: var(--text-dim);
  }
  .steps li {
    margin: 0.3rem 0;
  }
  .steps li::marker {
    color: var(--text-faint);
  }
  .steps-link {
    display: inline-block;
    margin-top: 0.35rem;
    font-size: 0.84rem;
    text-decoration: none;
  }
  .steps-link:hover {
    text-decoration: underline;
  }

  .actions {
    display: flex;
    gap: 0.7rem;
    margin-top: 1rem;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 0.4rem 0 0.6rem;
  }
  .verdict h1 {
    margin: 0;
    font-size: 1.25rem;
  }
  .verdict .lead {
    margin: 0.2rem 0 0;
  }
  .verdict.ok .vicon,
  .verdict.bad .vicon {
    font-size: 1.9rem;
    line-height: 1;
  }
  .spinner {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 3px solid var(--surface-3);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .banner {
    border-radius: var(--r-md);
    padding: 0.7rem 1rem;
    margin: 0.75rem 0;
    border: 1px solid var(--border);
    font-size: 0.9rem;
  }
  .banner.ok {
    border-color: var(--accent-strong);
    color: var(--accent);
  }
  .banner.err {
    border-color: var(--danger);
    color: var(--danger);
  }
  .banner.big {
    font-size: 1rem;
  }
  .banner pre {
    white-space: pre-wrap;
    color: var(--text);
    font-size: 0.75rem;
    margin: 0;
  }

  .stack {
    margin-top: 1.2rem;
  }
  .stack-title {
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .svclist {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 0.35rem;
  }
  .svclist li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.4rem 0.65rem;
    font-size: 0.85rem;
  }
  .sdot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }
  .sdot.up {
    background: var(--accent);
  }
  .sdot.pending {
    background: var(--warn);
  }
  .sdot.down {
    background: var(--danger);
  }
  .muted {
    color: var(--text-faint);
    font-size: 0.78rem;
  }

  .topright {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .authform {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    max-width: 360px;
    margin-top: 0.4rem;
  }
  .authform input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: var(--r-sm);
    padding: 0.6rem 0.8rem;
    font-size: 0.9rem;
    transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
  }
  .authform input:focus {
    outline: none;
    border-color: var(--accent-strong);
    box-shadow: var(--ring);
  }
  .authform .btn {
    align-self: flex-start;
  }

  /* ── marketplace ─────────────────────────────────────────────────────────────────────── */
  .tabs {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 1.1rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-dim);
    padding: 0.55rem 0.85rem;
    font-size: 0.9rem;
    cursor: pointer;
    margin-bottom: -1px;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.8rem;
  }
  .intcard {
    display: flex;
    align-items: flex-start;
    gap: 0.8rem;
    text-align: start;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 1rem;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s var(--ease), transform 0.05s var(--ease), background 0.15s var(--ease);
  }
  .intcard:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }
  .intcard:active:not(:disabled) {
    transform: translateY(1px);
  }
  .intcard:disabled {
    cursor: default;
    opacity: 0.72;
  }
  .intlogo {
    border-radius: var(--r-md);
    flex: none;
    display: block;
  }
  .intbody {
    flex: 1;
    min-width: 0;
  }
  .intname {
    font-weight: 600;
    font-size: 1rem;
    margin-bottom: 0.15rem;
  }
  .intblurb {
    color: var(--text-dim);
    font-size: 0.82rem;
    line-height: 1.35;
  }
  .intbadge {
    flex: none;
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--text-faint);
    white-space: nowrap;
  }
  .intbadge.on {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
  }

  /* ── config drawer ───────────────────────────────────────────────────────────────────── */
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 40;
  }
  .drawer {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    width: min(560px, 100%);
    background: var(--surface-1);
    border-inline-start: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
    z-index: 50;
    display: flex;
    flex-direction: column;
  }
  .drawer-head {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 1.1rem 1.3rem;
    border-bottom: 1px solid var(--border);
  }
  .drawer-title {
    flex: 1;
    min-width: 0;
  }
  .drawer-head h2 {
    margin: 0;
    font-size: 1.15rem;
  }
  .drawer-blurb {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    font-size: 0.82rem;
  }
  .closebtn {
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.3rem;
    flex: none;
  }
  .closebtn:hover {
    color: var(--text);
  }
  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.3rem 1.3rem;
  }
  .drawer-foot {
    padding: 1rem 1.3rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .drawer-foot .btn {
    align-self: flex-start;
  }
  .drawer-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    padding: 0.6rem 0.8rem;
    margin: 0.5rem 0 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .tstatus {
    font-size: 0.85rem;
    color: var(--text-faint);
  }
  .tstatus.on {
    color: var(--accent);
  }
  .oauth {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem;
    margin: 0.6rem 0 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }
  .oauth .row {
    align-items: center;
  }
  .oauth .hint {
    margin: 0.1rem 0 0;
  }
</style>
