<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { ActionLink, Button, ChoiceItem, DialogFrame, EmbedFrame, Modal, Notice, TextField } from '@shimpz/frontend';
  import {
    STORE_FRAME_MAX_HEIGHT,
    STORE_FRAME_MIN_HEIGHT,
    STORE_LIFECYCLE_PROTOCOL_VERSION,
    acknowledgeStoreFrame,
    acknowledgeStoreInstallIntent,
    acknowledgeStoreUninstallIntent,
    createStoreActionLatch,
    postStoreAssistantState,
    projectInstalledAssistantIds,
  } from '$lib/assistantIntent.js';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import AssistantActionDialog from '$lib/AssistantActionDialog.svelte';
  import { installAssistant, safeApiError } from '$lib/localApi.js';
  import { t, locale } from '$lib/i18n.js';
  import { createTeam, refreshTeamInventory, teamContext } from '$lib/teamContext.js';
  import { jsonObject } from '$lib/validate.js';

  const FRAME_READY_TIMEOUT_MS = 8000;

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
  let pendingSourceDigest = $state('');
  let iframeElement = $state();
  let dialogOpen = $state(false);
  let dialogAction = $state('install');
  let dialogMode = $state('install');
  let dialogAttempt = 0;
  let framePhase = $state('loading');
  let frameHeight = $state(420);
  let frameReload = $state(0);
  let frameTimeout;
  let frameMounted = false;
  let activeStoreUrl = '';
  let storeSnapshotStatus = 'loading';
  let storeSnapshotInstalled = [];
  const storeActionLatch = createStoreActionLatch();

  let currentLocale = $derived($locale);
  let copy = $derived($t('assistantStore'));
  let destinationCopy = $derived($t('assistantDestination'));
  let storeLocale = $derived(currentLocale === 'pt' ? 'pt' : 'en');
  let storePageUrl = $derived(`https://shimpz.com/${storeLocale}/assistants`);
  let storeUrl = $derived(
    `${storePageUrl}/embed?store-protocol=${STORE_LIFECYCLE_PROTOCOL_VERSION}&admin-frame=${frameReload}`,
  );
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let pendingAssistantAvailable = $derived(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pendingAssistant) &&
      /^sha256:[0-9a-f]{64}$/.test(pendingSourceDigest),
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
      publishStoreSnapshot('ready', projectInstalledAssistantIds(context.installedAssistants));
    } else if (context.phase === 'error') {
      publishStoreSnapshot('error', []);
    } else {
      publishStoreSnapshot('loading', []);
    }
  });

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
          ? projectInstalledAssistantIds($teamContext.installedAssistants)
          : [],
      );
      return;
    }
    try {
      await refreshTeamInventory(fetch);
      publishStoreSnapshot(
        'ready',
        projectInstalledAssistantIds($teamContext.installedAssistants),
      );
    } catch {
      publishStoreSnapshot('error', []);
    }
  }

  function showAssistantDialog() {
    dialogOpen = true;
  }

  async function beginInstall(assistantId, sourceDigest) {
    const attempt = ++dialogAttempt;
    dialogAction = 'install';
    pendingAssistant = assistantId;
    pendingSourceDigest = sourceDigest;
    selectedTeam = activeTeamRecord?.id ?? '';
    dialogError = '';
    dialogMode = 'checking';
    showAssistantDialog();

    if (!pendingAssistantAvailable) {
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

  $effect(() => {
    const nextStoreUrl = storeUrl;
    if (!frameMounted || nextStoreUrl === activeStoreUrl) return;
    activeStoreUrl = nextStoreUrl;
    framePhase = 'loading';
    frameHeight = 420;
    waitForStoreFrame();
  });

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
      void runStoreInstall(event.data.assistant, event.data.source_digest);
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
      !pendingAssistantAvailable ||
      !['install', 'error'].includes(dialogMode)
    ) return;
    const team = runningTeams.find((item) => item.id === selectedTeam);
    if (!team) return;

    busy = true;
    dialogError = '';
    try {
      await installAssistant(fetch, team.id, pendingAssistant, pendingSourceDigest);
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

  async function runStoreInstall(assistantId, sourceDigest) {
    try {
      await beginInstall(assistantId, sourceDigest);
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
    frameMounted = true;
    activeStoreUrl = storeUrl;
    window.addEventListener('message', handleStoreMessage);
    framePhase = 'loading';
    waitForStoreFrame();
    return () => {
      frameMounted = false;
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
    <Button
      bind:element={destinationTrigger}
      variant="ghost"
      class="destination-trigger"
      type="button"
      onclick={openDestinationDialog}
      disabled={destinationBusy || $teamContext.phase === 'loading'}
      aria-haspopup="dialog"
      aria-controls="store-team-destination-dialog"
    >
      <strong class="destination-name">{activeTeamRecord?.name ?? destinationCopy.chooseTitle}</strong>
      <small class="destination-change">{destinationCopy.change}<b aria-hidden="true">↘</b></small>
    </Button>
  </h2>
  <span>
    {activeTeamRecord
      ? $t('store.destinationLead', { team: activeTeamRecord.name })
      : destinationCopy.empty}
  </span>
</header>

<section class="store-frame" aria-label={$t('store.frameTitle')} aria-busy={framePhase === 'loading'}>
      <div class="frame-stage" style={`height:${frameHeight}px`}>
        <EmbedFrame
          bind:element={iframeElement}
          src={storeUrl}
          title={$t('store.frameTitle')}
          class={framePhase === 'ready' ? 'frame-ready' : undefined}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          onload={storeFrameLoaded}
        />
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
              <Button variant="secondary" type="button" onclick={reloadStoreFrame}>{copy.retryStore}</Button>
              <ActionLink href={storePageUrl} target="_blank" rel="noopener noreferrer">{copy.openStore}<span aria-hidden="true">↗</span></ActionLink>
            </div>
          </div>
        {/if}
      </div>
</section>

<p class="trust-boundary"><span aria-hidden="true">◇</span>{$t('store.boundary')}</p>

<Modal
  id="store-team-destination-dialog"
  class="destination-dialog"
  bind:element={destinationDialog}
  labelledBy="store-team-destination-title"
  oncancel={cancelDestinationDialog}
>
  <DialogFrame
    kicker={$t('store.destinationKicker')}
    title={destinationCopy.chooseTitle}
    titleId="store-team-destination-title"
    lead={destinationCopy.chooseLead}
  >
    {#if runningTeams.length > 0}
      <ul class="destination-team-list">
        {#each runningTeams as team (team.id)}
          <li>
            <ChoiceItem
              title={team.name}
              description={team.id}
              meta={team.id === activeTeamRecord?.id ? destinationCopy.current : undefined}
              selected={team.id === activeTeamRecord?.id}
              onclick={() => chooseDestinationTeam(team.id)}
              disabled={destinationBusy}
            />
          </li>
        {/each}
      </ul>
    {:else}
      <p class="destination-empty">{destinationCopy.empty}</p>
    {/if}

    {#if destinationError}<Notice variant="error">{destinationError}</Notice>{/if}

    {#snippet footer()}
      <Button variant="secondary" type="button" onclick={closeDestinationDialog} disabled={destinationBusy}>
        {$t('integration.close')}
      </Button>
      <Button type="button" onclick={openCreateTeamDialog} disabled={destinationBusy}>
        {$t('teams.create')}
      </Button>
    {/snippet}
  </DialogFrame>
</Modal>

<Modal
  class="destination-dialog"
  bind:element={createTeamDialog}
  labelledBy="store-create-team-title"
  oncancel={cancelCreateTeamDialog}
>
  <form onsubmit={submitDestinationTeam}>
    <DialogFrame
      kicker={$t('store.destinationKicker')}
      title={$t('teams.createTitle')}
      titleId="store-create-team-title"
      lead={$t('teams.createLead')}
    >
    <TextField
        id="store-create-team-name"
        label={$t('teams.name')}
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

    {#if destinationError}<Notice variant="error">{destinationError}</Notice>{/if}

    {#snippet footer()}
      <Button variant="secondary" type="button" onclick={closeCreateTeamDialog} disabled={destinationBusy}>
        {$t('teams.cancel')}
      </Button>
      <Button type="submit" disabled={destinationBusy || !newTeamName.trim()}>
        {destinationBusy ? $t('teams.creating') : $t('teams.createAction')}
      </Button>
    {/snippet}
    </DialogFrame>
  </form>
</Modal>

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
    display: grid;
    gap: 0.35rem;
    margin: 0 0 0.75rem;
    padding: 0.25rem 0;
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

  :global(.destination-trigger.shimpz-button) {
    max-width: 100%;
    border: 0;
    padding: 0;
    background: transparent;
    box-shadow: none;
    color: var(--text);
    cursor: pointer;
    clip-path: none;
    text-align: start;
  }

  :global(.destination-trigger > span) {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: clamp(0.85rem, 2vw, 1.35rem);
    justify-content: flex-start;
  }

  :global(.destination-trigger .destination-name) {
    overflow-wrap: anywhere;
    color: inherit;
    font-family: var(--font-mono);
    font-size: clamp(1.35rem, 3vw, 1.9rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.1;
  }

  :global(.destination-trigger .destination-change) {
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

  :global(.destination-trigger .destination-change b) { font-size: 0.75rem; }
  :global(.destination-trigger:hover > span) { color: var(--accent); }
  :global(.destination-trigger:focus-visible) { outline: 2px solid var(--accent); outline-offset: 0.35rem; }
  :global(.destination-trigger:disabled) { cursor: wait; opacity: 0.55; }

  :global(.destination-dialog form) { margin: 0; }

  .destination-team-list {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .destination-team-list li { min-width: 0; }

  .destination-empty { margin: 0; font-size: 0.7rem; line-height: 1.5; }
  .destination-empty { color: var(--text-dim); }

  .store-frame {
    position: relative;
    background: #000;
  }
  .frame-stage { position: relative; min-height: 20rem; transition: height 0.22s var(--ease); }
  :global(.shimpz-embed) { display: block; width: 100%; height: 100%; border: 0; background: #000; opacity: 0; transition: opacity 0.18s ease; }
  :global(.shimpz-embed.frame-ready) { opacity: 1; }
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
    .frame-actions :global(.shimpz-action-link), .frame-actions :global(.shimpz-button) { width: 100%; }
  }
</style>
