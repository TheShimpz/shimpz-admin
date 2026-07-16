<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import { INSTALL_INTENT, acceptsStoreInstallIntent } from '$lib/assistantIntent.js';
  import { evaluateHelloPulse, listInstalledAssistants, safeApiError } from '$lib/localApi.js';
  import { t, locale } from '$lib/i18n.js';

  const HELLO_ID = INSTALL_INTENT.assistant;
  const CID_RE = /^[a-z0-9_]{1,40}$/;
  const LOCAL_COPY = {
    en: {
      localKicker: 'Local evaluation // trusted',
      localTitle: 'Meet Hello Pulse.',
      localLead: 'Install the first released Assistant in one Capsule and run its declared hello operation. No Store login is required.',
      available: 'Ready in this Space',
      unavailable: 'Unavailable in this Space',
      evaluate: 'Install and run hello',
      runHello: 'Run hello',
      installed: 'Installed',
      installedTitle: 'Installed in this Capsule',
      installedEmpty: 'No Assistants installed in this Capsule.',
      inventoryLoading: 'Reading installed Assistants…',
      installedNow: 'Installed now',
      alreadyInstalled: 'Already installed',
      installedAt: 'Hello Pulse is installed in {capsule}.',
      noCapsules: 'Create a running Capsule before evaluating an Assistant.',
      createCapsule: 'Create a Capsule',
      confirmTitle: 'Install Hello Pulse?',
      confirmLead: 'Choose the exact Capsule. The Store cannot choose it or install anything for you.',
      capsuleLabel: 'Destination Capsule',
      capsulePlaceholder: 'Select a Capsule',
      cancel: 'Cancel',
      confirm: 'Confirm install',
      working: 'Installing and running…',
      result: 'Hello result',
      uninstall: 'Uninstall from Capsule',
      uninstallConfirm: 'Uninstall {assistant} from {capsule}?',
      removed: '{assistant} was uninstalled from {capsule}.',
      loadFailed: 'The local Assistant control plane is unavailable.',
      retry: 'Retry local data',
      genericFailure: 'The local evaluation could not be completed.',
    },
    pt: {
      localKicker: 'Avaliação local // confiável',
      localTitle: 'Conheça o Hello Pulse.',
      localLead: 'Instale o primeiro Assistant publicado em uma Cápsula e execute a operação hello declarada. Nenhum login da Store é necessário.',
      available: 'Pronto neste Space',
      unavailable: 'Indisponível neste Space',
      evaluate: 'Instalar e executar hello',
      runHello: 'Executar hello',
      installed: 'Instalado',
      installedTitle: 'Instalados nesta Cápsula',
      installedEmpty: 'Nenhum Assistant instalado nesta Cápsula.',
      inventoryLoading: 'Lendo Assistants instalados…',
      installedNow: 'Instalado agora',
      alreadyInstalled: 'Já estava instalado',
      installedAt: 'O Hello Pulse está instalado em {capsule}.',
      noCapsules: 'Crie uma Cápsula em execução antes de avaliar um Assistant.',
      createCapsule: 'Criar uma Cápsula',
      confirmTitle: 'Instalar o Hello Pulse?',
      confirmLead: 'Escolha a Cápsula exata. A Store não pode escolhê-la nem instalar nada por você.',
      capsuleLabel: 'Cápsula de destino',
      capsulePlaceholder: 'Selecione uma Cápsula',
      cancel: 'Cancelar',
      confirm: 'Confirmar instalação',
      working: 'Instalando e executando…',
      result: 'Resultado do hello',
      uninstall: 'Desinstalar da Cápsula',
      uninstallConfirm: 'Desinstalar {assistant} de {capsule}?',
      removed: '{assistant} foi desinstalado de {capsule}.',
      loadFailed: 'O plano de controle local de Assistants está indisponível.',
      retry: 'Tentar dados locais novamente',
      genericFailure: 'Não foi possível concluir a avaliação local.',
    },
  };

  let phase = $state('checking');
  let capsules = $state([]);
  let catalog = $state([]);
  let localError = $state('');
  let dialogError = $state('');
  let busy = $state(false);
  let activeCapsule = $state('');
  let selectedCapsule = $state('');
  let installedAssistants = $state([]);
  let inventoryPhase = $state('idle');
  let inventoryError = $state('');
  let inventoryAttempt = 0;
  let pendingAssistant = $state('');
  let evaluation = $state(null);
  let iframeElement = $state();
  let confirmDialog = $state();

  let currentLocale = $derived($locale);
  let copy = $derived(LOCAL_COPY[currentLocale] ?? LOCAL_COPY.en);
  let storeLocale = $derived(currentLocale === 'pt' ? 'pt' : 'en');
  let storeUrl = $derived(`https://shimpz.com/${storeLocale}/assistants/embed`);
  let runningCapsules = $derived(capsules.filter((capsule) => capsule.status === 'running'));
  let helloEntry = $derived(catalog.find((entry) => entry.id === HELLO_ID));
  let helloAvailable = $derived(Boolean(helloEntry && declaresHello(helloEntry)));
  let activeCapsuleRecord = $derived(runningCapsules.find((capsule) => capsule.id === activeCapsule) ?? null);
  let helloInstalled = $derived(installedAssistants.some((entry) => entry.assistant === HELLO_ID));

  function declaresHello(entry) {
    if (Array.isArray(entry?.operations)) {
      return entry.operations.some((operation) => operation === 'hello' || operation?.id === 'hello');
    }
    return Boolean(entry?.operations && typeof entry.operations === 'object' && entry.operations.hello);
  }

  function normalizeCapsules(document) {
    if (!document || !Array.isArray(document.capsules)) return [];
    return document.capsules
      .filter((item) => item && typeof item === 'object' && CID_RE.test(item.id))
      .map((item) => ({
        id: item.id,
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : item.id,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      }));
  }

  function normalizeCatalog(document) {
    if (!document || !Array.isArray(document.assistants)) return [];
    return document.assistants.filter((item) => item && typeof item === 'object' && item.id === HELLO_ID);
  }

  async function jsonObject(response) {
    const body = await response.json().catch(() => ({}));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  }

  function format(message, values) {
    let output = message;
    for (const [key, value] of Object.entries(values)) output = output.replaceAll(`{${key}}`, value);
    return output;
  }

  async function loadInstalled(capsuleId = activeCapsule) {
    const attempt = ++inventoryAttempt;
    installedAssistants = [];
    inventoryError = '';
    if (!capsuleId) {
      inventoryPhase = 'idle';
      return;
    }
    inventoryPhase = 'loading';
    try {
      const inventory = await listInstalledAssistants(fetch, capsuleId);
      if (attempt !== inventoryAttempt || capsuleId !== activeCapsule) return;
      installedAssistants = inventory;
      inventoryPhase = 'ready';
    } catch (error) {
      if (attempt !== inventoryAttempt || capsuleId !== activeCapsule) return;
      inventoryError = error instanceof Error ? error.message : copy.loadFailed;
      inventoryPhase = 'error';
    }
  }

  async function selectCapsule(event) {
    activeCapsule = event.currentTarget.value;
    const url = new URL(location.href);
    url.searchParams.set('capsule', activeCapsule);
    history.replaceState(history.state, '', url);
    evaluation = null;
    await loadInstalled(activeCapsule);
  }

  async function loadLocalData() {
    localError = '';
    try {
      const [capsuleResponse, catalogResponse] = await Promise.all([
        fetch('/api/capsules', { cache: 'no-store', headers: { Accept: 'application/json' } }),
        fetch('/api/assistants', { cache: 'no-store', headers: { Accept: 'application/json' } }),
      ]);
      if (capsuleResponse.status === 401 || catalogResponse.status === 401) {
        phase = 'needauth';
        return;
      }
      const [capsuleBody, catalogBody] = await Promise.all([
        jsonObject(capsuleResponse),
        jsonObject(catalogResponse),
      ]);
      if (!capsuleResponse.ok) throw new Error(safeApiError(capsuleBody, copy.loadFailed));
      if (!catalogResponse.ok) throw new Error(safeApiError(catalogBody, copy.loadFailed));
      capsules = normalizeCapsules(capsuleBody);
      catalog = normalizeCatalog(catalogBody);
      const requestedCapsule = new URL(location.href).searchParams.get('capsule') ?? '';
      if (capsules.some((capsule) => capsule.id === requestedCapsule && capsule.status === 'running')) {
        activeCapsule = requestedCapsule;
      }
      if (!capsules.some((capsule) => capsule.id === activeCapsule && capsule.status === 'running')) {
        activeCapsule = capsules.find((capsule) => capsule.status === 'running')?.id ?? '';
      }
      await loadInstalled(activeCapsule);
    } catch (error) {
      localError = error instanceof Error ? error.message : copy.loadFailed;
      catalog = [];
    }
  }

  async function checkSession() {
    phase = 'checking';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('session unavailable');
      if (!(await response.json()).authenticated) {
        phase = 'needauth';
        return;
      }
      phase = 'ready';
      await loadLocalData();
    } catch {
      phase = 'needauth';
    }
  }

  function beginInstall(assistantId) {
    if (assistantId !== HELLO_ID || !activeCapsuleRecord) return;
    if (helloInstalled) {
      evaluation = {
        kind: 'installed',
        note: copy.alreadyInstalled,
        message: format(copy.installedAt, { capsule: activeCapsuleRecord.name }),
      };
      return;
    }
    pendingAssistant = assistantId;
    selectedCapsule = activeCapsuleRecord.id;
    dialogError = '';
    confirmDialog?.showModal();
  }

  function handleStoreMessage(event) {
    if (acceptsStoreInstallIntent(event, iframeElement?.contentWindow)) beginInstall(HELLO_ID);
  }

  async function confirmInstall() {
    if (busy || pendingAssistant !== HELLO_ID || !helloAvailable) return;
    const capsule = runningCapsules.find((item) => item.id === selectedCapsule);
    if (!capsule) return;

    busy = true;
    dialogError = '';
    evaluation = null;
    try {
      const { message, installed } = await evaluateHelloPulse(fetch, capsule.id);
      evaluation = { kind: 'success', note: installed ? copy.installedNow : copy.alreadyInstalled, message };
      activeCapsule = capsule.id;
      await loadInstalled(capsule.id);
      confirmDialog?.close();
    } catch (error) {
      dialogError = error instanceof Error ? error.message : copy.genericFailure;
    } finally {
      busy = false;
    }
  }

  async function runHello() {
    if (busy || !activeCapsuleRecord || !helloInstalled) return;
    busy = true;
    localError = '';
    evaluation = null;
    try {
      const { message } = await evaluateHelloPulse(fetch, activeCapsuleRecord.id);
      evaluation = { kind: 'success', note: copy.alreadyInstalled, message };
      await loadInstalled(activeCapsuleRecord.id);
    } catch (error) {
      localError = error instanceof Error ? error.message : copy.genericFailure;
    } finally {
      busy = false;
    }
  }

  async function uninstallInstalled(assistant) {
    if (busy || !activeCapsuleRecord) return;
    const question = format(copy.uninstallConfirm, {
      assistant: assistant.assistant,
      capsule: activeCapsuleRecord.name,
    });
    if (!window.confirm(question)) return;
    busy = true;
    localError = '';
    try {
      const response = await fetch(
        `/api/capsules/${encodeURIComponent(activeCapsuleRecord.id)}/assistants/${encodeURIComponent(assistant.assistant)}`,
        { method: 'DELETE', headers: { Accept: 'application/json' } },
      );
      const body = await jsonObject(response);
      if (!response.ok) throw new Error(safeApiError(body, copy.genericFailure));
      evaluation = {
        kind: 'removed',
        note: copy.uninstall,
        message: format(copy.removed, {
          assistant: assistant.assistant,
          capsule: activeCapsuleRecord.name,
        }),
      };
      await loadInstalled(activeCapsuleRecord.id);
    } catch (error) {
      localError = error instanceof Error ? error.message : copy.genericFailure;
    } finally {
      busy = false;
    }
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      location.assign('/');
    }
  }

  onMount(() => {
    window.addEventListener('message', handleStoreMessage);
    checkSession();
    return () => window.removeEventListener('message', handleStoreMessage);
  });
