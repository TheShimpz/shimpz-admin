<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { AssistantCard, Button, ChoiceItem, DialogFrame, Modal, Notice, PageIntro, Skeleton, TextField, Toolbar } from '@shimpz/frontend';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import AssistantActionDialog from '$lib/AssistantActionDialog.svelte';
  import LocalAssistantInstallDialog from '$lib/LocalAssistantInstallDialog.svelte';
  import {
    installAssistant,
    installLocalAssistant,
    listLocalAssistantSnapshots,
    listPublicAssistantCatalog,
    safeApiError,
    uninstallAssistant,
  } from '$lib/localApi.js';
  import { t } from '$lib/i18n.js';
  import { loadLocalAssistantIcon } from '$lib/localAssistantIcons.js';
  import { groupLocalAssistantSnapshots, projectPublishedAssistants } from '$lib/localSnapshots.js';
  import { sessionContext } from '$lib/sessionContext.js';
  import { createTeam, refreshTeamInventory, teamContext } from '$lib/teamContext.js';
  import { jsonObject } from '$lib/validate.js';

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
  let dialogOpen = $state(false);
  let dialogAction = $state('install');
  let dialogMode = $state('install');
  let dialogAttempt = 0;
  let publicAssistants = $state([]);
  let publicCatalogPhase = $state('loading');
  let publicCatalogError = $state('');
  let publicCatalogRequest = 0;
  let localSnapshots = $state([]);
  let localSnapshotPhase = $state('idle');
  let localSnapshotSettled = $state(false);
  let localSnapshotError = $state('');
  let localSnapshotRequest = 0;
  let localInstallImageId = $state('');
  let localInstallDialogOpen = $state(false);
  let localInstallDialogError = $state('');
  let pendingLocalSnapshot = $state(null);
  let pendingLocalSnapshots = $state([]);
  let localIconUrls = $state({});
  let localIconRequest = 0;
  let copy = $derived($t('assistantStore'));
  let localCopy = $derived($t('store'));
  let destinationCopy = $derived($t('assistantDestination'));
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
    publicCatalogPhase === 'loading' || (localProfile && !localSnapshotSettled),
  );
  let catalogBusy = $derived(
    catalogPresentationPending || localSnapshotPhase === 'loading' || Boolean(localInstallImageId),
  );
  let pendingAssistantAvailable = $derived(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pendingAssistant) &&
      (dialogAction === 'uninstall' || /^sha256:[0-9a-f]{64}$/.test(pendingSourceDigest)),
  );
  let activeTeamRecord = $derived(
    runningTeams.find((team) => team.id === $teamContext.selectedTeamId) ?? null,
  );
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
    const assistantId = pendingAssistant;
    const assistantName = pendingAssistantName;
    busy = true;
    dialogError = '';
    try {
      const result = await uninstallAssistant(fetch, team.id, assistantId);
      const refreshed = await refreshInstalled(team.id);
      finishAssistantDialog();
      const retainedMessage = result.remove_command
        ? ` ${$t('store.localImageRetainedMessage', { command: result.remove_command })}`
        : '';
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
        }) + retainedMessage,
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

  async function loadPublicCatalog() {
    const request = ++publicCatalogRequest;
    publicCatalogPhase = 'loading';
    publicCatalogError = '';
    try {
      const assistants = await listPublicAssistantCatalog(fetch);
      if (request !== publicCatalogRequest) return;
      publicAssistants = assistants;
      publicCatalogPhase = 'ready';
    } catch (error) {
      if (request !== publicCatalogRequest) return;
      publicAssistants = [];
      publicCatalogError = error instanceof Error ? error.message : copy.genericFailure;
      publicCatalogPhase = 'error';
    }
  }

  async function loadLocalSnapshots() {
    if (!localProfile) return;
    const request = ++localSnapshotRequest;
    localSnapshotPhase = 'loading';
    localSnapshotError = '';
    try {
      const snapshots = await listLocalAssistantSnapshots(fetch);
      if (request !== localSnapshotRequest) return;
      localSnapshots = snapshots;
      localSnapshotPhase = 'ready';
      localSnapshotSettled = true;
      void loadLocalSnapshotIcons(snapshots);
    } catch (error) {
      if (request !== localSnapshotRequest) return;
      localSnapshotError = error instanceof Error ? error.message : localCopy.localFailure;
      localSnapshotPhase = 'error';
      localSnapshotSettled = true;
    }
  }

  function releaseLocalIconUrls() {
    for (const url of Object.values(localIconUrls)) URL.revokeObjectURL(url);
    localIconUrls = {};
  }

  async function loadLocalSnapshotIcons(snapshots) {
    const request = ++localIconRequest;
    releaseLocalIconUrls();
    const primarySnapshots = groupLocalAssistantSnapshots(snapshots).map((group) => group.primary);
    await Promise.allSettled(primarySnapshots.map(async (snapshot) => {
      try {
        const icon = await loadLocalAssistantIcon(fetch, snapshot.image_id);
        if (request !== localIconRequest) return;
        const url = URL.createObjectURL(icon);
        if (request !== localIconRequest) {
          URL.revokeObjectURL(url);
          return;
        }
        localIconUrls = { ...localIconUrls, [snapshot.image_id]: url };
      } catch {
        // The shared card retains its bounded fallback icon when preview is unavailable.
      }
    }));
  }

  function beginLocalSnapshotInstall(group) {
    const team = activeTeamRecord;
    if (!team || busy || dialogOpen || localInstallDialogOpen || localInstallImageId) return;
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
    pendingLocalSnapshot = null;
    pendingLocalSnapshots = [];
    localInstallDialogError = '';
  }

  async function installLocalSnapshot() {
    const team = activeTeamRecord;
    const snapshot = pendingLocalSnapshot;
    if (!team || !snapshot || busy || localInstallImageId) return;
    localInstallImageId = snapshot.image_id;
    localInstallDialogError = '';
    try {
      const installed = await installLocalAssistant(fetch, team.id, snapshot.image_id);
      await refreshInstalled(team.id);
      localInstallDialogOpen = false;
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
      void loadLocalSnapshots();
    } catch (error) {
      localInstallDialogError = error instanceof Error ? error.message : localCopy.localFailure;
    } finally {
      localInstallImageId = '';
    }
  }

  onMount(() => {
    void loadPublicCatalog();
    if (localProfile) void loadLocalSnapshots();
    return () => {
      publicCatalogRequest += 1;
      localSnapshotRequest += 1;
      localIconRequest += 1;
      releaseLocalIconUrls();
    };
  });
