<script>
  import { onMount } from 'svelte';
  import CapsuleCard from '$lib/CapsuleCard.svelte';
  import { t } from '$lib/i18n.js';
  import { safeApiError } from '$lib/localApi.js';
  import { refreshTeams } from '$lib/teamContext.js';

  let phase = $state('checking'); // checking | needauth | ready
  let capsules = $state([]);
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let mutationError = $state('');
  let showCredentials = $state(false);
  let pendingDelete = $state(null);
  let createDialog;
  let deleteDialog;

  let runningCount = $derived(capsules.filter((capsule) => capsule.status === 'running').length);

  async function refresh() {
    error = '';
    try {
      const response = await fetch('/api/capsules', { cache: 'no-store' });
      if (response.status === 401) {
        phase = 'needauth';
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        error = safeApiError(body, 'Could not reach the Team runtime controller.');
        return;
      }
      capsules = (await response.json()).capsules ?? [];
    } catch {
      error = 'Could not reach the local Admin API.';
    }
  }

  async function load() {
    phase = 'checking';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      const session = await response.json();
      showCredentials = session.features?.capsuleCredentials === true;
      if (!session.authenticated) {
        phase = 'needauth';
        return;
      }
      phase = 'ready';
      await refresh();
    } catch {
      phase = 'needauth';
    }
  }

  function openCreate() {
    name = '';
    mutationError = '';
    createDialog?.showModal();
  }

  async function refreshSharedTeamContext(preferredId = '') {
    try {
      await refreshTeams(fetch, preferredId);
    } catch {
      // The shared context exposes its own load error; the completed mutation remains successful.
    }
  }

  async function create() {
    if (!name.trim() || busy) return;
    busy = true;
    mutationError = '';
    try {
      const response = await fetch('/api/capsules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        mutationError = safeApiError(body, 'Team creation failed.');
        return;
      }
      const created = await response.json().catch(() => ({}));
      createDialog?.close();
      name = '';
      await refresh();
      await refreshSharedTeamContext(typeof created.id === 'string' ? created.id : '');
    } catch {
      mutationError = 'Could not reach the local Admin API.';
    } finally {
      busy = false;
    }
  }

  function requestDestroy(capsule) {
    pendingDelete = capsule;
    mutationError = '';
    deleteDialog?.showModal();
  }

  async function destroy() {
    if (!pendingDelete || busy) return;
    busy = true;
    mutationError = '';
    try {
      const response = await fetch(`/api/capsules/${encodeURIComponent(pendingDelete.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        mutationError = safeApiError(body, 'Team destruction failed.');
        return;
      }
      deleteDialog?.close();
      pendingDelete = null;
      await refresh();
      await refreshSharedTeamContext();
    } catch {
      mutationError = 'Could not reach the local Admin API.';
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Teams — Shimpz Admin</title>
  <meta name="description" content="Create and manage isolated Shimpz Teams and their scoped Drivers." />
</svelte:head>

{#if phase === 'checking'}
  <section class="loading-state" aria-live="polite">
    <div class="pulse" aria-hidden="true"><span></span></div>
    <p>{$t('capsules.loading')}</p>
  </section>
{:else if phase === 'needauth'}
  <section class="auth-gate">
    <p class="kicker">Space // protected route</p>
    <h1>{$t('capsules.needAuthTitle')}</h1>
    <p>{$t('capsules.needAuthLead')}</p>
    <a href="/">{$t('capsules.signIn')} <span aria-hidden="true">→</span></a>
  </section>
{:else}
  <section class="page-header" aria-labelledby="capsules-title">
    <div>
      <p class="kicker">{$t('capsules.kicker')}</p>
      <h1 id="capsules-title">{$t('capsules.title')}</h1>
      <p class="lead">{$t('capsules.lead')}</p>
    </div>

    <button class="create-button" type="button" onclick={openCreate}>
      <span>{$t('capsules.create')}</span><span aria-hidden="true">＋</span>
    </button>
  </section>

  <section class:offline={error} class="runtime-bar" aria-label="Team runtime summary">
    <i aria-hidden="true"></i>
    <strong>{runningCount}</strong><span>/ {capsules.length} running</span>
  </section>

  {#if error}
    <div class="page-error" role="alert">
      <span>{error}</span>
      <button type="button" onclick={refresh}>Retry</button>
    </div>
  {/if}

  {#if capsules.length}
    <div class="capsule-grid">
      {#each capsules as capsule (capsule.id)}
        <CapsuleCard {capsule} {busy} {showCredentials} onDelete={requestDestroy} />
      {/each}
    </div>
  {:else if !error}
    <section class="empty-state">
      <div class="empty-orbit" aria-hidden="true"><span></span></div>
      <p class="kicker">Team // 000</p>
      <h2>{$t('capsules.emptyTitle')}</h2>
      <p>{$t('capsules.emptyLead')}</p>
      <button type="button" onclick={openCreate}>{$t('capsules.create')} <span aria-hidden="true">→</span></button>
    </section>
  {/if}
{/if}

<dialog bind:this={createDialog} onclose={() => (mutationError = '')} aria-labelledby="create-title">
  <form class="dialog-panel" onsubmit={(event) => (event.preventDefault(), create())}>
    <header>
      <p class="dialog-kicker">Team // initialize</p>
      <h2 id="create-title">{$t('capsules.createTitle')}</h2>
      <p>{$t('capsules.createLead')}</p>
    </header>

    <label for="capsule-name">{$t('capsules.name')}</label>
    <input
      id="capsule-name"
      type="text"
      bind:value={name}
      placeholder={$t('capsules.placeholder')}
      maxlength="80"
      autocomplete="off"
      spellcheck="false"
      required
      disabled={busy}
    />

    {#if mutationError}<p class="dialog-error" role="alert">{mutationError}</p>{/if}

    <footer>
      <button class="dialog-secondary" type="button" onclick={() => createDialog.close()} disabled={busy}>
        {$t('capsules.cancel')}
      </button>
      <button class="dialog-primary" type="submit" disabled={busy || !name.trim()}>
        {busy ? $t('capsules.creating') : $t('capsules.createAction')}
      </button>
    </footer>
  </form>
</dialog>

<dialog
  class="danger-dialog"
  bind:this={deleteDialog}
  onclose={() => {
    pendingDelete = null;
    mutationError = '';
  }}
  aria-labelledby="destroy-title"
>
  <div class="dialog-panel">
    <header>
      <p class="dialog-kicker danger">Team // destructive operation</p>
      <h2 id="destroy-title">{$t('capsules.destroyTitle')}</h2>
      <p>{$t('capsules.destroyLead')}</p>
    </header>

    {#if pendingDelete}
      <div class="delete-target">
        <strong>{pendingDelete.name || pendingDelete.id}</strong>
        <code>{pendingDelete.id}</code>
      </div>
    {/if}

    {#if mutationError}<p class="dialog-error" role="alert">{mutationError}</p>{/if}

    <footer>
      <button class="dialog-secondary" type="button" onclick={() => deleteDialog.close()} disabled={busy}>
        {$t('capsules.cancel')}
      </button>
      <button class="dialog-danger" type="button" onclick={destroy} disabled={busy}>
        {busy ? $t('capsules.destroying') : $t('capsules.destroy')}
      </button>
    </footer>
  </div>
</dialog>

<style>
  .page-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 2rem;
    margin-bottom: 2rem;
  }

  .kicker,
  .dialog-kicker {
    margin: 0 0 0.9rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.19em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.8rem, 8vw, 5.5rem);
    line-height: 0.96;
    letter-spacing: -0.08em;
  }

  .lead {
    max-width: 61ch;
    margin: 1.15rem 0 0;
    color: var(--text-dim);
    font-size: 1.02rem;
    line-height: 1.7;
  }

  .create-button,
  .empty-state button {
    display: inline-flex;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: 1.4rem;
    border: 0;
    padding: 0 1rem;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
    color: var(--accent-ink);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .create-button:hover,
  .empty-state button:hover {
    filter: brightness(1.08) drop-shadow(0 0 12px rgba(0, 240, 255, 0.35));
  }

  .runtime-bar {
    display: flex;
    min-height: 2.8rem;
    align-items: center;
    gap: 0.35rem;
    padding: 0.65rem 1rem;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    background: rgba(6, 6, 6, 0.72);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .runtime-bar strong {
    color: var(--text);
  }

  .runtime-bar span {
    color: var(--text-faint);
  }

  .runtime-bar i {
    width: 0.42rem;
    height: 0.42rem;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.55);
  }

  .runtime-bar.offline {
    color: var(--danger);
  }

  .runtime-bar.offline i {
    background: var(--danger);
    box-shadow: 0 0 8px rgba(255, 96, 125, 0.45);
  }

  .capsule-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .page-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.8rem 1rem;
    margin-bottom: 1rem;
    border-inline-start: 2px solid var(--danger);
    background: rgba(255, 96, 125, 0.06);
    color: var(--danger);
    font-size: 0.82rem;
  }

  .page-error button {
    min-height: 2.35rem;
    border: 1px solid currentColor;
    padding: 0 0.65rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .empty-state,
  .auth-gate,
  .loading-state {
    display: flex;
    min-height: 25rem;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    border: 1px solid var(--border);
    background: radial-gradient(circle at 50% 35%, rgba(0, 240, 255, 0.055), transparent 48%), var(--surface-1);
    text-align: center;
  }

  .empty-state h2,
  .auth-gate h1 {
    max-width: 18ch;
    margin: 0;
    font-size: clamp(1.65rem, 4vw, 2.6rem);
    letter-spacing: -0.05em;
    text-wrap: balance;
  }

  .empty-state > p:not(.kicker),
  .auth-gate > p:not(.kicker) {
    max-width: 51ch;
    margin: 0.8rem 1rem 1.5rem;
    color: var(--text-dim);
    line-height: 1.65;
  }

  .empty-orbit,
  .pulse {
    position: relative;
    width: 4.6rem;
    height: 4.6rem;
    margin-bottom: 1.5rem;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
  }

  .empty-orbit::before,
  .empty-orbit::after {
    position: absolute;
    border: 1px solid rgba(0, 240, 255, 0.3);
    border-radius: 50%;
    content: '';
  }

  .empty-orbit::before {
    inset: 0.65rem;
  }

  .empty-orbit::after {
    inset: 1.4rem;
    background: var(--accent);
    box-shadow: 0 0 14px rgba(0, 240, 255, 0.45);
  }

  .empty-orbit span {
    position: absolute;
    top: 50%;
    right: -0.2rem;
    width: 0.42rem;
    height: 0.42rem;
    background: var(--accent-alt);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(255, 42, 109, 0.65);
  }

  .auth-gate a {
    display: inline-flex;
    min-height: 2.9rem;
    align-items: center;
    gap: 1.5rem;
    padding: 0 1rem;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-decoration: none;
    text-transform: uppercase;
  }

  .loading-state {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
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

  dialog {
    width: min(31rem, calc(100% - 1.5rem));
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(3px);
  }

  .dialog-panel {
    display: grid;
    gap: 0.75rem;
    padding: clamp(1.4rem, 5vw, 2rem);
    margin: 0;
    background: linear-gradient(145deg, var(--surface-2), var(--surface-1));
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    box-shadow: inset 0 0 0 1px var(--border-strong), var(--shadow);
  }

  .dialog-panel header {
    margin-bottom: 0.55rem;
  }

  .dialog-panel h2 {
    margin: 0;
    font-size: 1.65rem;
    letter-spacing: -0.045em;
  }

  .dialog-panel header > p:last-child {
    margin: 0.7rem 0 0;
    color: var(--text-dim);
    font-size: 0.86rem;
    line-height: 1.6;
  }

  .dialog-panel label {
    margin-top: 0.3rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .dialog-panel input {
    width: 100%;
    min-height: 3.1rem;
    border: 0;
    padding: 0.7rem 0.9rem;
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    color: var(--text);
    font-family: var(--font-mono);
    outline: 0;
  }

  .dialog-panel input:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
    filter: drop-shadow(0 0 7px rgba(0, 240, 255, 0.2));
  }

  .dialog-panel footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.55rem;
    padding-top: 0.8rem;
    margin-top: 0.35rem;
    border-top: 1px solid var(--border);
  }

  .dialog-panel footer button {
    min-height: 2.75rem;
    border: 0;
    padding: 0 0.85rem;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .dialog-panel footer button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .dialog-secondary {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    color: var(--text-dim);
  }

  .dialog-primary {
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    color: var(--accent-ink);
  }

  .dialog-danger {
    background: var(--danger);
    color: #160006;
  }

  .dialog-kicker.danger,
  .dialog-error {
    color: var(--danger);
  }

  .dialog-error {
    padding: 0.6rem 0.7rem;
    margin: 0;
    border-inline-start: 2px solid currentColor;
    background: rgba(255, 96, 125, 0.06);
    font-size: 0.78rem;
  }

  .delete-target {
    display: grid;
    gap: 0.25rem;
    padding: 0.8rem;
    border: 1px solid rgba(255, 96, 125, 0.3);
    background: var(--bg);
  }

  .delete-target strong {
    font-family: var(--font-mono);
    font-size: 0.86rem;
  }

  .delete-target code {
    overflow-wrap: anywhere;
    color: var(--text-faint);
    font-size: 0.68rem;
  }

  @media (max-width: 880px) {
    .capsule-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 620px) {
    .page-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .runtime-bar {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