</script>

<svelte:head>
  <title>Assistants — Shimpz Admin</title>
  <meta name="description" content="Browse and evaluate trusted Shimpz Assistants from the local Admin." />
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

    <section id="local-evaluation" class="evaluation-card" aria-labelledby="hello-pulse-title">
      <div class="assistant-mark" aria-hidden="true"><span>H</span><i></i></div>
      <div class="evaluation-copy">
        <p class="kicker">{copy.localKicker}</p>
        <h2 id="hello-pulse-title">{copy.localTitle}</h2>
        <p>{copy.localLead}</p>
        <div class:ready={helloAvailable} class:installed={helloInstalled} class="availability">
          <i aria-hidden="true"></i>{helloInstalled ? copy.installed : helloAvailable ? copy.available : copy.unavailable}
        </div>
      </div>
      <div class="evaluation-actions">
        {#if runningCapsules.length}
          <label class="capsule-picker" for="assistant-active-capsule">
            <span>{copy.capsuleLabel}</span>
            <select id="assistant-active-capsule" value={activeCapsule} disabled={busy} onchange={selectCapsule}>
              {#each runningCapsules as capsule (capsule.id)}
                <option value={capsule.id}>{capsule.name}</option>
              {/each}
            </select>
          </label>
          <button
            type="button"
            disabled={!helloAvailable || busy || inventoryPhase === 'loading'}
            onclick={helloInstalled ? runHello : () => beginInstall(HELLO_ID)}
          >
            {helloInstalled ? copy.runHello : copy.evaluate}<span aria-hidden="true">→</span>
          </button>
        {:else}
          <p>{copy.noCapsules}</p>
          <a href="/capsules/">{copy.createCapsule}<span aria-hidden="true">→</span></a>
        {/if}
      </div>
      {#if localError}
        <div class="local-error" role="alert">
          <span>{localError}</span>
          <button type="button" onclick={loadLocalData}>{copy.retry}</button>
        </div>
      {/if}
      <div class="installed-inventory" aria-live="polite">
        <header>
          <strong>{copy.installedTitle}</strong>
          <span>{installedAssistants.length}</span>
        </header>
        {#if inventoryPhase === 'loading'}
          <p>{copy.inventoryLoading}</p>
        {:else if inventoryPhase === 'error'}
          <div class="inventory-error" role="alert">
            <span>{inventoryError}</span>
            <button type="button" disabled={!activeCapsule} onclick={() => loadInstalled(activeCapsule)}>{copy.retry}</button>
          </div>
        {:else if installedAssistants.length}
          <ul>
            {#each installedAssistants as assistant (assistant.assistant)}
              <li>
                <span class="installed-mark" aria-hidden="true">✓</span>
                <strong>{assistant.assistant}</strong>
                <small>{assistant.status}</small>
                {#if assistant.assistant === HELLO_ID}
                  <button type="button" disabled={busy} onclick={runHello}>{copy.runHello}</button>
                {/if}
                <button class="remove-assistant" type="button" disabled={busy} onclick={() => uninstallInstalled(assistant)}>
                  {copy.uninstall}
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p>{copy.installedEmpty}</p>
        {/if}
      </div>
      {#if evaluation}
        <div class:removed={evaluation.kind === 'removed'} class="hello-result" role="status">
          <span>{evaluation.note ?? copy.result}</span>
          <strong>{evaluation.message}</strong>
        </div>
      {/if}
    </section>

    <section class="store-frame" aria-labelledby="store-source">
      <header>
        <span id="store-source"><i aria-hidden="true"></i>{$t('store.source')}</span>
        <code>SHIMPZ // STORE</code>
      </header>
      <iframe
        bind:this={iframeElement}
        src={storeUrl}
        title={$t('store.frameTitle')}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="origin"
      ></iframe>
    </section>

    <p class="trust-boundary"><span aria-hidden="true">◇</span>{$t('store.boundary')}</p>
  {/if}
</AdminShell>

<dialog bind:this={confirmDialog} aria-labelledby="assistant-confirm-title" onclose={() => (dialogError = '')}>
  <form class="dialog-panel" onsubmit={(event) => { event.preventDefault(); confirmInstall(); }}>
    <header>
      <p class="dialog-kicker">Assistant // local admission</p>
      <h2 id="assistant-confirm-title">{copy.confirmTitle}</h2>
      <p>{copy.confirmLead}</p>
    </header>
    {#if activeCapsuleRecord}
      <div class="dialog-target">
        <span>{copy.capsuleLabel}</span>
        <strong>{activeCapsuleRecord.name}</strong>
        <code>{activeCapsuleRecord.id}</code>
      </div>
    {/if}
    {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}
    <footer>
      <button type="button" class="dialog-secondary" disabled={busy} onclick={() => confirmDialog?.close()}>
        {copy.cancel}
      </button>
      <button type="submit" class="dialog-primary" disabled={busy || !selectedCapsule || !helloAvailable}>
        {busy ? copy.working : copy.confirm}
      </button>
    </footer>
  </form>
</dialog>

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
  .kicker, .dialog-kicker {
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
  .external, .sign-in, .evaluation-actions a {
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
  .external:hover, .sign-in:hover { filter: drop-shadow(0 0 9px rgba(0, 240, 255, 0.32)); }

  .evaluation-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(13rem, auto);
    align-items: center;
    gap: clamp(1rem, 3vw, 2rem);
    margin-bottom: 1.25rem;
    padding: clamp(1.2rem, 3vw, 2rem);
    background: radial-gradient(circle at 10% 50%, rgba(0, 240, 255, 0.08), transparent 30%), var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }
  .assistant-mark {
    position: relative;
    display: grid;
    width: 4.8rem;
    height: 4.8rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 1.5rem;
    font-weight: 700;
  }
  .assistant-mark::before, .assistant-mark i {
    position: absolute;
    inset: 0.5rem;
    border: 1px dashed rgba(0, 240, 255, 0.35);
    border-radius: 50%;
    content: '';
  }
  .assistant-mark i { inset: -0.35rem; border-color: rgba(255, 61, 242, 0.22); }
  .evaluation-copy h2 { margin: 0; font-size: clamp(1.5rem, 3vw, 2.3rem); letter-spacing: -0.05em; }
  .evaluation-copy > p:not(.kicker) { max-width: 58ch; margin: 0.65rem 0 0; color: var(--text-dim); line-height: 1.6; }
  .availability { display: inline-flex; align-items: center; gap: 0.45rem; margin-top: 0.9rem; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.62rem; text-transform: uppercase; }
  .availability i { width: 0.42rem; height: 0.42rem; border-radius: 50%; background: var(--danger); }
  .availability.ready { color: var(--success); }
  .availability.ready i { background: var(--success); box-shadow: 0 0 8px rgba(5, 255, 161, 0.55); }
  .availability.installed { font-weight: 700; }
  .evaluation-actions { display: flex; align-items: flex-end; flex-direction: column; gap: 0.75rem; }
  .evaluation-actions > p { max-width: 25ch; margin: 0; color: var(--text-dim); font-size: 0.78rem; line-height: 1.5; text-align: right; }
  .capsule-picker { display: grid; width: min(100%, 17rem); gap: 0.35rem; }
  .capsule-picker span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.56rem; letter-spacing: 0.09em; text-transform: uppercase; }
  .capsule-picker select { width: 100%; min-height: 2.55rem; border: 1px solid var(--border-strong); padding: 0 2rem 0 0.75rem; background: #050708; color: var(--text); font-family: var(--font-mono); font-size: 0.68rem; }
  .evaluation-actions button, .dialog-primary, .dialog-secondary, .local-error button {
    min-height: 2.8rem;
    border: 0;
    padding: 0 1rem;
    background: var(--accent);
    color: #001013;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .evaluation-actions button { display: inline-flex; align-items: center; gap: 1rem; }
  button:disabled { cursor: not-allowed; opacity: 0.42; }
  .local-error, .hello-result { grid-column: 1 / -1; }
  .local-error { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 1rem; border-top: 1px solid var(--danger); color: var(--danger); font-size: 0.78rem; }
  .local-error button { min-height: 2.2rem; background: transparent; box-shadow: inset 0 0 0 1px var(--danger); color: var(--danger); }
  .hello-result { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 1rem; padding: 1rem; border-left: 2px solid var(--success); background: rgba(5, 255, 161, 0.045); }
  .hello-result.removed { border-left-color: var(--accent-alt); background: rgba(255, 61, 242, 0.04); }
  .hello-result span { color: var(--success); font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .hello-result strong { font-size: 0.9rem; }

  .installed-inventory { grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 1rem; }
  .installed-inventory > header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .installed-inventory > header strong { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .installed-inventory > header span { display: grid; min-width: 1.55rem; height: 1.55rem; place-items: center; border: 1px solid var(--border-strong); color: var(--accent); font-family: var(--font-mono); font-size: 0.65rem; }
  .installed-inventory > p { margin: 0.7rem 0 0; color: var(--text-faint); font-size: 0.76rem; }
  .installed-inventory ul { display: grid; gap: 0.45rem; margin: 0.75rem 0 0; padding: 0; list-style: none; }
  .installed-inventory li { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 0.7rem; border: 1px solid var(--border); padding: 0.55rem 0.65rem; background: rgba(0, 0, 0, 0.24); }
  .installed-mark { color: var(--success); font-family: var(--font-mono); }
  .installed-inventory li strong { overflow: hidden; font-family: var(--font-mono); font-size: 0.76rem; text-overflow: ellipsis; white-space: nowrap; }
  .installed-inventory li small { color: var(--success); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.07em; text-transform: uppercase; }
  .installed-inventory button, .inventory-error button { min-height: 2rem; border: 1px solid var(--border-strong); padding: 0 0.6rem; background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.56rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .installed-inventory .remove-assistant { border-color: rgba(255, 96, 125, 0.35); color: var(--danger); }
  .inventory-error { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 0.7rem; color: var(--danger); font-size: 0.75rem; }

  .store-frame {
    overflow: hidden;
    background: #000;
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 20px 60px rgba(0, 0, 0, 0.4);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }
  .store-frame > header { display: flex; min-height: 2.9rem; align-items: center; justify-content: space-between; gap: 1rem; padding: 0 1rem; border-bottom: 1px solid var(--border); background: var(--surface-1); color: var(--text-faint); font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .store-frame > header span { display: inline-flex; align-items: center; gap: 0.5rem; }
  .store-frame > header i { width: 0.42rem; height: 0.42rem; background: var(--success); border-radius: 50%; box-shadow: 0 0 8px rgba(5, 255, 161, 0.55); }
  .store-frame code { color: var(--accent); font-size: inherit; }
  iframe { display: block; width: 100%; height: min(72rem, calc(100vh - 12rem)); min-height: 42rem; border: 0; background: #000; }
  .trust-boundary { display: flex; max-width: 78ch; align-items: flex-start; gap: 0.65rem; margin: 1rem 0 0; color: var(--text-faint); font-size: 0.76rem; line-height: 1.6; }
  .trust-boundary span { color: var(--accent-alt); }

  dialog { width: min(34rem, calc(100vw - 2rem)); border: 0; padding: 0; background: transparent; color: var(--text); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(8px); }
  .dialog-panel { padding: clamp(1.4rem, 4vw, 2.2rem); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65); clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut)); }
  .dialog-panel h2 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.5rem); letter-spacing: -0.05em; }
  .dialog-panel header > p:last-child { margin: 0.8rem 0 1.5rem; color: var(--text-dim); line-height: 1.6; }
  .dialog-target { display: grid; gap: 0.2rem; border: 1px solid var(--border-strong); padding: 0.8rem; background: #050708; }
  .dialog-target span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .dialog-target strong { font-size: 0.9rem; }
  .dialog-target code { color: var(--accent); font-size: 0.65rem; }
  .dialog-error { margin: 0.8rem 0 0; color: var(--danger); font-size: 0.78rem; line-height: 1.5; }
  .dialog-panel footer { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; }
  .dialog-secondary { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-dim); }

  .state { display: flex; min-height: 28rem; align-items: center; justify-content: center; flex-direction: column; border: 1px solid var(--border); background: radial-gradient(circle at 50% 35%, rgba(0, 240, 255, 0.055), transparent 48%), var(--surface-1); color: var(--text-dim); text-align: center; }
  .state h1 { max-width: 18ch; font-size: clamp(1.65rem, 4vw, 2.6rem); letter-spacing: -0.05em; }
  .state > p:not(.kicker) { max-width: 51ch; margin: 0.8rem 1rem 1.5rem; line-height: 1.65; }
  .pulse { position: relative; width: 4.6rem; height: 4.6rem; margin-bottom: 1.5rem; border: 1px solid var(--border-strong); border-radius: 50%; }
  .pulse::before, .pulse::after, .pulse span { position: absolute; border: 1px solid var(--accent); border-radius: 50%; content: ''; animation: pulse 1.8s ease-out infinite; }
  .pulse::before { inset: 1.5rem; }
  .pulse::after { inset: 0.8rem; animation-delay: 0.35s; }
  .pulse span { inset: 0; animation-delay: 0.7s; }
  @keyframes pulse { 0% { opacity: 0.8; transform: scale(0.7); } 100% { opacity: 0; transform: scale(1.12); } }

  @media (max-width: 820px) {
    .evaluation-card { grid-template-columns: auto minmax(0, 1fr); }
    .evaluation-actions { grid-column: 1 / -1; align-items: stretch; }
    .evaluation-actions > p { max-width: none; text-align: left; }
  }
  @media (max-width: 720px) {
    .store-header { grid-template-columns: 1fr; align-items: start; }
    .external { width: 100%; }
    iframe { min-height: 36rem; }
    .hello-result { grid-template-columns: 1fr; }
    .installed-inventory li { grid-template-columns: auto minmax(0, 1fr) auto; }
    .installed-inventory li button { grid-column: span 1; }
  }
  @media (max-width: 520px) {
    .evaluation-card { grid-template-columns: 1fr; }
    .assistant-mark { width: 4rem; height: 4rem; }
    .evaluation-actions, .local-error, .hello-result { grid-column: 1; }
    .local-error { align-items: stretch; flex-direction: column; }
    .installed-inventory li { grid-template-columns: auto minmax(0, 1fr); }
    .installed-inventory li small { text-align: right; }
    .installed-inventory li button { grid-column: 1 / -1; }
    .inventory-error { align-items: stretch; flex-direction: column; }
    .dialog-panel footer { align-items: stretch; flex-direction: column-reverse; }
  }
</style>