</script>

<svelte:head>
  <title>Assistants — Shimpz Admin</title>
  <meta name="description" content="Browse and evaluate trusted Shimpz Assistants from the local Admin." />
</svelte:head>

<PageIntro
  title={$t('store.nav')}
  actionsPosition="start"
>
  {#snippet actions()}
    <div class="destination-context">
      <p class="destination-kicker">{$t('store.destinationKicker')}</p>
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
      {#if !activeTeamRecord}<p class="destination-lead">{destinationCopy.empty}</p>{/if}
    </div>
  {/snippet}
</PageIntro>

<section
  class="assistant-catalog"
  aria-label={$t('store.frameTitle')}
  aria-busy={catalogBusy}
>
  {#if !activeTeamRecord && (localSnapshotGroups.length > 0 || visiblePublicAssistants.length > 0)}
    <Notice variant="info">{localCopy.localNoTeam}</Notice>
  {/if}
  {#if localSnapshotError}<Notice variant="error">{localSnapshotError}</Notice>{/if}
  {#if publicCatalogError}<Notice variant="error">{publicCatalogError}</Notice>{/if}

  <div class="assistant-grid">
    {#if catalogPresentationPending}
      <Skeleton class="assistant-catalog-loading" height="18rem" />
    {/if}

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
        iconSrc={localIconUrls[group.primary.image_id]}
        iconLoading="lazy"
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
        iconSrc={`/api/assistants/${assistant.assistant_id}/catalog-icon`}
        iconLoading="lazy"
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
  </div>

  {#if localSnapshotPhase === 'error' || publicCatalogPhase === 'error'}
    <Toolbar class="catalog-actions">
      {#if localSnapshotPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadLocalSnapshots} disabled={Boolean(localInstallImageId)}>
          {localCopy.localRetry}
        </Button>
      {/if}
      {#if publicCatalogPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadPublicCatalog}>{copy.retryStore}</Button>
      {/if}
    </Toolbar>
  {/if}
</section>

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

<LocalAssistantInstallDialog
  bind:open={localInstallDialogOpen}
  snapshot={pendingLocalSnapshot}
  snapshots={pendingLocalSnapshots}
  team={activeTeamRecord}
  busy={Boolean(localInstallImageId)}
  error={localInstallDialogError}
  onconfirm={installLocalSnapshot}
  oncancel={closeLocalSnapshotInstall}
  onselect={selectLocalSnapshot}
/>

<style>
  .destination-context {
    display: grid;
    min-width: 0;
    max-width: 54rem;
    gap: var(--shimpz-space-2);
  }

  .destination-kicker,
  .destination-lead {
    margin: 0;
  }

  .destination-kicker {
    color: var(--accent);
    font: 600 0.68rem/1.4 var(--font-mono);
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .destination-lead {
    color: var(--text-dim);
    font-size: 0.95rem;
    line-height: 1.55;
  }

  :global(.shimpz-page-intro.actions-start) {
    align-items: flex-end;
    border-block-end: 0;
  }

  :global(.destination-trigger.shimpz-button) {
    width: fit-content;
    max-width: 100%;
    justify-content: flex-start;
    justify-self: start;
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
    font-size: clamp(1.65rem, 4vw, 3rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1.1;
  }

  :global(.shimpz-page-intro.actions-start h1) {
    font-size: clamp(1.35rem, 3vw, 1.9rem);
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

  @media (max-width: 680px) {
    :global(.shimpz-page-intro.actions-start) { align-items: stretch; }
  }

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

  .assistant-catalog {
    display: grid;
    gap: var(--shimpz-space-3);
    margin-block-start: var(--shimpz-space-4);
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
