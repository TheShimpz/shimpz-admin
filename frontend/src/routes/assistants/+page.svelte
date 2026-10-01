<script>
  import { page } from '$app/state';
  import { getContext, onMount, tick, untrack } from 'svelte';
  import { AssistantCard, Button, Notice, Skeleton, Toolbar } from '@shimpz/frontend';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import AssistantActionDialog from '$lib/AssistantActionDialog.svelte';
  import { INITIAL_VIEW_READINESS } from '$lib/initialView.js';
  import LocalAssistantInstallDialog from '$lib/LocalAssistantInstallDialog.svelte';
  import {
    installAssistant,
    installLocalAssistant,
    listLocalAssistantSnapshots,
    listPublicAssistantCatalog,
    safeApiError,
    uninstallAssistant,
  } from '$lib/localApi.js';
  import { locale, t } from '$lib/i18n.js';
  import { loadLocalAssistantIcon, loadPublicAssistantIcon } from '$lib/localAssistantIcons.js';
  import { groupLocalAssistantSnapshots, projectPublishedAssistants } from '$lib/localSnapshots.js';
  import { sessionContext } from '$lib/sessionContext.js';
  import { refreshTeamInventory, teamContext } from '$lib/teamContext.js';
  import { TEAM_ID_RE } from '$lib/validate.js';
  import { jsonObject } from '$lib/validate.js';

  const ICON_PRESENTATION_BUDGET_MS = 1500;

  let dialogError = $state('');
  let busy = $state(false);
  let selectedTeam = $state('');
  let pendingAssistant = $state('');
  let pendingSourceDigest = $state('');
  let dialogOpen = $state(false);
  let dialogAction = $state('install');
  let dialogMode = $state('install');
  let dialogAttempt = 0;
  let publicAssistants = $state([]);
  let publicCatalogPhase = $state('loading');
  let publicCatalogError = $state('');
  let localSnapshots = $state([]);
  let localSnapshotPhase = $state('idle');
  let localSnapshotSettled = $state(false);
  let localSnapshotError = $state('');
  let localInstallImageId = $state('');
  let localInstallDialogOpen = $state(false);
  let localInstallDialogError = $state('');
  let pendingLocalSnapshot = $state(null);
  let pendingLocalSnapshots = $state([]);
  let catalogIconUrls = $state({});
  // Keys whose icon could not be presented in this load; their cards stop showing a loading face.
  let catalogIconFailures = $state({});
  let catalogPresentationSettled = $state(false);
  let catalogRefreshing = $state(false);
  let catalogPresentationRequest = 0;
  let catalogPresentationController = null;
  const initialViewReadiness = getContext(INITIAL_VIEW_READINESS);
  let copy = $derived($t('assistantStore'));
  let localCopy = $derived($t('store'));
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let localProfile = $derived($sessionContext.profile === 'local');
  let localSnapshotGroups = $derived(groupLocalAssistantSnapshots(localSnapshots));
  let visiblePublicAssistants = $derived(
    projectPublishedAssistants(
      publicAssistants,
      localSnapshotGroups,
      !localProfile || localSnapshotSettled,
    ),
  );
  let catalogPresentationPending = $derived(
    !catalogPresentationSettled,
  );
  let catalogBusy = $derived(
    catalogPresentationPending || catalogRefreshing || Boolean(localInstallImageId),
  );
  let pendingAssistantAvailable = $derived(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pendingAssistant) &&
      (dialogAction === 'uninstall' || /^sha256:[0-9a-f]{64}$/.test(pendingSourceDigest)),
  );
  let requestedTeamId = $derived.by(() => {
    const candidate = page.url.searchParams.get('team') ?? '';
    return TEAM_ID_RE.test(candidate) ? candidate : '';
  });
  // Without a visible destination header, the Store acts only for the exact Team its link names, and only once
  // that Team's context is ready; every confirmation rechecks the Team it was opened for.
  let requestedTeamUnavailable = $derived(
    $teamContext.phase === 'ready'
      && page.url.searchParams.has('team')
      && requestedTeamId !== $teamContext.selectedTeamId,
  );
  let activeTeamRecord = $derived(
    $teamContext.phase !== 'ready' || requestedTeamUnavailable
      ? null
      : runningTeams.find((team) => team.id === $teamContext.selectedTeamId) ?? null,
  );
  let pendingLocalTeamId = $state('');
  let selectedTeamRecord = $derived(runningTeams.find((team) => team.id === selectedTeam) ?? null);
  let pendingAssistantName = $derived(
    localSnapshotGroups.find((entry) => entry.assistant_id === pendingAssistant)?.primary.name ??
      publicAssistants.find((entry) => entry.assistant_id === pendingAssistant)?.name ??
      $teamContext.catalog.find((entry) => entry.id === pendingAssistant)?.name ??
      pendingAssistant,
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
      return $teamContext.phase === 'ready';
    }
    try {
      await refreshTeamInventory(fetch);
      return true;
    } catch {
      return false;
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

  async function confirmInstall() {
    if (
      busy ||
      !pendingAssistantAvailable ||
      !['install', 'error'].includes(dialogMode)
    ) return;
    const team = runningTeams.find((item) => item.id === selectedTeam);
    if (!team) return;
    if (team.id !== activeTeamRecord?.id) {
      dialogError = localCopy.teamUnavailable;
      dialogMode = 'error';
      return;
    }

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

  function finishAssistantDialog() {
    dialogAttempt += 1;
    dialogOpen = false;
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
    if (team.id !== activeTeamRecord?.id) {
      dialogError = localCopy.teamUnavailable;
      dialogMode = 'error';
      return;
    }
    const assistantId = pendingAssistant;
    const assistantName = pendingAssistantName;
    busy = true;
    dialogError = '';
    try {
      await uninstallAssistant(fetch, team.id, assistantId);
      const refreshed = await refreshInstalled(team.id);
      finishAssistantDialog();
      showAdminNotice({
        tone: refreshed ? 'success' : 'info',
        label: $t(refreshed
          ? 'store.assistantUninstalledLabel'
          : 'store.assistantUninstallRefreshLabel'),
        message: $t(refreshed
          ? 'store.assistantUninstalledMessage'
          : 'store.assistantUninstallRefreshMessage', {
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

  function beginAssistantUninstall(assistantId) {
    const installed = $teamContext.phase === 'ready'
      ? $teamContext.installedAssistants.find((entry) => entry.assistant === assistantId)
      : null;
    if (!activeTeamRecord || !installed || busy) return;
    dialogAction = 'uninstall';
    pendingAssistant = installed.assistant;
    selectedTeam = activeTeamRecord.id;
    dialogError = '';
    dialogMode = 'uninstall';
    showAssistantDialog();
  }

  function localIconKey(snapshot) {
    return `local:${snapshot.image_id}`;
  }

  function publicIconKey(assistant) {
    return `public:${assistant.assistant_id}:${assistant.icon_digest}`;
  }

  function boundedFailure(error, fallback) {
    return error instanceof Error && error.name !== 'AbortError' ? error.message : fallback;
  }

  function decodeImage(image, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('The Assistant icon request was aborted.', 'AbortError'));
        return;
      }
      const abort = () => {
        reject(new DOMException('The Assistant icon request was aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      image.decode().then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abort);
      });
    });
  }

  async function decodedIconUrl(icon, signal) {
    const url = URL.createObjectURL(icon);
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try {
      await decodeImage(image, signal);
      if (signal.aborted) throw new DOMException('The Assistant icon request was aborted.', 'AbortError');
      return url;
    } catch (error) {
      image.src = '';
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function releaseCatalogIconUrls() {
    for (const url of Object.values(catalogIconUrls)) URL.revokeObjectURL(url);
    catalogIconUrls = {};
    catalogIconFailures = {};
  }

  function releaseObsoleteIconUrls(previousUrls, nextUrls) {
    for (const [key, url] of Object.entries(previousUrls)) {
      if (nextUrls[key] !== url) URL.revokeObjectURL(url);
    }
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function loadCatalogPresentation() {
    const request = ++catalogPresentationRequest;
    const language = $locale;
    catalogPresentationController?.abort();
    const controller = new AbortController();
    catalogPresentationController = controller;
    catalogRefreshing = true;
    publicCatalogError = '';
    if (!catalogPresentationSettled) publicCatalogPhase = 'loading';
    if (localProfile) {
      localSnapshotError = '';
      if (!catalogPresentationSettled) localSnapshotPhase = 'loading';
    }

    try {
      const [publicResult, localResult] = await Promise.allSettled([
        listPublicAssistantCatalog(fetch, language, controller.signal),
        localProfile
          ? listLocalAssistantSnapshots(fetch, controller.signal)
          : Promise.resolve(localSnapshots),
      ]);
      if (request !== catalogPresentationRequest) return;

      const nextPublicAssistants = publicResult.status === 'fulfilled' ? publicResult.value : [];
      const nextPublicPhase = publicResult.status === 'fulfilled' ? 'ready' : 'error';
      const nextPublicError = publicResult.status === 'fulfilled'
        ? ''
        : boundedFailure(publicResult.reason, copy.genericFailure);

      const nextLocalSnapshots = localResult.status === 'fulfilled' ? localResult.value : [];
      const nextLocalPhase = localResult.status === 'fulfilled' ? 'ready' : 'error';
      const nextLocalError = localResult.status === 'fulfilled'
        ? ''
        : boundedFailure(localResult.reason, localCopy.localFailure);

      const groups = groupLocalAssistantSnapshots(nextLocalSnapshots);
      const published = projectPublishedAssistants(nextPublicAssistants, groups, true);
      const iconController = new AbortController();
      const abortIcons = () => iconController.abort();
      controller.signal.addEventListener('abort', abortIcons, { once: true });
      const entries = [
        ...groups.map((group) => ({
          key: localIconKey(group.primary),
          load: () => loadLocalAssistantIcon(fetch, group.primary.image_id, {
            signal: iconController.signal,
          }),
        })),
        ...published.map((assistant) => ({
          key: publicIconKey(assistant),
          load: () => loadPublicAssistantIcon(fetch, assistant.assistant_id, {
            signal: iconController.signal,
          }),
        })),
      ];
      const previousUrls = catalogIconUrls;
      const nextUrls = {};
      for (const entry of entries) {
        if (previousUrls[entry.key]) nextUrls[entry.key] = previousUrls[entry.key];
      }

      publicAssistants = nextPublicAssistants;
      publicCatalogPhase = nextPublicPhase;
      publicCatalogError = nextPublicError;
      if (localProfile) {
        localSnapshots = nextLocalSnapshots;
        localSnapshotPhase = nextLocalPhase;
        localSnapshotError = nextLocalError;
        localSnapshotSettled = true;
      }
      catalogIconUrls = nextUrls;
      catalogIconFailures = {};
      catalogPresentationSettled = true;
      catalogRefreshing = false;
      await tick();
      await nextPaint();
      releaseObsoleteIconUrls(previousUrls, nextUrls);
      if (request !== catalogPresentationRequest) return;
      initialViewReadiness?.settleAssistants?.();

      const iconTimeout = globalThis.setTimeout(
        () => iconController.abort(),
        ICON_PRESENTATION_BUDGET_MS,
      );
      await Promise.allSettled(entries.map(async (entry) => {
        if (catalogIconUrls[entry.key]) return;
        try {
          const url = await decodedIconUrl(await entry.load(), iconController.signal);
          if (request !== catalogPresentationRequest) {
            URL.revokeObjectURL(url);
            return;
          }
          catalogIconUrls[entry.key] = url;
        } catch {
          // A failed or over-budget icon is shown as unavailable, never as a substitute mark.
          if (request === catalogPresentationRequest) catalogIconFailures[entry.key] = true;
        }
      }));
      globalThis.clearTimeout(iconTimeout);
      controller.signal.removeEventListener('abort', abortIcons);
    } finally {
      if (request === catalogPresentationRequest) catalogRefreshing = false;
    }
  }

  function beginLocalSnapshotInstall(group) {
    const team = activeTeamRecord;
    if (!team || busy || dialogOpen || localInstallDialogOpen || localInstallImageId) return;
    pendingLocalTeamId = team.id;
    pendingLocalSnapshot = group.primary;
    pendingLocalSnapshots = [group.primary, ...group.alternatives];
    localInstallDialogError = '';
    localInstallDialogOpen = true;
  }

  function selectLocalSnapshot(snapshot) {
    if (!localInstallImageId && pendingLocalSnapshots.some((entry) => entry.image_id === snapshot.image_id)) {
      pendingLocalSnapshot = snapshot;
    }
  }

  function closeLocalSnapshotInstall() {
    if (localInstallImageId) return;
    localInstallDialogOpen = false;
    pendingLocalTeamId = '';
    pendingLocalSnapshot = null;
    pendingLocalSnapshots = [];
    localInstallDialogError = '';
  }

  async function installLocalSnapshot() {
    const team = activeTeamRecord;
    const snapshot = pendingLocalSnapshot;
    if (!team || !snapshot || busy || localInstallImageId) return;
    if (team.id !== pendingLocalTeamId) {
      localInstallDialogError = localCopy.teamUnavailable;
      return;
    }
    localInstallImageId = snapshot.image_id;
    localInstallDialogError = '';
    try {
      const installed = await installLocalAssistant(fetch, team.id, snapshot.image_id);
      await refreshInstalled(team.id);
      localInstallDialogOpen = false;
      pendingLocalTeamId = '';
      pendingLocalSnapshot = null;
      pendingLocalSnapshots = [];
      showAdminNotice({
        tone: 'success',
        label: localCopy.localInstalledLabel,
        message: $t('store.localInstalledMessage', {
          assistant: installed.assistant,
          team: team.name,
        }),
      });
      void loadCatalogPresentation();
    } catch (error) {
      localInstallDialogError = error instanceof Error ? error.message : localCopy.localFailure;
    } finally {
      localInstallImageId = '';
    }
  }

  // The catalog follows the interface language and reloads when it changes.
  $effect(() => {
    void $locale;
    untrack(() => { void loadCatalogPresentation(); });
  });

  onMount(() => {
    return () => {
      catalogPresentationRequest += 1;
      catalogPresentationController?.abort();
      releaseCatalogIconUrls();
    };
  });
</script>

<svelte:head>
  <title>Assistants — Shimpz Admin</title>
  <meta name="description" content="Browse and evaluate trusted Shimpz Assistants from the local Admin." />
</svelte:head>

<h1 class="sr-only">{$t('store.nav')}</h1>

<section
  class="assistant-catalog"
  aria-label={$t('store.frameTitle')}
  aria-busy={catalogBusy}
>
  {#if requestedTeamUnavailable}
    <Notice variant="warning">{localCopy.teamUnavailable}</Notice>
  {:else if !activeTeamRecord && (localSnapshotGroups.length > 0 || visiblePublicAssistants.length > 0)}
    <Notice variant="info">{localCopy.localNoTeam}</Notice>
  {/if}
  {#if localSnapshotError}<Notice variant="error">{localSnapshotError}</Notice>{/if}
  {#if publicCatalogError}<Notice variant="error">{publicCatalogError}</Notice>{/if}

  <div class="assistant-grid">
    {#if catalogPresentationPending}
      <Skeleton class="assistant-catalog-loading" height="18rem" />
    {:else}
      {#each localSnapshotGroups as group (group.assistant_id)}
      {@const installed = $teamContext.installedAssistants.find((entry) => entry.assistant === group.assistant_id)}
      {@const localInstalled = installed?.provenance === 'local'}
      {@const installing = [group.primary, ...group.alternatives].some(
        (snapshot) => snapshot.image_id === localInstallImageId,
      )}
      <AssistantCard
        id={`assistant-${group.assistant_id}`}
        class="assistant-card local-assistant-card"
        name={group.primary.name}
        meta={group.primary.declared_creators.join(', ')}
        summary={group.primary.summary}
        iconSrc={catalogIconUrls[localIconKey(group.primary)]}
        iconStatus={catalogIconFailures[localIconKey(group.primary)] ? 'failed' : 'loading'}
        iconLoading="eager"
        badge={localCopy.localBadge}
        badgeTone="local"
        installed={localInstalled}
        actionLabel={localInstalled ? localCopy.assistantUninstallConfirm : localCopy.localInstall}
        actionDisabled={!activeTeamRecord || busy || dialogOpen || Boolean(localInstallImageId)}
        actionTone={localInstalled ? 'danger' : 'install'}
        actionIcon={localInstalled ? 'uninstall' : 'add'}
        actionPersistent={installing}
        actionStatus={installing ? localCopy.localInstalling : undefined}
        onaction={() => localInstalled
          ? beginAssistantUninstall(group.assistant_id)
          : beginLocalSnapshotInstall(group)}
        aria-label={`${group.assistant_id} — ${localCopy.localBadge}`}
        aria-busy={installing}
      />
      {/each}

      {#each visiblePublicAssistants as assistant (assistant.assistant_id)}
      {@const installed = $teamContext.installedAssistants.find((entry) => entry.assistant === assistant.assistant_id)}
      {@const publicationInstalled = installed?.provenance === 'published'}
      {@const localBindingWithoutSnapshot = installed?.provenance === 'local'}
      <AssistantCard
        id={`assistant-${assistant.assistant_id}`}
        class="assistant-card"
        name={assistant.name}
        meta={assistant.creators.join(', ')}
        summary={assistant.summary}
        iconSrc={catalogIconUrls[publicIconKey(assistant)]}
        iconStatus={catalogIconFailures[publicIconKey(assistant)] ? 'failed' : 'loading'}
        iconLoading="eager"
        badge={localCopy.publicBadge}
        installed={publicationInstalled}
        actionLabel={publicationInstalled ? localCopy.assistantUninstallConfirm : localCopy.localInstall}
        actionDisabled={!activeTeamRecord || busy || dialogOpen || Boolean(localInstallImageId) || localBindingWithoutSnapshot}
        actionTone={publicationInstalled ? 'danger' : 'install'}
        actionIcon={publicationInstalled ? 'uninstall' : 'add'}
        actionPersistent={localBindingWithoutSnapshot}
        actionStatus={localBindingWithoutSnapshot ? localCopy.localInstalledLabel : undefined}
        onaction={() => publicationInstalled
          ? beginAssistantUninstall(assistant.assistant_id)
          : beginInstall(assistant.assistant_id, assistant.source_digest)}
        aria-label={assistant.assistant_id}
      />
      {/each}
    {/if}
  </div>

  {#if localSnapshotPhase === 'error' || publicCatalogPhase === 'error'}
    <Toolbar class="catalog-actions">
      {#if localSnapshotPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadCatalogPresentation} disabled={Boolean(localInstallImageId)}>
          {localCopy.localRetry}
        </Button>
      {/if}
      {#if publicCatalogPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadCatalogPresentation}>{copy.retryStore}</Button>
      {/if}
    </Toolbar>
  {/if}
</section>

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

<LocalAssistantInstallDialog
  bind:open={localInstallDialogOpen}
  snapshot={pendingLocalSnapshot}
  snapshots={pendingLocalSnapshots}
  team={runningTeams.find((team) => team.id === pendingLocalTeamId) ?? null}
  busy={Boolean(localInstallImageId)}
  error={localInstallDialogError}
  onconfirm={installLocalSnapshot}
  oncancel={closeLocalSnapshotInstall}
  onselect={selectLocalSnapshot}
/>

<style>
  .assistant-catalog {
    display: grid;
    gap: var(--shimpz-space-3);
  }
  .assistant-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 23rem));
    gap: 1rem;
  }
  @media (max-width: 720px) {
    .assistant-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 540px) {
    .assistant-grid { grid-template-columns: 1fr; }
  }
</style>
