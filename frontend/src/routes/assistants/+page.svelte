<script>
  import { onMount } from 'svelte';
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
  import { showAdminNotice } from '$lib/adminNotice.js';
  import { installAssistant, safeApiError } from '$lib/localApi.js';
  import { t, locale } from '$lib/i18n.js';
  import { refreshTeamInventory, teamContext } from '$lib/teamContext.js';

  const HELLO_ID = INSTALL_INTENT.assistant;
  const FRAME_READY_TIMEOUT_MS = 8000;
  const LOCAL_COPY = {
    en: {
      installedNow: 'Installed now',
      alreadyInstalled: 'Already installed',
      createFromSidebar: 'Close this dialog and create a Team from the sidebar.',
      confirmTitle: 'Install Hello Pulse?',
      confirmLead: 'Choose the exact Team. The Store cannot choose it or install anything for you.',
      checkingTitle: 'Preparing the local action…',
      checkingLead: 'The Admin is checking the selected Team and its installed Assistants.',
      alreadyTitle: 'Hello Pulse is already installed.',
      alreadyLead: 'Nothing was installed twice. The Assistant remains ready for your Team.',
      noTeamTitle: 'Installation needs a running Team.',
      noTeamLead: 'Your request reached this Admin, but nothing was installed because there is no local destination yet.',
      unavailableTitle: 'Hello Pulse is unavailable right now.',
      unavailableLead: 'The local catalog or installed inventory could not be verified. Retry the local data before installing.',
      successTitle: 'Hello Pulse is ready.',
      successLead: 'The Assistant was installed without running any Power or routine.',
      failureTitle: 'The local action did not finish.',
      failureLead: 'Nothing was hidden. Review the error below and retry when the local controller is available.',
      teamLabel: 'Destination Team',
      teamPlaceholder: 'Select a Team',
      cancel: 'Cancel',
      close: 'Close',
      preparing: 'Checking…',
      confirm: 'Confirm install',
      retryAction: 'Try again',
      working: 'Installing…',
      uninstall: 'Uninstall from Team',
      uninstallConfirm: 'Uninstall {assistant} from {team}?',
      removed: '{assistant} was uninstalled from {team}.',
      genericFailure: 'The local evaluation could not be completed.',
      frameLoading: 'Loading the Assistant Store…',
      frameFailureTitle: 'The Store did not finish loading.',
      frameFailureLead: 'Your local Team is unchanged. Reload the embedded Store or open the canonical page in a new tab.',
      retryStore: 'Reload Store',
      openStore: 'Open Store',
    },
    pt: {
      installedNow: 'Instalado agora',
      alreadyInstalled: 'Já estava instalado',
      createFromSidebar: 'Feche esta janela e crie um Time pela barra lateral.',
      confirmTitle: 'Instalar o Hello Pulse?',
      confirmLead: 'Escolha o Time exato. A Store não pode escolhê-lo nem instalar nada por você.',
      checkingTitle: 'Preparando a ação local…',
      checkingLead: 'O Admin está verificando o Time selecionado e seus Assistants instalados.',
      alreadyTitle: 'O Hello Pulse já está instalado.',
      alreadyLead: 'Nada foi instalado duas vezes. O Assistant continua pronto para o seu Time.',
      noTeamTitle: 'A instalação precisa de um Time em execução.',
      noTeamLead: 'Seu pedido chegou a este Admin, mas nada foi instalado porque ainda não existe um destino local.',
      unavailableTitle: 'O Hello Pulse está indisponível agora.',
      unavailableLead: 'Não foi possível verificar o catálogo local ou o inventário instalado. Atualize os dados locais antes de instalar.',
      successTitle: 'O Hello Pulse está pronto.',
      successLead: 'O Assistant foi instalado sem executar nenhuma Power ou rotina.',
      failureTitle: 'A ação local não foi concluída.',
      failureLead: 'Nada foi ocultado. Revise o erro abaixo e tente novamente quando o controller local estiver disponível.',
      teamLabel: 'Time de destino',
      teamPlaceholder: 'Selecione um Time',
      cancel: 'Cancelar',
      close: 'Fechar',
      preparing: 'Verificando…',
      confirm: 'Confirmar instalação',
      retryAction: 'Tentar novamente',
      working: 'Instalando…',
      uninstall: 'Desinstalar do Time',
      uninstallConfirm: 'Desinstalar {assistant} de {team}?',
      removed: '{assistant} foi desinstalado de {team}.',
      genericFailure: 'Não foi possível concluir a avaliação local.',
      frameLoading: 'Carregando a Store de Assistants…',
      frameFailureTitle: 'A Store não terminou de carregar.',
      frameFailureLead: 'Seu Time local não foi alterado. Recarregue a Store incorporada ou abra a página oficial em uma nova aba.',
      retryStore: 'Recarregar Store',
      openStore: 'Abrir Store',
    },
  };

  let dialogError = $state('');
  let busy = $state(false);
  let selectedTeam = $state('');
  let pendingAssistant = $state('');
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
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let helloAvailable = $derived($teamContext.catalog.some((entry) => entry.id === HELLO_ID));
  let activeTeamRecord = $derived(
    runningTeams.find((team) => team.id === $teamContext.selectedTeamId) ?? null,
  );
  let selectedTeamRecord = $derived(runningTeams.find((team) => team.id === selectedTeam) ?? null);
  let dialogTitle = $derived({
    checking: copy.checkingTitle,
    install: copy.confirmTitle,
    installed: copy.alreadyTitle,
    'no-team': copy.noTeamTitle,
    unavailable: copy.unavailableTitle,
    success: copy.successTitle,
    error: copy.failureTitle,
  }[dialogMode] ?? copy.confirmTitle);
  let dialogLead = $derived({
    checking: copy.checkingLead,
    install: copy.confirmLead,
    installed: copy.alreadyLead,
    'no-team': copy.noTeamLead,
    unavailable: copy.unavailableLead,
    success: copy.successLead,
    error: copy.failureLead,
  }[dialogMode] ?? copy.confirmLead);

  $effect(() => {
    const context = $teamContext;
    if (context.phase === 'ready') {
      publishStoreSnapshot('ready', projectReleasedStoreAssistantIds(context.installedAssistants));
    } else if (context.phase === 'error') {
      publishStoreSnapshot('error', []);
    } else {
      publishStoreSnapshot('loading', []);
    }
  });

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

  function waitForTeamContext() {
    if (!['idle', 'loading'].includes($teamContext.phase)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      unsubscribe = teamContext.subscribe((context) => {
        if (settled || ['idle', 'loading'].includes(context.phase)) return;
        settled = true;
        queueMicrotask(() => unsubscribe());
        resolve();
      });
    });
  }

  async function refreshInstalled(teamId) {
    if (!teamId || $teamContext.selectedTeamId !== teamId) {
      const status = $teamContext.phase === 'ready'
        ? 'ready'
        : $teamContext.phase === 'error'
          ? 'error'
          : 'loading';
      publishStoreSnapshot(
        status,
        status === 'ready'
          ? projectReleasedStoreAssistantIds($teamContext.installedAssistants)
          : [],
      );
      return;
    }
    try {
      await refreshTeamInventory(fetch);
      publishStoreSnapshot(
        'ready',
        projectReleasedStoreAssistantIds($teamContext.installedAssistants),
      );
    } catch {
      publishStoreSnapshot('error', []);
    }
  }

  function showInstallDialog() {
    if (confirmDialog && !confirmDialog.open) confirmDialog.showModal();
  }

  async function beginInstall(assistantId) {
    const attempt = ++dialogAttempt;
    pendingAssistant = assistantId;
    selectedTeam = activeTeamRecord?.id ?? '';
    dialogError = '';
    dialogResult = null;
    dialogMode = 'checking';
    showInstallDialog();

    if (assistantId !== HELLO_ID) {
      dialogMode = 'unavailable';
      return;
    }
    await waitForTeamContext();
    if (attempt !== dialogAttempt) return;

    const team = activeTeamRecord;
    selectedTeam = team?.id ?? '';
    if ($teamContext.phase === 'error') {
      dialogMode = 'unavailable';
      return;
    }
    if (!team) {
      dialogMode = 'no-team';
      return;
    }
    if (!helloAvailable) {
      dialogMode = 'unavailable';
      return;
    }
    dialogMode = $teamContext.installedAssistants.some((entry) => entry.assistant === HELLO_ID)
      ? 'installed'
      : 'install';
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
    const team = runningTeams.find((item) => item.id === selectedTeam);
    if (!team) return;

    busy = true;
    dialogError = '';
    dialogResult = null;
    try {
      const { installed } = await installAssistant(fetch, team.id, HELLO_ID);
      dialogResult = { note: installed ? copy.installedNow : copy.alreadyInstalled };
      dialogMode = 'success';
      await refreshInstalled(team.id);
    } catch (error) {
      const failure = error instanceof Error ? error.message : copy.genericFailure;
      await refreshInstalled(team.id);
      dialogError = failure;
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
    if (busy || !activeTeamRecord) return;
    const team = activeTeamRecord;
    const question = format(copy.uninstallConfirm, {
      assistant: assistant.assistant,
      team: team.name,
    });
    if (!window.confirm(question)) {
      publishStoreSnapshot();
      return;
    }
    busy = true;
    try {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(team.id)}/assistants/${encodeURIComponent(assistant.assistant)}`,
        { method: 'DELETE', headers: { Accept: 'application/json' } },
      );
      const body = await jsonObject(response);
      if (!response.ok) throw new Error(safeApiError(body, copy.genericFailure));
      await refreshInstalled(team.id);
      showAdminNotice({
        tone: 'success',
        label: copy.uninstall,
        message: format(copy.removed, {
          assistant: assistant.assistant,
          team: team.name,
        }),
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : copy.genericFailure;
      await refreshInstalled(team.id);
      showAdminNotice({
        tone: 'error',
        label: copy.failureTitle,
        message: failure,
      });
    } finally {
      busy = false;
    }
  }

  async function beginStoreUninstall(assistantId) {
    const installed = $teamContext.phase === 'ready'
      ? $teamContext.installedAssistants.find((entry) => entry.assistant === assistantId)
      : null;
    if (!activeTeamRecord || !installed || busy) {
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

  onMount(() => {
    window.addEventListener('message', handleStoreMessage);
    framePhase = 'loading';
    waitForStoreFrame();
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

<h1 class="sr-only">{$t('store.nav')}</h1>

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

<dialog bind:this={confirmDialog} aria-labelledby="assistant-confirm-title" oncancel={cancelInstallDialog}>
  <form class="dialog-panel" onsubmit={(event) => { event.preventDefault(); confirmInstall(); }}>
    <header>
      <p class="dialog-kicker">Assistant // local admission</p>
      <h2 id="assistant-confirm-title">{dialogTitle}</h2>
      <p>{dialogLead}</p>
    </header>
    {#if selectedTeamRecord}
      <div class="dialog-target">
        <span>{copy.teamLabel}</span>
        <strong>{selectedTeamRecord.name}</strong>
        <code>{selectedTeamRecord.id}</code>
      </div>
    {/if}
    {#if dialogMode === 'checking'}
      <p class="dialog-progress" role="status">{copy.preparing}</p>
    {:else if dialogMode === 'no-team'}
      <p class="dialog-route-hint">{copy.createFromSidebar}</p>
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
        <button type="submit" class="dialog-primary" disabled={busy || !selectedTeam || !helloAvailable}>
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

<style>
  .dialog-kicker {
    margin: 0 0 0.9rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.19em;
    text-transform: uppercase;
  }

  .frame-actions a {
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
    white-space: nowrap;
  }

  .frame-actions a:hover {
    filter: drop-shadow(0 0 9px rgba(0, 240, 255, 0.32));
  }

  .dialog-primary,
  .dialog-secondary,
  .frame-actions button {
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

  button:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

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
  .dialog-route-hint { margin: 1rem 0 0; border-inline-start: 2px solid var(--accent); padding: 0.7rem 0.85rem; color: var(--text-dim); font-size: 0.72rem; line-height: 1.5; }
  .dialog-error { margin: 0.8rem 0 0; color: var(--danger); font-size: 0.78rem; line-height: 1.5; }
  .dialog-result { display: grid; gap: 0.35rem; margin-top: 1rem; border-left: 2px solid var(--success); padding: 0.85rem 1rem; background: rgba(5, 255, 161, 0.045); }
  .dialog-result span { color: var(--success); font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .dialog-result strong { font-size: 0.9rem; }
  .dialog-panel footer { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; }
  .dialog-secondary { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-dim); }

  @media (max-width: 720px) {
    .frame-error { grid-template-columns: auto minmax(0, 1fr); align-content: center; }
    .frame-actions { grid-column: 1 / -1; }
  }
  @media (max-width: 520px) {
    .frame-error { grid-template-columns: 1fr; text-align: center; }
    .frame-error-mark { margin: 0 auto; }
    .frame-actions { display: grid; }
    .frame-actions a, .frame-actions button { width: 100%; }
    .dialog-panel footer { align-items: stretch; flex-direction: column-reverse; }
  }
</style>
