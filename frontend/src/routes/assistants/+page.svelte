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
  import AssistantActionDialog from '$lib/AssistantActionDialog.svelte';
  import { installAssistant, safeApiError } from '$lib/localApi.js';
  import { t, locale } from '$lib/i18n.js';
  import { refreshTeamInventory, teamContext } from '$lib/teamContext.js';

  const OFFICIAL_ASSISTANT_ID = INSTALL_INTENT.assistant;
  const FRAME_READY_TIMEOUT_MS = 8000;
  const LOCAL_COPY = {
    en: {
      createFromSidebar: 'Close this dialog and create a Team from the sidebar.',
      confirmTitle: 'Install Shimpz Assistant?',
      confirmLead: 'Choose the exact Team. The Store cannot choose it or install anything for you.',
      checkingTitle: 'Preparing the local action…',
      checkingLead: 'The Admin is checking the selected Team and its installed Assistants.',
      alreadyTitle: 'Shimpz Assistant is already installed.',
      alreadyLead: 'Nothing was installed twice. The Assistant remains ready for your Team.',
      noTeamTitle: 'Installation needs a running Team.',
      noTeamLead: 'Your request reached this Admin, but nothing was installed because there is no local destination yet.',
      unavailableTitle: 'Shimpz Assistant is unavailable right now.',
      unavailableLead: 'The local catalog or installed inventory could not be verified. Retry the local data before installing.',
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
      genericFailure: 'The local evaluation could not be completed.',
      frameLoading: 'Loading the Assistant Store…',
      frameFailureTitle: 'The Store did not finish loading.',
      frameFailureLead: 'Your local Team is unchanged. Reload the embedded Store or open the canonical page in a new tab.',
      retryStore: 'Reload Store',
      openStore: 'Open Store',
    },
    pt: {
      createFromSidebar: 'Feche esta janela e crie um Time pela barra lateral.',
      confirmTitle: 'Instalar o Shimpz Assistant?',
      confirmLead: 'Escolha o Time exato. A Store não pode escolhê-lo nem instalar nada por você.',
      checkingTitle: 'Preparando a ação local…',
      checkingLead: 'O Admin está verificando o Time selecionado e seus Assistants instalados.',
      alreadyTitle: 'O Shimpz Assistant já está instalado.',
      alreadyLead: 'Nada foi instalado duas vezes. O Assistant continua pronto para o seu Time.',
      noTeamTitle: 'A instalação precisa de um Time em execução.',
      noTeamLead: 'Seu pedido chegou a este Admin, mas nada foi instalado porque ainda não existe um destino local.',
      unavailableTitle: 'O Shimpz Assistant está indisponível agora.',
      unavailableLead: 'Não foi possível verificar o catálogo local ou o inventário instalado. Atualize os dados locais antes de instalar.',
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
  let dialogOpen = $state(false);
  let dialogAction = $state('install');
  let dialogMode = $state('install');
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
  let officialAssistantAvailable = $derived(
    $teamContext.catalog.some((entry) => entry.id === OFFICIAL_ASSISTANT_ID),
  );
  let activeTeamRecord = $derived(
    runningTeams.find((team) => team.id === $teamContext.selectedTeamId) ?? null,
  );
  let selectedTeamRecord = $derived(runningTeams.find((team) => team.id === selectedTeam) ?? null);
  let pendingAssistantName = $derived(
    $teamContext.catalog.find((entry) => entry.id === pendingAssistant)?.name ?? pendingAssistant,
  );
  let dialogTitle = $derived(
    dialogAction === 'uninstall'
      ? dialogMode === 'error'
        ? $t('store.assistantUninstallFailureTitle')
        : $t('store.assistantUninstallTitle', { assistant: pendingAssistantName })
      : ({
          checking: copy.checkingTitle,
          install: copy.confirmTitle,
          installed: copy.alreadyTitle,
          'no-team': copy.noTeamTitle,
          unavailable: copy.unavailableTitle,
          error: copy.failureTitle,
        }[dialogMode] ?? copy.confirmTitle),
  );
  let dialogLead = $derived(
    dialogAction === 'uninstall'
      ? dialogMode === 'error'
        ? $t('store.assistantUninstallFailureLead')
        : $t('store.assistantUninstallLead', {
            assistant: pendingAssistantName,
            team: selectedTeamRecord?.name ?? '',
          })
      : ({
          checking: copy.checkingLead,
          install: copy.confirmLead,
          installed: copy.alreadyLead,
          'no-team': copy.noTeamLead,
          unavailable: copy.unavailableLead,
          error: copy.failureLead,
        }[dialogMode] ?? copy.confirmLead),
  );
  let dialogPrimaryVisible = $derived(
    dialogAction === 'uninstall'
      ? ['uninstall', 'error'].includes(dialogMode)
      : ['install', 'error'].includes(dialogMode),
  );
  let dialogPrimaryLabel = $derived(
    busy
      ? dialogAction === 'uninstall'
        ? $t('store.assistantUninstalling')
        : copy.working
      : dialogMode === 'error'
        ? dialogAction === 'uninstall'
          ? $t('store.assistantActionRetry')
          : copy.retryAction
        : dialogAction === 'uninstall'
          ? $t('store.assistantUninstallConfirm')
          : copy.confirm,
  );
  let dialogSecondaryLabel = $derived(
    ['install', 'uninstall'].includes(dialogMode)
      ? dialogAction === 'uninstall'
        ? $t('store.assistantActionCancel')
        : copy.cancel
      : $t('integration.close'),
  );

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

  function showAssistantDialog() {
    dialogOpen = true;
  }

  async function beginInstall(assistantId) {
    const attempt = ++dialogAttempt;
    dialogAction = 'install';
    pendingAssistant = assistantId;
    selectedTeam = activeTeamRecord?.id ?? '';
    dialogError = '';
    dialogMode = 'checking';
    showAssistantDialog();

    if (assistantId !== OFFICIAL_ASSISTANT_ID) {
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
    if (!officialAssistantAvailable) {
      dialogMode = 'unavailable';
      return;
    }
    dialogMode = $teamContext.installedAssistants.some(
      (entry) => entry.assistant === OFFICIAL_ASSISTANT_ID,
    )
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
      pendingAssistant !== OFFICIAL_ASSISTANT_ID ||
      !officialAssistantAvailable ||
      !['install', 'error'].includes(dialogMode)
    ) return;
    const team = runningTeams.find((item) => item.id === selectedTeam);
    if (!team) return;

    busy = true;
    dialogError = '';
    try {
      await installAssistant(fetch, team.id, OFFICIAL_ASSISTANT_ID);
      await refreshInstalled(team.id);
      const assistantName = pendingAssistantName;
      finishAssistantDialog();
      showAdminNotice({
        tone: 'success',
        label: $t('store.assistantInstalledLabel'),
        message: $t('store.assistantInstalledMessage', {
          assistant: assistantName,
          team: team.name,
        }),
      });
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
      if (dialogOpen) {
        dialogMode = 'error';
      } else {
        storeActionLatch.release('install');
      }
      publishStoreSnapshot();
    }
  }

  function finishAssistantDialog() {
    dialogAttempt += 1;
    const action = dialogAction;
    dialogOpen = false;
    storeActionLatch.release(action);
    publishStoreSnapshot();
  }

  function closeAssistantDialog() {
    if (busy) return;
    finishAssistantDialog();
  }

  function cancelAssistantDialog() {
    closeAssistantDialog();
  }

  async function confirmUninstall() {
    if (busy || !selectedTeamRecord || dialogAction !== 'uninstall') return;
    const team = selectedTeamRecord;
    const assistantId = pendingAssistant;
    const assistantName = pendingAssistantName;
    busy = true;
    dialogError = '';
    try {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(team.id)}/assistants/${encodeURIComponent(assistantId)}`,
        { method: 'DELETE', headers: { Accept: 'application/json' } },
      );
      const body = await jsonObject(response);
      if (!response.ok) throw new Error(safeApiError(body, copy.genericFailure));
      await refreshInstalled(team.id);
      finishAssistantDialog();
      showAdminNotice({
        tone: 'success',
        label: $t('store.assistantUninstalledLabel'),
        message: $t('store.assistantUninstalledMessage', {
          assistant: assistantName,
          team: team.name,
        }),
      });
    } catch (error) {
      const failure = error instanceof Error ? error.message : copy.genericFailure;
      await refreshInstalled(team.id);
      dialogError = failure;
      dialogMode = 'error';
    } finally {
      busy = false;
    }
  }

  function confirmAssistantAction() {
    if (dialogAction === 'uninstall') {
      void confirmUninstall();
      return;
    }
    void confirmInstall();
  }

  function beginStoreUninstall(assistantId) {
    const installed = $teamContext.phase === 'ready'
      ? $teamContext.installedAssistants.find((entry) => entry.assistant === assistantId)
      : null;
    if (!activeTeamRecord || !installed || busy) {
      storeActionLatch.release('uninstall');
      publishStoreSnapshot();
      return;
    }
    dialogAction = 'uninstall';
    pendingAssistant = installed.assistant;
    selectedTeam = activeTeamRecord.id;
    dialogError = '';
    dialogMode = 'uninstall';
    showAssistantDialog();
  }

  function runStoreUninstall(assistantId) {
    try {
      beginStoreUninstall(assistantId);
    } catch (error) {
      dialogError = error instanceof Error ? error.message : copy.genericFailure;
      if (dialogOpen) {
        dialogMode = 'error';
      } else {
        storeActionLatch.release('uninstall');
      }
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

{#if activeTeamRecord}
  <header class="store-destination" aria-labelledby="store-destination-team">
    <p>{$t('store.destinationKicker')}</p>
    <h2 id="store-destination-team">{activeTeamRecord.name}</h2>
    <span>{$t('store.destinationLead', { team: activeTeamRecord.name })}</span>
  </header>
{/if}

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

<AssistantActionDialog
  bind:open={dialogOpen}
  title={dialogTitle}
  lead={dialogLead}
  targetLabel={dialogAction === 'uninstall' ? $t('store.assistantDestinationTeam') : copy.teamLabel}
  targetName={selectedTeamRecord?.name ?? ''}
  targetId={selectedTeamRecord?.id ?? ''}
  progress={dialogMode === 'checking' ? copy.preparing : ''}
  hint={dialogMode === 'no-team' ? copy.createFromSidebar : ''}
  error={dialogError}
  primaryLabel={dialogPrimaryLabel}
  secondaryLabel={dialogSecondaryLabel}
  primaryVisible={dialogPrimaryVisible}
  primaryDisabled={!selectedTeamRecord || !officialAssistantAvailable}
  {busy}
  destructive={dialogAction === 'uninstall'}
  onconfirm={confirmAssistantAction}
  oncancel={cancelAssistantDialog} />

<style>
  .store-destination {
    position: relative;
    display: grid;
    gap: 0.35rem;
    margin: 0 0 1rem;
    padding-block: 0.25rem;
    padding-inline: 1rem 0;
  }

  .store-destination::before {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: 2px;
    background: linear-gradient(var(--accent), var(--accent-alt));
    box-shadow: 0 0 12px rgba(0, 240, 255, 0.28);
    content: '';
  }

  .store-destination p,
  .store-destination h2,
  .store-destination span {
    margin: 0;
  }

  .store-destination p {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .store-destination h2 {
    overflow-wrap: anywhere;
    font-size: clamp(1.35rem, 3vw, 2rem);
    letter-spacing: -0.04em;
  }

  .store-destination span {
    color: var(--text-dim);
    font-size: 0.76rem;
    line-height: 1.55;
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

  @media (max-width: 720px) {
    .frame-error { grid-template-columns: auto minmax(0, 1fr); align-content: center; }
    .frame-actions { grid-column: 1 / -1; }
  }
  @media (max-width: 520px) {
    .frame-error { grid-template-columns: 1fr; text-align: center; }
    .frame-error-mark { margin: 0 auto; }
    .frame-actions { display: grid; }
    .frame-actions a, .frame-actions button { width: 100%; }
  }
</style>
