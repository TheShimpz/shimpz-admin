<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import {
    INSTALL_INTENT,
    STORE_FRAME_MAX_HEIGHT,
    STORE_FRAME_MIN_HEIGHT,
    STORE_LIFECYCLE_PROTOCOL_VERSION,
    acknowledgeStoreFrame,
    acknowledgeStoreInstallIntent,
    acknowledgeStoreUninstallIntent,
    createStoreActionLatch,
    postStoreAssistantState,
    projectReleasedStoreAssistantIds,
  } from '$lib/assistantIntent.js';
  import { installAssistant, listInstalledAssistants, safeApiError } from '$lib/localApi.js';
  import { t, locale } from '$lib/i18n.js';

  const HELLO_ID = INSTALL_INTENT.assistant;
  const CID_RE = /^[a-z0-9_]{1,40}$/;
  const FRAME_READY_TIMEOUT_MS = 8000;
  const LOCAL_COPY = {
    en: {
      installedTitle: 'Installed in this Team',
      installedEmpty: 'No Assistants installed in this Team.',
      inventoryLoading: 'Reading installed Assistants…',
      installedNow: 'Installed now',
      alreadyInstalled: 'Already installed',
      contextLabel: 'Local Team',
      noCapsules: 'No running Team yet. Create one before installing an Assistant.',
      createCapsule: 'Create a Team',
      confirmTitle: 'Install Hello Pulse?',
      confirmLead: 'Choose the exact Team. The Store cannot choose it or install anything for you.',
      checkingTitle: 'Preparing the local action…',
      checkingLead: 'The Admin is checking the selected Team and its installed Assistants.',
      alreadyTitle: 'Hello Pulse is already installed.',
      alreadyLead: 'Nothing was installed twice. The Assistant remains ready for your Team.',
      noCapsuleTitle: 'Installation needs a running Team.',
      noCapsuleLead: 'Your request reached this Admin, but nothing was installed because there is no local destination yet.',
      unavailableTitle: 'Hello Pulse is unavailable right now.',
      unavailableLead: 'The local catalog or installed inventory could not be verified. Retry the local data before installing.',
      successTitle: 'Hello Pulse is ready.',
      successLead: 'The Assistant was installed without running any Power or routine.',
      failureTitle: 'The local action did not finish.',
      failureLead: 'Nothing was hidden. Review the error below and retry when the local controller is available.',
      capsuleLabel: 'Destination Team',
      capsulePlaceholder: 'Select a Team',
      cancel: 'Cancel',
      close: 'Close',
      preparing: 'Checking…',
      confirm: 'Confirm install',
      retryAction: 'Try again',
      working: 'Installing…',
      uninstall: 'Uninstall from Team',
      uninstallConfirm: 'Uninstall {assistant} from {capsule}?',
      removed: '{assistant} was uninstalled from {capsule}.',
      loadFailed: 'The local Assistant control plane is unavailable.',
      retry: 'Retry local data',
      genericFailure: 'The local evaluation could not be completed.',
      frameLoading: 'Loading the Assistant Store…',
      frameFailureTitle: 'The Store did not finish loading.',
      frameFailureLead: 'Your local Team is unchanged. Reload the embedded Store or open the canonical page in a new tab.',
      retryStore: 'Reload Store',
      openStore: 'Open Store',
    },
    pt: {
      installedTitle: 'Instalados neste Time',
      installedEmpty: 'Nenhum Assistant instalado neste Time.',
      inventoryLoading: 'Lendo Assistants instalados…',
      installedNow: 'Instalado agora',
      alreadyInstalled: 'Já estava instalado',
      contextLabel: 'Time local',
      noCapsules: 'Ainda não há um Time em execução. Crie um antes de instalar um Assistant.',
      createCapsule: 'Criar um Time',
      confirmTitle: 'Instalar o Hello Pulse?',
      confirmLead: 'Escolha o Time exato. A Store não pode escolhê-lo nem instalar nada por você.',
      checkingTitle: 'Preparando a ação local…',
      checkingLead: 'O Admin está verificando o Time selecionado e seus Assistants instalados.',
      alreadyTitle: 'O Hello Pulse já está instalado.',
      alreadyLead: 'Nada foi instalado duas vezes. O Assistant continua pronto para o seu Time.',
      noCapsuleTitle: 'A instalação precisa de um Time em execução.',
      noCapsuleLead: 'Seu pedido chegou a este Admin, mas nada foi instalado porque ainda não existe um destino local.',
      unavailableTitle: 'O Hello Pulse está indisponível agora.',
      unavailableLead: 'Não foi possível verificar o catálogo local ou o inventário instalado. Atualize os dados locais antes de instalar.',
      successTitle: 'O Hello Pulse está pronto.',
      successLead: 'O Assistant foi instalado sem executar nenhuma Power ou rotina.',
      failureTitle: 'A ação local não foi concluída.',
      failureLead: 'Nada foi ocultado. Revise o erro abaixo e tente novamente quando o controller local estiver disponível.',
      capsuleLabel: 'Time de destino',
      capsulePlaceholder: 'Selecione um Time',
      cancel: 'Cancelar',
      close: 'Fechar',
      preparing: 'Verificando…',
      confirm: 'Confirmar instalação',
      retryAction: 'Tentar novamente',
      working: 'Instalando…',
      uninstall: 'Desinstalar do Time',
      uninstallConfirm: 'Desinstalar {assistant} de {capsule}?',
      removed: '{assistant} foi desinstalado de {capsule}.',
      loadFailed: 'O plano de controle local de Assistants está indisponível.',
      retry: 'Tentar dados locais novamente',
      genericFailure: 'Não foi possível concluir a avaliação local.',
      frameLoading: 'Carregando a Store de Assistants…',
      frameFailureTitle: 'A Store não terminou de carregar.',
      frameFailureLead: 'Seu Time local não foi alterado. Recarregue a Store incorporada ou abra a página oficial em uma nova aba.',
      retryStore: 'Recarregar Store',
      openStore: 'Abrir Store',
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
  let localDataPhase = $state('idle');
  let localDataRequest = Promise.resolve();
  let pendingAssistant = $state('');
  let evaluation = $state(null);
  let iframeElement = $state();
  let confirmDialog = $state();
  let dialogMode = $state('install');
  let dialogResult = $state(null);
  let dialogAttempt = 0;
  let framePhase = $state('loading');
  let frameHeight = $state(420);
  let frameReload = $state(0);
  let frameTimeout;
  let storeSnapshotStatus = 'loading';
  let storeSnapshotInstalled = [];
  const storeActionLatch = createStoreActionLatch();

  let currentLocale = $derived($locale);
  let copy = $derived(LOCAL_COPY[currentLocale] ?? LOCAL_COPY.en);
  let storeLocale = $derived(currentLocale === 'pt' ? 'pt' : 'en');
  let storePageUrl = $derived(`https://shimpz.com/${storeLocale}/assistants`);
  let storeUrl = $derived(
    `${storePageUrl}/embed?store-protocol=${STORE_LIFECYCLE_PROTOCOL_VERSION}&admin-frame=${frameReload}`,
  );
  let runningCapsules = $derived(capsules.filter((capsule) => capsule.status === 'running'));
  let helloEntry = $derived(catalog.find((entry) => entry.id === HELLO_ID));
  let helloAvailable = $derived(Boolean(helloEntry && declaresHello(helloEntry)));
  let activeCapsuleRecord = $derived(runningCapsules.find((capsule) => capsule.id === activeCapsule) ?? null);
  let selectedCapsuleRecord = $derived(runningCapsules.find((capsule) => capsule.id === selectedCapsule) ?? null);
  let dialogTitle = $derived({
    checking: copy.checkingTitle,
    install: copy.confirmTitle,
    installed: copy.alreadyTitle,
    'no-capsule': copy.noCapsuleTitle,
    unavailable: copy.unavailableTitle,
    success: copy.successTitle,
    error: copy.failureTitle,
  }[dialogMode] ?? copy.confirmTitle);
  let dialogLead = $derived({
    checking: copy.checkingLead,
    install: copy.confirmLead,
    installed: copy.alreadyLead,
    'no-capsule': copy.noCapsuleLead,
    unavailable: copy.unavailableLead,
    success: copy.successLead,
    error: copy.failureLead,
  }[dialogMode] ?? copy.confirmLead);

  function declaresHello(entry) {
    if (Array.isArray(entry?.powers)) {
      return entry.powers.some((power) => power === 'hello' || power?.id === 'hello');
    }
    return Boolean(entry?.powers && typeof entry.powers === 'object' && entry.powers.hello);
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

  function publishStoreSnapshot(
    status = storeSnapshotStatus,
    installed = storeSnapshotInstalled,
  ) {
    storeSnapshotStatus = status;
    storeSnapshotInstalled = status === 'ready' ? [...installed] : [];
    postStoreAssistantState(
      iframeElement?.contentWindow,
      storeSnapshotStatus,
      storeSnapshotInstalled,
    );
  }

  async function loadInstalled(capsuleId = activeCapsule) {
    const attempt = ++inventoryAttempt;
    installedAssistants = [];
    inventoryError = '';
    inventoryPhase = 'loading';
    publishStoreSnapshot('loading', []);
    if (!capsuleId) {
      inventoryPhase = 'idle';
      publishStoreSnapshot('ready', []);
      return;
    }
    try {
      const inventory = await listInstalledAssistants(fetch, capsuleId);
      if (attempt !== inventoryAttempt || capsuleId !== activeCapsule) return;
      installedAssistants = inventory;
      inventoryPhase = 'ready';
      publishStoreSnapshot('ready', projectReleasedStoreAssistantIds(inventory));
    } catch (error) {
      if (attempt !== inventoryAttempt || capsuleId !== activeCapsule) return;
      inventoryError = error instanceof Error ? error.message : copy.loadFailed;
      inventoryPhase = 'error';
      publishStoreSnapshot('error', []);
    }
  }

  async function selectCapsule(event) {
    publishStoreSnapshot('loading', []);
    activeCapsule = event.currentTarget.value;
    const url = new URL(location.href);
    url.searchParams.set('capsule', activeCapsule);
    history.replaceState(history.state, '', url);
    evaluation = null;
    await loadInstalled(activeCapsule);
  }

  async function loadLocalData() {
    localDataPhase = 'loading';
    localError = '';
    publishStoreSnapshot('loading', []);
    try {
      const [capsuleResponse, catalogResponse] = await Promise.all([
        fetch('/api/capsules', { cache: 'no-store', headers: { Accept: 'application/json' } }),
        fetch('/api/assistants', { cache: 'no-store', headers: { Accept: 'application/json' } }),
      ]);
      if (capsuleResponse.status === 401 || catalogResponse.status === 401) {
        phase = 'needauth';
        localDataPhase = 'error';
        publishStoreSnapshot('error', []);
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
      localDataPhase = inventoryPhase === 'error' ? 'error' : 'ready';
    } catch (error) {
      localError = error instanceof Error ? error.message : copy.loadFailed;
      catalog = [];
      localDataPhase = 'error';
      publishStoreSnapshot('error', []);
    }
  }

  function refreshLocalData() {
    localDataRequest = loadLocalData();
    return localDataRequest;
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
      framePhase = 'loading';
      waitForStoreFrame();
      await refreshLocalData();
    } catch {
      phase = 'needauth';
    }
  }

  function showInstallDialog() {
    if (confirmDialog && !confirmDialog.open) confirmDialog.showModal();
  }

  async function beginInstall(assistantId) {
    const attempt = ++dialogAttempt;
    pendingAssistant = assistantId;
    selectedCapsule = activeCapsuleRecord?.id ?? '';
    dialogError = '';
    dialogResult = null;
    dialogMode = 'checking';
    showInstallDialog();

    if (assistantId !== HELLO_ID) {
      dialogMode = 'unavailable';
      return;
    }
    if (localDataPhase === 'loading') await localDataRequest;
    if (attempt !== dialogAttempt) return;

    const capsule = activeCapsuleRecord;
    selectedCapsule = capsule?.id ?? '';
    if (localDataPhase === 'error') {
      dialogMode = 'unavailable';
      return;
    }
    if (!capsule) {
      dialogMode = 'no-capsule';
      return;
    }
    if (!helloAvailable) {
      dialogMode = 'unavailable';
      return;
    }
    if (inventoryPhase === 'loading') await loadInstalled(capsule.id);
    if (attempt !== dialogAttempt) return;
    if (inventoryPhase === 'error') {
      dialogMode = 'unavailable';
      return;
    }
    dialogMode = installedAssistants.some((entry) => entry.assistant === HELLO_ID) ? 'installed' : 'install';
  }

  function clearFrameTimeout() {
    if (frameTimeout) window.clearTimeout(frameTimeout);
    frameTimeout = undefined;
  }

  function waitForStoreFrame() {
    clearFrameTimeout();
    frameTimeout = window.setTimeout(() => {
      if (framePhase === 'loading') framePhase = 'error';
    }, FRAME_READY_TIMEOUT_MS);
  }

  function storeFrameLoaded() {
    if (framePhase === 'loading') waitForStoreFrame();
  }

  function reloadStoreFrame() {
    framePhase = 'loading';
    frameHeight = 420;
    frameReload += 1;
    waitForStoreFrame();
  }

  function handleStoreMessage(event) {
    const measuredHeight = acknowledgeStoreFrame(event, iframeElement?.contentWindow);
    if (measuredHeight !== null) {
      frameHeight = Math.min(STORE_FRAME_MAX_HEIGHT, Math.max(STORE_FRAME_MIN_HEIGHT, measuredHeight));
      framePhase = 'ready';
      clearFrameTimeout();
      publishStoreSnapshot();
      return;
    }
    if (acknowledgeStoreInstallIntent(event, iframeElement?.contentWindow)) {
      if (!storeActionLatch.acquire('install')) {
        publishStoreSnapshot();
        return;
      }
      void runStoreInstall(event.data.assistant);
      return;
    }
    if (acknowledgeStoreUninstallIntent(event, iframeElement?.contentWindow)) {
      if (!storeActionLatch.acquire('uninstall')) {
        publishStoreSnapshot();
        return;
      }
      void runStoreUninstall(event.data.assistant);
    }
  }

  async function confirmInstall() {
    if (
      busy ||
      pendingAssistant !== HELLO_ID ||
      !helloAvailable ||
      !['install', 'error'].includes(dialogMode)
    ) return;
    const capsule = runningCapsules.find((item) => item.id === selectedCapsule);
    if (!capsule) return;

    evaluation = null;
    busy = true;
    dialogError = '';
    dialogResult = null;
    try {
      const { installed } = await installAssistant(fetch, capsule.id, HELLO_ID);
      dialogResult = { note: installed ? copy.installedNow : copy.alreadyInstalled };
      dialogMode = 'success';
      activeCapsule = capsule.id;
      await loadInstalled(capsule.id);
    } catch (error) {
      const actionError = error instanceof Error ? error.message : copy.genericFailure;
      activeCapsule = capsule.id;
      await loadInstalled(capsule.id);
      dialogError = actionError;
      dialogMode = 'error';
    } finally {
      busy = false;
    }
  }

  async function runStoreInstall(assistantId) {
    try {
      await beginInstall(assistantId);
    } catch (error) {
      dialogError = error instanceof Error ? error.message : copy.genericFailure;
      if (confirmDialog?.open) {
        dialogMode = 'error';
      } else {
        storeActionLatch.release('install');
      }
      publishStoreSnapshot();
    }
  }

  function closeInstallDialog() {
    if (busy) return;
    dialogAttempt += 1;
    confirmDialog?.close();
    storeActionLatch.release('install');
    publishStoreSnapshot();
  }

  function cancelInstallDialog(event) {
    event.preventDefault();
    if (busy) return;
    closeInstallDialog();
  }

  async function uninstallInstalled(assistant) {
    if (busy || !activeCapsuleRecord) return;
    const question = format(copy.uninstallConfirm, {
      assistant: assistant.assistant,
      capsule: activeCapsuleRecord.name,
    });
    if (!window.confirm(question)) {
      publishStoreSnapshot();
      return;
    }
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
      const actionError = error instanceof Error ? error.message : copy.genericFailure;
      await loadInstalled(activeCapsuleRecord.id);
      localError = actionError;
    } finally {
      busy = false;
    }
  }

  async function beginStoreUninstall(assistantId) {
    const installed = inventoryPhase === 'ready'
      ? installedAssistants.find((entry) => entry.assistant === assistantId)
      : null;
    if (!activeCapsuleRecord || !installed || busy) {
      publishStoreSnapshot();
      return;
    }
    await uninstallInstalled(installed);
  }

  async function runStoreUninstall(assistantId) {
    try {
      await beginStoreUninstall(assistantId);
    } finally {
      storeActionLatch.release('uninstall');
      publishStoreSnapshot();
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
    return () => {
      clearFrameTimeout();
      window.removeEventListener('message', handleStoreMessage);
    };
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
    <h1 class="sr-only">{$t('store.nav')}</h1>

    <section class="capsule-context" aria-labelledby="local-inventory-title">
      <header class="context-heading">
        <div>
          <span><i aria-hidden="true"></i>{copy.contextLabel}</span>
          <strong id="local-inventory-title">{copy.installedTitle}</strong>
        </div>
        <b title={copy.installedTitle}>{installedAssistants.length}</b>
      </header>

      <div class="context-content">
        {#if runningCapsules.length}
          <label class="capsule-picker" for="assistant-active-capsule">
            <span>{copy.capsuleLabel}</span>
            <select id="assistant-active-capsule" value={activeCapsule} disabled={busy} onchange={selectCapsule}>
              {#each runningCapsules as capsule (capsule.id)}
                <option value={capsule.id}>{capsule.name}</option>
              {/each}
            </select>
          </label>
        {:else}
          <div class="no-capsule">
            <p>{copy.noCapsules}</p>
            <a href="/capsules/">{copy.createCapsule}<span aria-hidden="true">→</span></a>
          </div>
        {/if}

        <div class="installed-inventory" aria-live="polite">
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
                  <div class="installed-name">
                    <span class="installed-mark" aria-hidden="true">✓</span>
                    <strong>{assistant.assistant}</strong>
                    <small>{assistant.status}</small>
                  </div>
                  <div class="installed-actions">
                    <button class="remove-assistant" type="button" disabled={busy} onclick={() => uninstallInstalled(assistant)}>
                      {copy.uninstall}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {:else if activeCapsule}
            <p>{copy.installedEmpty}</p>
          {/if}
        </div>

        <a class="external" href={storePageUrl} target="_blank" rel="noopener noreferrer">
          {copy.openStore} <span aria-hidden="true">↗</span>
        </a>
      </div>

      {#if localError}
        <div class="local-error" role="alert">
          <span>{localError}</span>
          <button type="button" onclick={refreshLocalData}>{copy.retry}</button>
        </div>
      {/if}

      <div class="context-feedback">
        {#if evaluation}
          <div class:removed={evaluation.kind === 'removed'} class="sidebar-result" role="status">
            <span>{evaluation.note}</span>
            <strong>{evaluation.message}</strong>
          </div>
        {/if}
      </div>
    </section>

    <section class="store-frame" aria-label={$t('store.frameTitle')} aria-busy={framePhase === 'loading'}>
      <div class="frame-stage" style={`height:${frameHeight}px`}>
        <iframe
          bind:this={iframeElement}
          src={storeUrl}
          title={$t('store.frameTitle')}
          class:frame-ready={framePhase === 'ready'}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="origin"
          onload={storeFrameLoaded}
        ></iframe>
        {#if framePhase === 'loading'}
          <div class="frame-state frame-loading" role="status">
            <div class="frame-spinner" aria-hidden="true"><span></span></div>
            <p>{copy.frameLoading}</p>
          </div>
        {:else if framePhase === 'error'}
          <div class="frame-state frame-error" role="alert">
            <span class="frame-error-mark" aria-hidden="true">!</span>
            <div>
              <strong>{copy.frameFailureTitle}</strong>
              <p>{copy.frameFailureLead}</p>
            </div>
            <div class="frame-actions">
              <button type="button" onclick={reloadStoreFrame}>{copy.retryStore}</button>
              <a href={storePageUrl} target="_blank" rel="noopener noreferrer">{copy.openStore}<span aria-hidden="true">↗</span></a>
            </div>
          </div>
        {/if}
      </div>
    </section>

    <p class="trust-boundary"><span aria-hidden="true">◇</span>{$t('store.boundary')}</p>
  {/if}
</AdminShell>

<dialog bind:this={confirmDialog} aria-labelledby="assistant-confirm-title" oncancel={cancelInstallDialog}>
  <form class="dialog-panel" onsubmit={(event) => { event.preventDefault(); confirmInstall(); }}>
    <header>
      <p class="dialog-kicker">Assistant // local admission</p>
      <h2 id="assistant-confirm-title">{dialogTitle}</h2>
      <p>{dialogLead}</p>
    </header>
    {#if selectedCapsuleRecord}
      <div class="dialog-target">
        <span>{copy.capsuleLabel}</span>
        <strong>{selectedCapsuleRecord.name}</strong>
        <code>{selectedCapsuleRecord.id}</code>
      </div>
    {/if}
    {#if dialogMode === 'checking'}
      <p class="dialog-progress" role="status">{copy.preparing}</p>
    {:else if dialogMode === 'no-capsule'}
      <a class="dialog-route" href="/capsules/">{copy.createCapsule}<span aria-hidden="true">→</span></a>
    {/if}
    {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}
    {#if dialogResult}
      <div class="dialog-result" role="status">
        <span>{dialogResult.note}</span>
        {#if dialogResult.message}<strong>{dialogResult.message}</strong>{/if}
      </div>
    {/if}
    <footer>
      <button type="button" class="dialog-secondary" disabled={busy} onclick={closeInstallDialog}>
        {dialogMode === 'install' ? copy.cancel : copy.close}
      </button>
      {#if ['install', 'error'].includes(dialogMode)}
        <button type="submit" class="dialog-primary" disabled={busy || !selectedCapsule || !helloAvailable}>
          {busy
            ? copy.working
            : dialogMode === 'error'
                ? copy.retryAction
                : copy.confirm}
        </button>
      {/if}
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
    font-size: clamp(2rem, 5vw, 3.2rem);
    line-height: 1;
    letter-spacing: -0.065em;
    text-wrap: balance;
  }
  .external, .sign-in, .no-capsule a, .frame-actions a {
    display: inline-flex;
    min-height: 2.5rem;
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
  .external:hover, .sign-in:hover, .frame-actions a:hover { filter: drop-shadow(0 0 9px rgba(0, 240, 255, 0.32)); }

  .capsule-context {
    display: grid;
    grid-template-columns: minmax(10.5rem, 13rem) minmax(0, 1fr);
    align-items: start;
    gap: 0.8rem 1rem;
    min-width: 0;
    margin-bottom: 1rem;
    padding: 0.85rem;
    background: linear-gradient(105deg, rgba(0, 240, 255, 0.055), transparent 28%), var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
  }
  .context-heading { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 0.65rem; }
  .context-heading > div { display: grid; min-width: 0; gap: 0.2rem; }
  .context-heading span { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  .context-heading i { width: 0.4rem; height: 0.4rem; background: var(--success); border-radius: 50%; box-shadow: 0 0 8px rgba(5, 255, 161, 0.5); }
  .context-heading strong { overflow: hidden; font-size: 0.78rem; text-overflow: ellipsis; white-space: nowrap; }
  .context-heading > b { display: grid; min-width: 1.7rem; height: 1.7rem; place-items: center; border: 1px solid var(--border-strong); color: var(--accent); font-family: var(--font-mono); font-size: 0.65rem; }
  .context-content { display: grid; min-width: 0; grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr) auto; align-items: center; gap: 0.8rem; }
  .context-feedback, .local-error { grid-column: 1 / -1; }
  .context-feedback:empty { display: none; }
  .capsule-picker { display: grid; width: 100%; gap: 0.35rem; }
  .capsule-picker span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.56rem; letter-spacing: 0.09em; text-transform: uppercase; }
  .capsule-picker select { width: 100%; min-height: 2.55rem; border: 1px solid var(--border-strong); padding: 0 2rem 0 0.75rem; background: #050708; color: var(--text); font-family: var(--font-mono); font-size: 0.68rem; }
  .no-capsule { display: grid; grid-column: 1 / 3; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.7rem; }
  .no-capsule p { margin: 0; color: var(--text-dim); font-size: 0.75rem; line-height: 1.5; }
  .no-capsule a { min-height: 2.4rem; white-space: nowrap; }
  .dialog-primary, .dialog-secondary, .local-error button, .frame-actions button {
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
  button:disabled { cursor: not-allowed; opacity: 0.42; }
  .local-error { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; border-left: 2px solid var(--danger); padding: 0.65rem 0.7rem; background: rgba(255, 96, 125, 0.04); color: var(--danger); font-size: 0.7rem; line-height: 1.45; }
  .local-error button { min-height: 2rem; background: transparent; box-shadow: inset 0 0 0 1px var(--danger); color: var(--danger); }
  .installed-inventory { min-width: 0; }
  .installed-inventory:empty { display: none; }
  .installed-inventory > p { margin: 0; color: var(--text-faint); font-size: 0.72rem; line-height: 1.5; }
  .installed-inventory ul { display: flex; min-width: 0; flex-wrap: wrap; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  .installed-inventory li { display: flex; min-width: min(100%, 18rem); flex: 1 1 18rem; align-items: center; justify-content: space-between; gap: 0.65rem; border: 1px solid var(--border); padding: 0.45rem 0.55rem; background: rgba(0, 0, 0, 0.24); }
  .installed-name { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.45rem; }
  .installed-mark { color: var(--success); font-family: var(--font-mono); }
  .installed-name strong { overflow: hidden; font-family: var(--font-mono); font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
  .installed-name small { color: var(--success); font-family: var(--font-mono); font-size: 0.52rem; letter-spacing: 0.06em; text-transform: uppercase; }
  .installed-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 0.35rem; }
  .installed-inventory button, .inventory-error button { min-height: 2rem; border: 1px solid var(--border-strong); padding: 0 0.6rem; background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.56rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
  .installed-inventory .remove-assistant { border-color: rgba(255, 96, 125, 0.35); color: var(--danger); }
  .inventory-error { display: grid; gap: 0.55rem; color: var(--danger); font-size: 0.7rem; line-height: 1.45; }
  .sidebar-result { display: flex; align-items: center; gap: 0.75rem; border-left: 2px solid var(--success); padding: 0.65rem 0.7rem; background: rgba(5, 255, 161, 0.045); }
  .sidebar-result.removed { border-left-color: var(--accent-alt); background: rgba(255, 61, 242, 0.04); }
  .sidebar-result span { color: var(--success); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .sidebar-result strong { font-size: 0.72rem; line-height: 1.45; }

  .store-frame {
    position: relative;
    background: #000;
    box-shadow: inset 0 0 0 1px var(--border), 0 20px 60px rgba(0, 0, 0, 0.3);
  }
  .frame-stage { position: relative; min-height: 20rem; transition: height 0.22s var(--ease); }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #000; opacity: 0; transition: opacity 0.18s ease; }
  iframe.frame-ready { opacity: 1; }
  .frame-state { position: absolute; z-index: 1; inset: 0; display: flex; min-height: 20rem; align-items: center; justify-content: center; padding: clamp(1.2rem, 4vw, 2.5rem); background: radial-gradient(circle at 50% 42%, rgba(0, 240, 255, 0.06), transparent 38%), #000; }
  .frame-loading { flex-direction: column; gap: 1rem; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .frame-loading p { margin: 0; }
  .frame-spinner { position: relative; width: 2.6rem; height: 2.6rem; border: 1px solid var(--border-strong); transform: rotate(45deg); }
  .frame-spinner::before, .frame-spinner span { position: absolute; inset: 0.45rem; border: 1px solid var(--accent); content: ''; animation: frame-spin 1.25s linear infinite; }
  .frame-spinner span { inset: 0.9rem; border-color: var(--accent-alt); animation-direction: reverse; }
  @keyframes frame-spin { to { transform: rotate(360deg); } }
  .frame-error { display: grid; max-width: none; grid-template-columns: auto minmax(0, 1fr) auto; gap: 1rem; color: var(--text); }
  .frame-error-mark { display: grid; width: 2.6rem; height: 2.6rem; place-items: center; border: 1px solid var(--danger); color: var(--danger); font-family: var(--font-mono); font-weight: 700; }
  .frame-error strong { font-family: var(--font-mono); font-size: 0.95rem; }
  .frame-error p { max-width: 52rem; margin: 0.3rem 0 0; color: var(--text-dim); font-size: 0.76rem; line-height: 1.55; }
  .frame-actions { display: flex; align-items: center; gap: 0.55rem; }
  .frame-actions button { min-height: 2.5rem; }
  .frame-actions a { white-space: nowrap; }
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
  .dialog-progress { margin: 1rem 0 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .dialog-route { display: flex; min-height: 2.8rem; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; padding: 0 0.9rem; background: var(--accent); color: #001013; font-family: var(--font-mono); font-size: 0.66rem; font-weight: 700; text-decoration: none; text-transform: uppercase; }
  .dialog-error { margin: 0.8rem 0 0; color: var(--danger); font-size: 0.78rem; line-height: 1.5; }
  .dialog-result { display: grid; gap: 0.35rem; margin-top: 1rem; border-left: 2px solid var(--success); padding: 0.85rem 1rem; background: rgba(5, 255, 161, 0.045); }
  .dialog-result span { color: var(--success); font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .dialog-result strong { font-size: 0.9rem; }
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

  @media (max-width: 980px) {
    .capsule-context { grid-template-columns: 1fr; }
    .context-heading { justify-content: flex-start; }
    .context-heading > b { margin-left: auto; }
  }
  @media (max-width: 720px) {
    .context-content { grid-template-columns: 1fr; align-items: stretch; }
    .external { width: 100%; }
    .no-capsule { grid-column: auto; grid-template-columns: 1fr auto; }
    .frame-error { grid-template-columns: auto minmax(0, 1fr); align-content: center; }
    .frame-actions { grid-column: 1 / -1; }
  }
  @media (max-width: 520px) {
    .capsule-context { padding: 0.75rem; }
    .no-capsule { grid-template-columns: 1fr; }
    .installed-actions { display: grid; }
    .installed-actions button { width: 100%; }
    .installed-inventory li, .local-error { align-items: stretch; flex-direction: column; }
    .frame-error { grid-template-columns: 1fr; text-align: center; }
    .frame-error-mark { margin: 0 auto; }
    .frame-actions { display: grid; }
    .frame-actions a, .frame-actions button { width: 100%; }
    .dialog-panel footer { align-items: stretch; flex-direction: column-reverse; }
  }
</style>
