<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import {
    RELEASED_STORE_ASSISTANT_IDS,
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
  import { createTeam, refreshTeamInventory, teamContext } from '$lib/teamContext.js';

  const FRAME_READY_TIMEOUT_MS = 8000;
  const DESTINATION_COPY = {
    en: {
      change: 'Change Team', chooseTitle: 'Choose a destination Team',
      chooseLead: 'Every Assistant installed from this Store goes only to the Team selected here.',
      current: 'Current', empty: 'Create a Team to give new Assistants a private destination.',
      switchFailed: 'The destination Team could not be changed.', createFailed: 'The Team could not be created.',
    },
    pt: {
      change: 'Trocar Time', chooseTitle: 'Escolha o Time de destino',
      chooseLead: 'Cada Assistant instalado nesta Store vai somente para o Time selecionado aqui.',
      current: 'Atual', empty: 'Crie um Time para dar aos novos Assistants um destino privado.',
      switchFailed: 'Não foi possível trocar o Time de destino.', createFailed: 'Não foi possível criar o Time.',
    },
    es: {
      change: 'Cambiar Equipo', chooseTitle: 'Elige el Equipo de destino',
      chooseLead: 'Cada Assistant instalado desde esta Store irá únicamente al Equipo seleccionado aquí.',
      current: 'Actual', empty: 'Crea un Equipo para dar a los nuevos Assistants un destino privado.',
      switchFailed: 'No se pudo cambiar el Equipo de destino.', createFailed: 'No se pudo crear el Equipo.',
    },
    zh: {
      change: '切换团队', chooseTitle: '选择目标团队',
      chooseLead: '从此 Store 安装的每个 Assistant 只会进入此处选择的团队。',
      current: '当前', empty: '创建一个团队，为新的 Assistants 提供私有目标。',
      switchFailed: '无法切换目标团队。', createFailed: '无法创建团队。',
    },
    fr: {
      change: 'Changer d’Équipe', chooseTitle: 'Choisir l’Équipe de destination',
      chooseLead: 'Chaque Assistant installé depuis ce Store rejoint uniquement l’Équipe sélectionnée ici.',
      current: 'Actuelle', empty: 'Créez une Équipe pour offrir une destination privée aux nouveaux Assistants.',
      switchFailed: 'Impossible de changer l’Équipe de destination.', createFailed: 'Impossible de créer l’Équipe.',
    },
    de: {
      change: 'Team wechseln', chooseTitle: 'Ziel-Team auswählen',
      chooseLead: 'Jeder Assistant aus diesem Store wird nur im hier ausgewählten Team installiert.',
      current: 'Aktuell', empty: 'Erstelle ein Team als privates Ziel für neue Assistants.',
      switchFailed: 'Das Ziel-Team konnte nicht gewechselt werden.', createFailed: 'Das Team konnte nicht erstellt werden.',
    },
    ja: {
      change: 'チームを変更', chooseTitle: 'インストール先チームを選択',
      chooseLead: 'この Store からインストールした Assistant は、ここで選択したチームだけに追加されます。',
      current: '現在', empty: '新しい Assistants の非公開のインストール先となるチームを作成してください。',
      switchFailed: 'インストール先チームを変更できませんでした。', createFailed: 'チームを作成できませんでした。',
    },
    ar: {
      change: 'تغيير الفريق', chooseTitle: 'اختر فريق الوجهة',
      chooseLead: 'يُثبَّت كل Assistant من هذا المتجر في الفريق المحدد هنا فقط.',
      current: 'الحالي', empty: 'أنشئ فريقًا ليكون وجهة خاصة للـ Assistants الجدد.',
      switchFailed: 'تعذر تغيير فريق الوجهة.', createFailed: 'تعذر إنشاء الفريق.',
    },
  };
  const LOCAL_COPY = {
    en: {
      createFromSidebar: 'Close this dialog and create a Team from the Store destination.',
      confirmTitle: 'Install this Assistant?',
      confirmLead: 'Choose the exact Team. The Store cannot choose it or install anything for you.',
      checkingTitle: 'Preparing the local action…',
      checkingLead: 'The Admin is checking the selected Team and its installed Assistants.',
      alreadyTitle: 'This Assistant is already installed.',
      alreadyLead: 'Nothing was installed twice. The Assistant remains ready for your Team.',
      noTeamTitle: 'Installation needs a running Team.',
      noTeamLead: 'Your request reached this Admin, but nothing was installed because there is no local destination yet.',
      unavailableTitle: 'This Assistant is unavailable right now.',
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
      createFromSidebar: 'Feche esta janela e crie um Time no destino da Store.',
      confirmTitle: 'Instalar este Assistant?',
      confirmLead: 'Escolha o Time exato. A Store não pode escolhê-lo nem instalar nada por você.',
      checkingTitle: 'Preparando a ação local…',
      checkingLead: 'O Admin está verificando o Time selecionado e seus Assistants instalados.',
      alreadyTitle: 'Este Assistant já está instalado.',
      alreadyLead: 'Nada foi instalado duas vezes. O Assistant continua pronto para o seu Time.',
      noTeamTitle: 'A instalação precisa de um Time em execução.',
      noTeamLead: 'Seu pedido chegou a este Admin, mas nada foi instalado porque ainda não existe um destino local.',
      unavailableTitle: 'Este Assistant está indisponível agora.',
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
  let destinationDialog = $state();
  let destinationTrigger = $state();
  let createTeamDialog = $state();
  let destinationBusy = $state(false);
  let destinationError = $state('');
  let newTeamName = $state('');
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
  let destinationCopy = $derived(DESTINATION_COPY[currentLocale] ?? DESTINATION_COPY.en);
  let storeLocale = $derived(currentLocale === 'pt' ? 'pt' : 'en');
  let storePageUrl = $derived(`https://shimpz.com/${storeLocale}/assistants`);
  let storeUrl = $derived(
    `${storePageUrl}/embed?store-protocol=${STORE_LIFECYCLE_PROTOCOL_VERSION}&admin-frame=${frameReload}`,
  );
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let pendingAssistantAvailable = $derived(
    RELEASED_STORE_ASSISTANT_IDS.includes(pendingAssistant) &&
      $teamContext.catalog.some((entry) => entry.id === pendingAssistant),
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

  function openDestinationDialog() {
    if (destinationBusy || $teamContext.phase === 'loading') return;
    destinationError = '';
    if (!destinationDialog?.open) destinationDialog?.showModal();
  }

  function focusDestinationTrigger() {
    queueMicrotask(() => destinationTrigger?.focus());
  }

  function closeDestinationDialog() {
    if (destinationBusy) return;
    destinationDialog?.close();
    focusDestinationTrigger();
  }

  function cancelDestinationDialog(event) {
    event.preventDefault();
    closeDestinationDialog();
  }

  function destinationUrl(teamId) {
    const next = new URL(page.url);
    next.searchParams.set('team', teamId);
    return next;
  }

  async function chooseDestinationTeam(teamId) {
    if (destinationBusy || !runningTeams.some((team) => team.id === teamId)) return;
    if (teamId === activeTeamRecord?.id) {
      closeDestinationDialog();
      return;
    }
    destinationBusy = true;
    destinationError = '';
    try {
      await goto(destinationUrl(teamId), { replaceState: true, keepFocus: true, noScroll: true });
      destinationDialog?.close();
      focusDestinationTrigger();
    } catch {
      destinationError = destinationCopy.switchFailed;
    } finally {
      destinationBusy = false;
    }
  }

  function openCreateTeamDialog() {
    if (destinationBusy) return;
    destinationDialog?.close();
    newTeamName = '';
    destinationError = '';
    queueMicrotask(() => createTeamDialog?.showModal());
  }

  function closeCreateTeamDialog() {
    if (destinationBusy) return;
    createTeamDialog?.close();
    focusDestinationTrigger();
  }

  function cancelCreateTeamDialog(event) {
    event.preventDefault();
    closeCreateTeamDialog();
  }

  async function submitDestinationTeam(event) {
    event.preventDefault();
    if (destinationBusy || !newTeamName.trim()) return;
    destinationBusy = true;
    destinationError = '';
    try {
      const created = await createTeam(fetch, newTeamName);
      await goto(destinationUrl(created.id), { replaceState: true, keepFocus: true, noScroll: true });
      createTeamDialog?.close();
      focusDestinationTrigger();
    } catch {
      destinationError = destinationCopy.createFailed;
    } finally {
      destinationBusy = false;
    }
  }

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

    if (!RELEASED_STORE_ASSISTANT_IDS.includes(assistantId)) {
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
    if (!$teamContext.catalog.some((entry) => entry.id === assistantId)) {
      dialogMode = 'unavailable';
      return;
    }
    dialogMode = $teamContext.installedAssistants.some(
      (entry) => entry.assistant === assistantId,
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
      !RELEASED_STORE_ASSISTANT_IDS.includes(pendingAssistant) ||
      !pendingAssistantAvailable ||
      !['install', 'error'].includes(dialogMode)
    ) return;
    const team = runningTeams.find((item) => item.id === selectedTeam);
    if (!team) return;

    busy = true;
    dialogError = '';
    try {
      await installAssistant(fetch, team.id, pendingAssistant);
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

<header class="store-destination" aria-labelledby="store-destination-team">
  <p>{$t('store.destinationKicker')}</p>
  <h2 id="store-destination-team">
    <button
      bind:this={destinationTrigger}
      class="destination-trigger"
      type="button"
      onclick={openDestinationDialog}
      disabled={destinationBusy || $teamContext.phase === 'loading'}
      aria-haspopup="dialog"
      aria-controls="store-team-destination-dialog"
    >
      <span>{activeTeamRecord?.name ?? destinationCopy.chooseTitle}</span>
      <small>{destinationCopy.change}<b aria-hidden="true">↘</b></small>
    </button>
  </h2>
  <span>
    {activeTeamRecord
      ? $t('store.destinationLead', { team: activeTeamRecord.name })
      : destinationCopy.empty}
  </span>
</header>

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

<dialog
  id="store-team-destination-dialog"
  class="destination-dialog"
  bind:this={destinationDialog}
  aria-labelledby="store-team-destination-title"
  oncancel={cancelDestinationDialog}
>
  <div class="destination-dialog-panel">
    <header>
      <p>{$t('store.destinationKicker')}</p>
      <h2 id="store-team-destination-title">{destinationCopy.chooseTitle}</h2>
      <span>{destinationCopy.chooseLead}</span>
    </header>

    {#if runningTeams.length > 0}
      <ul class="destination-team-list">
        {#each runningTeams as team (team.id)}
          <li>
            <button
              type="button"
              onclick={() => chooseDestinationTeam(team.id)}
              disabled={destinationBusy}
              aria-current={team.id === activeTeamRecord?.id ? 'true' : undefined}
            >
              <i aria-hidden="true"></i>
              <span><strong>{team.name}</strong><small>{team.id}</small></span>
              {#if team.id === activeTeamRecord?.id}<b>{destinationCopy.current}</b>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="destination-empty">{destinationCopy.empty}</p>
    {/if}

    {#if destinationError}<p class="destination-error" role="alert">{destinationError}</p>{/if}

    <footer>
      <button class="dialog-secondary" type="button" onclick={closeDestinationDialog} disabled={destinationBusy}>
        {$t('integration.close')}
      </button>
      <button class="dialog-primary" type="button" onclick={openCreateTeamDialog} disabled={destinationBusy}>
        {$t('teams.create')}
      </button>
    </footer>
  </div>
</dialog>

<dialog
  class="destination-dialog"
  bind:this={createTeamDialog}
  aria-labelledby="store-create-team-title"
  oncancel={cancelCreateTeamDialog}
>
  <form class="destination-dialog-panel" onsubmit={submitDestinationTeam}>
    <header>
      <p>{$t('store.destinationKicker')}</p>
      <h2 id="store-create-team-title">{$t('teams.createTitle')}</h2>
      <span>{$t('teams.createLead')}</span>
    </header>

    <label class="destination-field" for="store-create-team-name">
      <span>{$t('teams.name')}</span>
      <input
        id="store-create-team-name"
        type="text"
        bind:value={newTeamName}
        placeholder={$t('teams.placeholder')}
        maxlength="80"
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        required
        disabled={destinationBusy}
      />
    </label>

    {#if destinationError}<p class="destination-error" role="alert">{destinationError}</p>{/if}

    <footer>
      <button class="dialog-secondary" type="button" onclick={closeCreateTeamDialog} disabled={destinationBusy}>
        {$t('teams.cancel')}
      </button>
      <button class="dialog-primary" type="submit" disabled={destinationBusy || !newTeamName.trim()}>
        {destinationBusy ? $t('teams.creating') : $t('teams.createAction')}
      </button>
    </footer>
  </form>
</dialog>

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
  primaryDisabled={!selectedTeamRecord || !pendingAssistantAvailable}
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
    min-width: 0;
  }

  .store-destination span {
    color: var(--text-dim);
    font-size: 0.76rem;
    line-height: 1.55;
  }

  .destination-trigger {
    display: inline-grid;
    max-width: 100%;
    grid-template-columns: minmax(0, auto) auto;
    align-items: baseline;
    gap: clamp(0.75rem, 2vw, 1.5rem);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }

  .destination-trigger > span {
    overflow-wrap: anywhere;
    color: inherit;
    font-family: var(--font-display);
    font-size: clamp(1.35rem, 3vw, 2rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.1;
  }

  .destination-trigger small {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.52rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .destination-trigger small b { font-size: 0.75rem; }
  .destination-trigger:hover > span { color: var(--accent); }
  .destination-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 0.35rem; }
  .destination-trigger:disabled { cursor: wait; opacity: 0.55; }

  .destination-dialog {
    width: min(34rem, calc(100dvw - 1rem));
    max-height: calc(100dvh - 2rem);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  .destination-dialog::backdrop {
    background: rgba(0, 0, 0, 0.84);
    backdrop-filter: blur(8px);
  }

  .destination-dialog-panel {
    --dialog-pad: clamp(1.25rem, 4vw, 2rem);
    display: grid;
    max-height: calc(100dvh - 2rem);
    gap: 1.1rem;
    padding: var(--dialog-pad);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    overflow: auto;
  }

  .destination-dialog-panel > header { display: grid; gap: 0.45rem; }
  .destination-dialog-panel > header p { margin: 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
  .destination-dialog-panel > header h2 { margin: 0; font-size: clamp(1.4rem, 4vw, 2.1rem); letter-spacing: -0.05em; }
  .destination-dialog-panel > header span { color: var(--text-dim); font-size: 0.74rem; line-height: 1.55; }

  .destination-team-list {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 1px;
    background: var(--border-strong);
    list-style: none;
  }

  .destination-team-list li { min-width: 0; }
  .destination-team-list button {
    display: grid;
    width: 100%;
    min-height: 3.7rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.8rem;
    border: 0;
    padding: 0.65rem 0.8rem;
    background: #050708;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }

  .destination-team-list button:hover,
  .destination-team-list button[aria-current='true'] { background: rgba(0, 240, 255, 0.065); }
  .destination-team-list button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
  .destination-team-list button:disabled { cursor: wait; opacity: 0.55; }
  .destination-team-list i { width: 0.48rem; height: 0.48rem; border: 1px solid var(--accent); transform: rotate(45deg); }
  .destination-team-list button[aria-current='true'] i { background: var(--accent); box-shadow: 0 0 10px rgba(0, 240, 255, 0.55); }
  .destination-team-list span { display: grid; min-width: 0; gap: 0.15rem; }
  .destination-team-list strong { overflow: hidden; font-family: var(--font-mono); font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }
  .destination-team-list small { overflow: hidden; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.53rem; text-overflow: ellipsis; white-space: nowrap; }
  .destination-team-list b { color: var(--accent); font-family: var(--font-mono); font-size: 0.52rem; letter-spacing: 0.08em; text-transform: uppercase; }

  .destination-empty,
  .destination-error { margin: 0; font-size: 0.7rem; line-height: 1.5; }
  .destination-empty { color: var(--text-dim); }
  .destination-error { color: var(--danger); }

  .destination-dialog-panel footer {
    display: flex;
    gap: 0;
    margin: 0 calc(0px - var(--dialog-pad)) calc(0px - var(--dialog-pad));
  }

  .destination-dialog-panel footer button {
    min-height: 2.7rem;
    width: 100%;
    flex: 1 1 0;
    border: 1px solid var(--border-strong);
    padding: 0 1rem;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  .destination-dialog-panel footer button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .destination-dialog-panel footer button + button { box-shadow: inset 1px 0 0 var(--border-strong); }
  .destination-dialog-panel footer button:disabled { cursor: wait; opacity: 0.45; }
  .dialog-secondary { background: transparent; color: var(--text-dim); }
  .dialog-primary { border-color: var(--accent) !important; background: var(--accent); color: #001013; }

  .destination-field { display: grid; gap: 0.4rem; }
  .destination-field > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.56rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .destination-field input { width: 100%; min-height: 3.2rem; border: 1px solid var(--border-strong); padding: 0 0.85rem; background: #020304; color: var(--text); font-family: var(--font-mono); }

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
