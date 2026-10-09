<script>
  // One Assistant's own page for the Team its link names: what it is for, the credentials it keeps, every Action with
  // the permission it asks for, its Creator's links, and the one action that installs it in or removes it from that
  // Team. An installed Assistant always shows its exact binding; otherwise the staged snapshot or the publication it
  // would install, once every source that could name it has been read.
  import { page } from '$app/state';
  import { getContext, onMount, untrack } from 'svelte';
  import { ActionLink, AssistantIcon, Button, Disclosure, Notice, Skeleton, TextLink } from '@shimpz/frontend';
  import { showAdminNotice } from '$lib/adminNotice.js';
  import AssistantActionDialog from '$lib/AssistantActionDialog.svelte';
  import { actionGroups, continuingText, pageTarget } from '$lib/assistantPage.js';
  import { CREATOR_LINK_ICONS, CREATOR_LINK_NAMES } from '$lib/creatorLinkIcons.js';
  import { locale, t } from '$lib/i18n.js';
  import { INITIAL_VIEW_READINESS } from '$lib/initialView.js';
  import LocalAssistantInstallDialog from '$lib/LocalAssistantInstallDialog.svelte';
  import {
    installAssistant,
    installLocalAssistant,
    listLocalAssistantSnapshots,
    listPublicAssistantCatalog,
    uninstallAssistant,
  } from '$lib/localApi.js';
  import {
    isInadmissibleLocalPreview,
    loadAssistantDetails,
    loadLocalAssistantDetails,
    loadLocalAssistantIcon,
    loadPublicAssistantIcon,
  } from '$lib/localAssistantIcons.js';
  import { groupLocalAssistantSnapshots } from '$lib/localSnapshots.js';
  import { MAX_TEAM_ASSISTANTS, refreshTeamInventory, teamContext } from '$lib/teamContext.js';
  import { ASSISTANT_ID_RE, ASSISTANT_LIMIT_REACHED, TEAM_ID_RE } from '$lib/validate.js';

  const initialViewReadiness = getContext(INITIAL_VIEW_READINESS);

  // The sources this page may show: this machine's staged snapshot of the Assistant and its public publication.
  let sourcesPhase = $state('loading');
  let sourcesLocale = $state('');
  let localGroup = $state(null);
  let publication = $state(null);
  let localKnown = $state(true);
  let publicKnown = $state(true);
  // The page copy of the current target, read for the interface language it was asked in.
  let details = $state(null);
  let detailsKey = $state('');
  let detailsPhase = $state('idle');
  let iconSrc = $state('');
  let iconFailed = $state(false);
  let sourcesRequest = 0;
  let detailsRequest = 0;
  let detailsController = null;
  let blobIcon = '';

  // Install and uninstall, each frozen to the Team and target its dialog opened for.
  let busy = $state(false);
  let dialogOpen = $state(false);
  let dialogAction = $state('install');
  let dialogMode = $state('install');
  let dialogError = $state('');
  let dialogTarget = $state(null);
  let localDialogOpen = $state(false);
  let localDialogError = $state('');
  let localDialogTarget = $state(null);
  let localSnapshot = $state(null);
  let installingImage = $state('');

  let pageCopy = $derived($t('assistantPage'));
  let storeCopy = $derived($t('store'));
  let actionCopy = $derived($t('assistantStore'));
  let assistantId = $derived(page.params.assistant ?? '');
  let validAssistant = $derived(ASSISTANT_ID_RE.test(assistantId) && assistantId.length <= 40);
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let requestedTeamId = $derived.by(() => {
    const candidate = page.url.searchParams.get('team') ?? '';
    return TEAM_ID_RE.test(candidate) ? candidate : '';
  });
  // The page acts only for the exact Team its link names, and only once that Team's context is ready.
  let requestedTeamUnavailable = $derived(
    $teamContext.phase === 'ready' && page.url.searchParams.has('team') && requestedTeamId !== $teamContext.selectedTeamId,
  );
  let activeTeam = $derived(
    $teamContext.phase !== 'ready' || requestedTeamUnavailable
      ? null
      : runningTeams.find((team) => team.id === $teamContext.selectedTeamId) ?? null,
  );
  let installed = $derived(
    activeTeam ? $teamContext.installedAssistants.find((entry) => entry.assistant === assistantId) ?? null : null,
  );
  let target = $derived(pageTarget({ installed, localGroup, publication, localKnown, publicKnown }));
  let pageCopyReady = $derived(detailsPhase === 'ready' && details !== null);
  let groups = $derived(pageCopyReady ? actionGroups(details.page.actions) : { read: [], write: [] });
  // An Integration and a Stored Input may share an id, so each row is keyed by its kind as well.
  let credentials = $derived(pageCopyReady ? [
    ...details.page.integrations.map((item) => ({
      key: `integration:${item.id}`,
      id: item.id,
      text: $t('assistantPage.integrationAccount', { provider: item.provider }),
    })),
    // A Stored Input is a secret the person enters, so its row also says how to get it and links where (ADR-0090).
    ...details.page.storedInputs.map((item) => ({
      key: `stored-input:${item.id}`,
      id: item.id,
      text: item.label,
      help: item.help,
      helpUrl: item.helpUrl,
    })),
  ] : []);
  let links = $derived(pageCopyReady ? details.page.links : []);
  // Without its page copy, an installed Assistant is named only by its inventory identity.
  let shownName = $derived(details?.name ?? assistantId);
  let shownVersion = $derived(details?.assistant_version ?? installed?.assistant_version ?? '');
  let isLocal = $derived(target.mode === 'local' || (target.mode === 'installed' && installed?.provenance === 'local'));
  let refused = $derived(target.mode === 'local' && detailsPhase === 'refused');
  let loading = $derived(sourcesPhase === 'loading' || $teamContext.phase === 'idle' || $teamContext.phase === 'loading');

  let dialogTitle = $derived(
    dialogAction === 'uninstall'
      ? dialogMode === 'error'
        ? storeCopy.assistantUninstallFailureTitle
        : $t('store.assistantUninstallTitle', { assistant: dialogTarget?.name ?? shownName })
      : ({
          install: actionCopy.confirmTitle,
          installed: actionCopy.alreadyTitle,
          error: actionCopy.failureTitle,
        }[dialogMode] ?? actionCopy.confirmTitle),
  );
  let dialogLead = $derived(
    dialogAction === 'uninstall'
      ? dialogMode === 'error'
        ? storeCopy.assistantUninstallFailureLead
        : $t('store.assistantUninstallLead', { assistant: dialogTarget?.name ?? shownName, team: dialogTarget?.team.name ?? '' })
      : ({
          install: actionCopy.confirmLead,
          installed: actionCopy.alreadyLead,
          error: actionCopy.failureLead,
        }[dialogMode] ?? actionCopy.confirmLead),
  );
  let dialogPrimaryLabel = $derived(
    busy
      ? dialogAction === 'uninstall' ? storeCopy.assistantUninstalling : actionCopy.working
      : dialogMode === 'error'
        ? dialogAction === 'uninstall' ? storeCopy.assistantActionRetry : actionCopy.retryAction
        : dialogAction === 'uninstall' ? storeCopy.assistantUninstallConfirm : actionCopy.confirm,
  );
  let dialogSecondaryLabel = $derived(
    ['install', 'uninstall'].includes(dialogMode)
      ? dialogAction === 'uninstall' ? storeCopy.assistantActionCancel : actionCopy.cancel
      : $t('integration.close'),
  );

  function settleInitialView() {
    initialViewReadiness?.settleAssistants?.();
  }

  // Read both sources in the interface language; a staged snapshot shadows the publication of the same Assistant.
  async function loadSources() {
    const request = ++sourcesRequest;
    const language = $locale;
    const [publicResult, localResult] = await Promise.allSettled([
      listPublicAssistantCatalog(fetch, language),
      listLocalAssistantSnapshots(fetch),
    ]);
    if (request !== sourcesRequest) return;
    const groups = localResult.status === 'fulfilled' ? groupLocalAssistantSnapshots(localResult.value) : [];
    localGroup = groups.find((group) => group.assistant_id === assistantId) ?? null;
    publication = publicResult.status === 'fulfilled'
      ? publicResult.value.find((entry) => entry.assistant_id === assistantId) ?? null
      : null;
    localKnown = localResult.status === 'fulfilled';
    publicKnown = publicResult.status === 'fulfilled';
    sourcesLocale = language;
    sourcesPhase = 'ready';
  }

  function reloadSources() {
    sourcesPhase = 'loading';
    void loadSources();
  }

  function releaseIcon() {
    if (blobIcon) URL.revokeObjectURL(blobIcon);
    blobIcon = '';
  }

  // The full identity of what the page reads, so another Assistant, Team, binding, build, or language never reuses it.
  function targetKey(current, team, language) {
    const subject = `${team?.id ?? ''}:${assistantId}:${language}`;
    if (current.mode === 'installed') {
      return `installed:${subject}:${current.installed.provenance}:${current.installed.assistant_version}`;
    }
    if (current.mode === 'local') return `local:${subject}:${current.group.primary.image_id}`;
    if (current.mode === 'public') return `public:${subject}:${current.publication.source_digest}`;
    return `${current.mode}:${subject}`;
  }

  // Forget the shown page copy and refuse every reply still in flight for it.
  function clearDetails() {
    detailsRequest += 1;
    detailsController?.abort();
    detailsController = null;
    detailsKey = '';
    details = null;
    detailsPhase = 'idle';
    iconFailed = false;
    releaseIcon();
    iconSrc = '';
  }

  // Read the page copy of exactly the shown target: the installed binding, the staged image, or the publication.
  async function loadDetails(current, team, language) {
    clearDetails();
    const request = detailsRequest;
    const controller = new AbortController();
    detailsController = controller;
    detailsKey = targetKey(current, team, language);
    const reads = ['installed', 'local', 'public'].includes(current.mode);
    detailsPhase = reads ? 'loading' : 'idle';
    if (!reads) {
      settleInitialView();
      return;
    }
    // A reply counts only for the request, Assistant, Team, and language it was read for. A reply for the current
    // request that arrives while that scope is unsettled (an inventory refresh) is dropped and its key forgotten, so the
    // page reads again once the scope settles.
    const subject = assistantId;
    const stale = () => {
      if (request !== detailsRequest) return true;
      if (subject === assistantId && team?.id === activeTeam?.id && language === $locale) return false;
      detailsKey = '';
      return true;
    };
    try {
      if (current.mode === 'installed') {
        iconSrc = `/api/teams/${encodeURIComponent(team.id)}/assistants/${encodeURIComponent(assistantId)}/icon`;
        const loaded = await loadAssistantDetails(fetch, team.id, assistantId, language, { signal: controller.signal });
        if (stale()) return;
        // Team answers for the binding it runs now; a page for another version is not this entry's page.
        if (loaded.assistant_version !== current.installed.assistant_version) throw new Error('stale binding');
        details = loaded;
      } else if (current.mode === 'local') {
        const imageId = current.group.primary.image_id;
        void loadIcon(() => loadLocalAssistantIcon(fetch, imageId, { signal: controller.signal }), request);
        const loaded = await loadLocalAssistantDetails(fetch, imageId, assistantId, language, {
          signal: controller.signal,
        });
        if (stale()) return;
        details = loaded;
      } else {
        const entry = current.publication;
        void loadIcon(() => loadPublicAssistantIcon(fetch, assistantId, { signal: controller.signal }), request);
        details = {
          assistant_version: entry.assistant_version,
          name: entry.name,
          creators: entry.creators,
          summary: entry.summary,
          page: entry.page,
        };
      }
      detailsPhase = 'ready';
    } catch (error) {
      if (stale() || error?.name === 'AbortError') return;
      detailsPhase = current.mode === 'local' && isInadmissibleLocalPreview(error) ? 'refused' : 'error';
    } finally {
      if (!stale()) settleInitialView();
    }
  }

  async function loadIcon(load, request) {
    try {
      const icon = await load();
      if (request !== detailsRequest) return;
      blobIcon = URL.createObjectURL(icon);
      iconSrc = blobIcon;
    } catch (error) {
      if (request === detailsRequest && error?.name !== 'AbortError') iconFailed = true;
    }
  }

  // The sources follow the interface language; the page copy follows the target, its Team, and the language.
  $effect(() => {
    void $locale;
    void assistantId;
    untrack(() => {
      clearDetails();
      sourcesPhase = 'loading';
      void loadSources();
    });
  });

  $effect(() => {
    if (loading || sourcesLocale !== $locale) return;
    const current = target;
    const team = activeTeam;
    const language = $locale;
    if (targetKey(current, team, language) === untrack(() => detailsKey)) return;
    untrack(() => { void loadDetails(current, team, language); });
  });

  $effect(() => {
    if (!validAssistant || sourcesPhase === 'error' || $teamContext.phase === 'error') settleInitialView();
  });

  onMount(() => () => {
    sourcesRequest += 1;
    detailsRequest += 1;
    detailsController?.abort();
    releaseIcon();
  });

  // The Team's installed Assistants read again from Team, or null when that exact Team's inventory could not be read.
  async function readInventory(team) {
    if ($teamContext.selectedTeamId !== team.id) return null;
    try {
      return (await refreshTeamInventory(fetch)).installedAssistants;
    } catch {
      return null;
    }
  }

  async function refreshInventory(team) {
    return (await readInventory(team)) !== null;
  }

  // What a dialog opens for, frozen: the Team, the Assistant and its shown name, and its installed entry then.
  function frozenTarget(extra) {
    return { team: activeTeam, assistantId, name: shownName, installed, ...extra };
  }

  function sameEntry(left, right) {
    if (!left || !right) return left === right;
    return left.assistant_version === right.assistant_version && left.provenance === right.provenance;
  }

  function beginInstall() {
    if (!activeTeam || busy || target.mode !== 'public') return;
    dialogAction = 'install';
    dialogTarget = frozenTarget({ publication: target.publication });
    dialogError = '';
    dialogMode = installed ? 'installed' : 'install';
    dialogOpen = true;
  }

  function beginUninstall() {
    if (!activeTeam || busy || target.mode !== 'installed') return;
    dialogAction = 'uninstall';
    dialogTarget = frozenTarget({});
    dialogError = '';
    dialogMode = 'uninstall';
    dialogOpen = true;
  }

  function beginLocalInstall() {
    if (!activeTeam || busy || target.mode !== 'local' || refused) return;
    localDialogTarget = frozenTarget({ group: target.group });
    localSnapshot = target.group.primary;
    localDialogError = '';
    localDialogOpen = true;
  }

  // Right before a change, the Team's inventory is read again: the change proceeds only for the same Team, page, and
  // installed entry the dialog opened for. `current` is the entry that inventory names now.
  async function verifiedTarget(frozen) {
    const sameTeam = () => frozen.team.id === activeTeam?.id && frozen.assistantId === assistantId;
    if (!sameTeam()) return { refusal: storeCopy.teamUnavailable };
    const inventory = await readInventory(frozen.team);
    if (inventory === null) return { refusal: pageCopy.inventoryUnavailable };
    if (!sameTeam()) return { refusal: storeCopy.teamUnavailable };
    return { current: inventory.find((entry) => entry.assistant === frozen.assistantId) ?? null };
  }

  // Team's refusal of an install beyond the Team's bound reads as that fact; any other failure keeps its own copy.
  function installFailure(failure, fallback) {
    return failure?.code === ASSISTANT_LIMIT_REACHED
      ? $t('store.assistantLimitReached', { maximum: String(MAX_TEAM_ASSISTANTS) })
      : fallback;
  }

  async function confirmInstall() {
    const frozen = dialogTarget;
    if (busy || !frozen || dialogAction !== 'install' || !['install', 'error'].includes(dialogMode)) return;
    busy = true;
    dialogError = '';
    try {
      const { refusal, current } = await verifiedTarget(frozen);
      if (refusal || !sameEntry(current, frozen.installed)) {
        dialogError = refusal ?? pageCopy.targetChanged;
        dialogMode = 'error';
        return;
      }
      await installAssistant(fetch, frozen.team.id, frozen.assistantId, frozen.publication.source_digest);
      await refreshInventory(frozen.team);
      dialogOpen = false;
      showAdminNotice({
        tone: 'success',
        label: storeCopy.assistantInstalledLabel,
        message: $t('store.assistantInstalledMessage', { assistant: frozen.name, team: frozen.team.name }),
      });
    } catch (failure) {
      await refreshInventory(frozen.team);
      dialogError = installFailure(failure, pageCopy.installFailed);
      dialogMode = 'error';
    } finally {
      busy = false;
    }
  }

  async function confirmUninstall() {
    const frozen = dialogTarget;
    if (busy || !frozen || dialogAction !== 'uninstall') return;
    busy = true;
    dialogError = '';
    try {
      const { refusal, current } = await verifiedTarget(frozen);
      if (refusal || (current && !sameEntry(current, frozen.installed))) {
        dialogError = refusal ?? pageCopy.targetChanged;
        dialogMode = 'error';
        return;
      }
      // Already absent from the Team is the outcome this uninstall asks for, so nothing is removed again.
      let refreshed = true;
      if (current) {
        await uninstallAssistant(fetch, frozen.team.id, frozen.assistantId);
        refreshed = await refreshInventory(frozen.team);
      }
      dialogOpen = false;
      showAdminNotice({
        tone: refreshed ? 'success' : 'info',
        label: refreshed ? storeCopy.assistantUninstalledLabel : storeCopy.assistantUninstallRefreshLabel,
        message: $t(refreshed ? 'store.assistantUninstalledMessage' : 'store.assistantUninstallRefreshMessage', {
          assistant: frozen.name,
          team: frozen.team.name,
        }),
      });
    } catch {
      await refreshInventory(frozen.team);
      dialogError = pageCopy.uninstallFailed;
      dialogMode = 'error';
    } finally {
      busy = false;
    }
  }

  function confirmAssistantAction() {
    void (dialogAction === 'uninstall' ? confirmUninstall() : confirmInstall());
  }

  function closeAssistantDialog() {
    if (!busy) dialogOpen = false;
  }

  function selectLocalSnapshot(snapshot) {
    const builds = localDialogTarget ? [localDialogTarget.group.primary, ...localDialogTarget.group.alternatives] : [];
    if (!busy && builds.some((build) => build.image_id === snapshot.image_id)) localSnapshot = snapshot;
  }

  function closeLocalInstall() {
    if (busy) return;
    localDialogOpen = false;
    localDialogError = '';
  }

  async function installLocalSnapshot() {
    const frozen = localDialogTarget;
    const snapshot = localSnapshot;
    if (busy || !frozen || !snapshot) return;
    busy = true;
    installingImage = snapshot.image_id;
    localDialogError = '';
    try {
      const { refusal, current } = await verifiedTarget(frozen);
      if (refusal || !sameEntry(current, frozen.installed)) {
        localDialogError = refusal ?? pageCopy.targetChanged;
        return;
      }
      const result = await installLocalAssistant(fetch, frozen.team.id, snapshot.image_id);
      await refreshInventory(frozen.team);
      localDialogOpen = false;
      showAdminNotice({
        tone: 'success',
        label: storeCopy.localInstalledLabel,
        message: $t('store.localInstalledMessage', { assistant: result.assistant, team: frozen.team.name }),
      });
    } catch (failure) {
      localDialogError = installFailure(failure, storeCopy.localFailure);
    } finally {
      busy = false;
      installingImage = '';
    }
  }

  function retryDetails() {
    detailsKey = '';
    void loadDetails(target, activeTeam, $locale);
  }

  // A dialog belongs to the page it opened on: leaving that Assistant's page closes it unless a change is running,
  // and a running change still acts only on its frozen target.
  $effect(() => {
    const current = assistantId;
    untrack(() => {
      if (busy) return;
      if (dialogTarget && dialogTarget.assistantId !== current) dialogOpen = false;
      if (localDialogTarget && localDialogTarget.assistantId !== current) localDialogOpen = false;
    });
  });
</script>

<svelte:head><title>{shownName} — Shimpz Admin</title></svelte:head>

<article class="sheet" aria-busy={loading || detailsPhase === 'loading'}>
  <header class="hero">
    <TextLink class="back" href={`/assistants/${activeTeam ? `?team=${encodeURIComponent(activeTeam.id)}` : ''}`}>
      <span aria-hidden="true">‹</span> {pageCopy.back}
    </TextLink>
    <div class="hero-row">
      <span class="icon-frame" class:is-installed={target.mode === 'installed'}>
        <AssistantIcon assistant={shownName} size={64} src={iconSrc || undefined} status={iconFailed ? 'failed' : 'loading'} loading="eager" />
      </span>
      <div class="identity">
        <h1>{shownName}</h1>
        <p class="tags">
          {#if isLocal}<span class="local">{storeCopy.localBadge}</span>{/if}
          {#if details}{#each details.creators as creator (creator)}<span>{creator}</span>{/each}{/if}
          {#if shownVersion}<span dir="ltr">v{shownVersion}</span>{/if}
          {#if target.mode === 'installed'}<span class="on"><i aria-hidden="true"></i>{pageCopy.installedHere}</span>{/if}
        </p>
      </div>
      {#if activeTeam && !loading && ['installed', 'local', 'public'].includes(target.mode)}
        <div class="cta">
          <span class="target"><span class="team-label">{pageCopy.team}</span><span class="team-name">{activeTeam.name}</span></span>
          {#if target.mode === 'installed'}
            <Button variant="danger" size="lg" disabled={busy} onclick={beginUninstall}>
              {pageCopy.uninstall}<svg class="cta-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
            </Button>
          {:else}
            <Button
              variant="primary"
              size="lg"
              disabled={busy || refused || (target.mode === 'local' && detailsPhase === 'loading')}
              aria-busy={Boolean(installingImage)}
              onclick={target.mode === 'local' ? beginLocalInstall : beginInstall}
            >
              {pageCopy.install}<svg class="cta-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7M5 6.5l3 3 3-3M3 10.5v3h10v-3" /></svg>
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  </header>

  {#if requestedTeamUnavailable}
    <Notice variant="warning">{storeCopy.teamUnavailable}</Notice>
  {:else if $teamContext.phase === 'ready' && !activeTeam}
    <Notice variant="info">{storeCopy.localNoTeam}</Notice>
  {/if}

  {#if loading}
    <Skeleton class="assistant-page-loading" height="14rem" />
  {:else if !validAssistant || target.mode === 'missing'}
    <p class="missing">{pageCopy.notFound}</p>
  {:else if target.mode === 'unverified'}
    <Notice variant="error">{pageCopy.sourcesUnavailable}</Notice>
    <div><Button variant="secondary" onclick={reloadSources}>{pageCopy.retry}</Button></div>
  {:else}
    {#if refused}
      <Notice variant="warning">{storeCopy.localRestage}</Notice>
    {:else if detailsPhase === 'error'}
      <Notice variant="error">{pageCopy.detailsUnavailable}</Notice>
      <div><Button variant="secondary" onclick={retryDetails}>{pageCopy.retry}</Button></div>
    {/if}
    {#if detailsPhase === 'loading'}
      <Skeleton class="assistant-page-loading" height="14rem" />
    {:else if pageCopyReady}
      <div class="layout" class:with-rail={links.length > 0}>
        <div class="main">
          <section class="block" aria-labelledby="assistant-summary">
            <h2 id="assistant-summary" class="title">{details.summary}</h2>
            <p class="description">{details.page.description}</p>
          </section>

          <section class="block lists" aria-label={shownName}>
            {#snippet bar(label)}
              <span class="bar"><b class="marker glitch-icon" aria-hidden="true"></b><span class="glitch-text">{label}</span><i aria-hidden="true"></i></span>
            {/snippet}
            {#if credentials.length}
              <Disclosure class="group">
                {#snippet summary()}{@render bar(pageCopy.credentials)}{/snippet}
                <ul class="rows">
                  {#each credentials as item (item.key)}
                    <li class="secret">
                      <span class="tip"><code class="slug" dir="ltr">{item.id}</code><span class="desc">{continuingText(item.text, $locale)}</span></span>
                      {#if item.helpUrl}
                        <p class="help">
                          {item.help}
                          <TextLink href={item.helpUrl} target="_blank" rel="noopener noreferrer">{pageCopy.credentialHelp} ↗</TextLink>
                        </p>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </Disclosure>
            {/if}
            {#each [['read', pageCopy.readActions, groups.read], ['write', pageCopy.writeActions, groups.write]] as [tone, label, items] (tone)}
              {#if items.length}
                <Disclosure class="group">
                  {#snippet summary()}{@render bar(label)}{/snippet}
                  <ul class="rows">
                    {#each items as action (action.id)}
                      <li class={tone}><span class="tip"><code class="slug" dir="ltr">{action.id}</code><span class="desc">{continuingText(action.description, $locale)}</span></span></li>
                    {/each}
                  </ul>
                </Disclosure>
              {/if}
            {/each}
          </section>
        </div>

        {#if links.length}
          <aside class="rail">
            <nav class="social" aria-label={pageCopy.links}>
              <ul>
                {#each links as link (link.kind)}
                  <li>
                    <ActionLink class="glitch-host" href={link.url} target="_blank" rel="noopener noreferrer" variant="secondary">
                      {#snippet icon()}<svg class="glitch-icon" viewBox="0 0 24 24"><path d={CREATOR_LINK_ICONS[link.kind]} /></svg>{/snippet}
                      <span class="glitch-text">{link.kind === 'site' ? pageCopy.site : CREATOR_LINK_NAMES[link.kind]}</span>
                    </ActionLink>
                  </li>
                {/each}
              </ul>
            </nav>
          </aside>
        {/if}
      </div>
    {/if}
  {/if}
</article>

<AssistantActionDialog
  bind:open={dialogOpen}
  title={dialogTitle}
  lead={dialogLead}
  targetLabel={dialogAction === 'uninstall' ? storeCopy.assistantDestinationTeam : actionCopy.teamLabel}
  targetName={dialogTarget?.team.name ?? ''}
  targetId={dialogTarget?.team.id ?? ''}
  error={dialogError}
  primaryLabel={dialogPrimaryLabel}
  secondaryLabel={dialogSecondaryLabel}
  primaryVisible={['install', 'uninstall', 'error'].includes(dialogMode)}
  primaryDisabled={!dialogTarget}
  {busy}
  destructive={dialogAction === 'uninstall'}
  onconfirm={confirmAssistantAction}
  oncancel={closeAssistantDialog} />

<LocalAssistantInstallDialog
  bind:open={localDialogOpen}
  snapshot={localSnapshot}
  snapshots={localDialogTarget ? [localDialogTarget.group.primary, ...localDialogTarget.group.alternatives] : []}
  team={localDialogTarget?.team ?? null}
  busy={Boolean(installingImage)}
  error={localDialogError}
  onconfirm={installLocalSnapshot}
  oncancel={closeLocalInstall}
  onselect={selectLocalSnapshot}
/>

<style>
  .sheet {
    --rule: 1px solid var(--shimpz-color-border-subtle);
    display: grid;
    /* The header band's divider sits one section step from the content on both sides. */
    gap: var(--gap-section);
    padding-block-end: var(--gap-region);
  }

  /* Header band from the sidebar to the viewport's edge, like the catalog; the action sits at its far right. */
  .hero {
    width: 100cqw;
    margin-inline: calc((100% - 100cqw) / 2);
    margin-block-start: calc(-1 * var(--shimpz-page-padding));
    padding: var(--gap-panel) var(--shimpz-page-padding) var(--gap-section);
    background: linear-gradient(180deg, color-mix(in oklab, var(--shimpz-color-cyan) 6%, var(--shimpz-color-surface)), var(--shimpz-color-bg));
    border-block-end: var(--rule);
  }

  .hero :global(a.shimpz-text-link.back) {
    display: inline-block;
    margin-block-end: var(--gap-panel);
    color: var(--shimpz-color-text-dim);
    font: 600 0.68rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-decoration: none;
    text-transform: uppercase;
  }

  .hero :global(a.shimpz-text-link.back:hover),
  .hero :global(a.shimpz-text-link.back:focus-visible) { color: var(--shimpz-color-cyan); }

  .hero-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--gap-panel);
  }

  .cta { display: grid; justify-items: end; gap: var(--gap-item); }
  .cta-icon { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: square; }
  .target { display: grid; justify-items: end; gap: var(--gap-inside); }
  .team-label { color: var(--shimpz-color-text-dim); font: 600 0.6rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .team-name { color: var(--shimpz-color-text); font: 700 1.15rem/1 var(--shimpz-font-mono); letter-spacing: -0.02em; }
  .icon-frame {
    display: grid;
    place-items: center;
    width: 6rem;
    height: 6rem;
    background: var(--shimpz-color-bg);
    clip-path: var(--shimpz-control-shape);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--shimpz-color-cyan) 30%, var(--shimpz-color-border)), var(--shimpz-glow-cyan);
  }

  .icon-frame.is-installed { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--shimpz-color-green) 50%, var(--shimpz-color-border)); }

  h1 {
    margin: 0;
    color: var(--shimpz-color-text);
    font: 700 2.25rem/1.05 var(--shimpz-font-mono);
    letter-spacing: -0.04em;
    overflow-wrap: anywhere;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-item) var(--gap-group);
    margin: var(--gap-item) 0 0;
    color: var(--shimpz-color-text-dim);
    font: 600 0.66rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .tags .local { color: var(--shimpz-color-yellow); }
  .tags .on { display: inline-flex; align-items: center; gap: var(--gap-inside); color: var(--shimpz-color-green); }
  .tags i { width: 0.42rem; height: 0.42rem; background: var(--shimpz-color-green); box-shadow: 0 0 0.45rem var(--shimpz-color-green); }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--gap-region);
  }

  .layout.with-rail { grid-template-columns: minmax(0, 1fr) minmax(17rem, 21rem); }

  .main { display: grid; gap: var(--gap-section); min-width: 0; }
  .block { display: grid; gap: var(--gap-item); max-width: 50rem; }
  .lists { gap: var(--gap-item); }

  .title {
    margin: 0;
    color: var(--shimpz-color-text);
    font: 650 1.2rem/1.3 var(--shimpz-font-sans);
    letter-spacing: -0.025em;
  }

  .description { max-width: 64ch; margin: 0; color: var(--shimpz-color-text-muted); font-size: 1rem; line-height: 1.65; text-wrap: pretty; }

  /* Each list folds behind one line: closed by default, no box and no rules, so the page reads as one column. */
  .lists :global(details.shimpz-disclosure.group) {
    display: grid;
    padding: 0;
    border: 0;
  }

  .lists :global(details.group > [data-slot='disclosure-content']) { margin: 0; }

  /* Each fold line wears the design system's secondary link-button look (the same as the Creator's links): raised
     surface, a slim faint cyan border, the control's cut shape, mono uppercase cyan; hover inverts like the kit. */
  .lists :global(details.group > summary) {
    display: block;
    width: auto;
    min-height: var(--shimpz-control-height-md);
    padding: 0 0.9rem;
    background: var(--shimpz-color-surface-raised);
    border: 0.5px solid color-mix(in oklab, var(--shimpz-color-cyan) 30%, transparent);
    clip-path: var(--shimpz-control-shape);
    color: var(--shimpz-color-cyan);
    font: 700 0.72rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.07em;
    text-transform: uppercase;
    list-style: none;
    cursor: pointer;
  }

  .lists :global(details.group > summary::-webkit-details-marker) { display: none; }
  .lists :global(details.group > summary:hover) { color: var(--shimpz-color-bg); background: var(--shimpz-color-text); border-color: var(--shimpz-color-text); box-shadow: var(--shimpz-glow-cyan); }
  .lists :global(details.group > summary:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: 3px; box-shadow: var(--shimpz-focus-ring); }

  /* The Admin's one hover glitch (app.css) runs on the fold line it is hovered or focused through. */
  .lists :global(details.group > summary:is(:hover, :focus-visible) .glitch-text) {
    text-shadow: var(--glitch-split-text);
    animation: admin-glitch-text 280ms steps(1, end);
  }

  .lists :global(details.group > summary:is(:hover, :focus-visible) .glitch-icon) {
    filter: var(--glitch-split-icon);
    animation: admin-glitch-icon 280ms steps(1, end);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap-item);
    min-height: var(--shimpz-control-height-md);
  }

  /* A hollow cut square that fills when the list opens; the toggle reads + or −. */
  .marker {
    width: 0.5rem;
    height: 0.5rem;
    clip-path: polygon(0 0, 100% 0, 100% 60%, 60% 100%, 0 100%);
    background: currentColor;
    mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
    padding: 1px;
  }

  .lists :global(details[open] .marker) { mask: none; }
  .bar i { margin-inline-start: auto; font: 500 0.95rem/1 var(--shimpz-font-mono); font-style: normal; }
  .bar i::before { content: '+'; }
  .lists :global(details[open] .bar i::before) { content: '−'; }

  /* Contents read like a terminal tree under their fold line: neutral ink, a drawn branch per item, the slug as its
     machine name. */
  .rows { margin: var(--gap-item) 0 0; padding: 0; list-style: none; }

  .rows li {
    position: relative;
    --tree: calc(0.9rem + 1rem);
    --elbow: calc(var(--gap-inside) + 0.57rem);
    display: grid;
    grid-template-columns: var(--tree) minmax(0, 1fr);
    align-items: start;
    /* Rows sit one inside step apart; the padding (not a gap) keeps the trunk unbroken between them. */
    padding-block-end: var(--gap-inside);
  }

  .rows li:last-child { padding-block-end: 0; }

  /* The branches are drawn, not typed, so the trunk runs unbroken from item to item and stops at the last elbow. */
  .rows li::before,
  .rows li::after { content: ''; position: absolute; inset-inline-start: calc(0.9rem + 0.24rem); background: color-mix(in oklab, var(--shimpz-color-text-dim) 38%, transparent); }
  .rows li::before { top: 0; bottom: 0; width: 0.5px; }
  .rows li:first-child::before { top: calc(-1 * var(--gap-item) - 1rem); }
  .rows li:last-child::before { bottom: auto; height: var(--elbow); }
  .rows li:only-child::before { height: calc(var(--elbow) + var(--gap-item) + 1rem); }
  /* The branch runs almost into its row, stopping 2px short. */
  .rows li::after { top: var(--elbow); width: calc(var(--tree) - 0.9rem - 0.24rem - 2px); height: 0.5px; }

  /* Each item is one readout line: its machine name, then its plain-language description. */
  .slug { flex: none; margin-inline-end: var(--gap-item); color: var(--shimpz-color-cyan); font: inherit; }
  .slug::after { content: ':'; }
  .desc { min-width: 0; }
  /* A secret's help sits under its readout line in plain prose, ending in the one link to where it is made. */
  .help {
    grid-column: 2;
    max-width: 64ch;
    margin: var(--gap-inside) 0 0;
    padding-inline-start: var(--gap-item);
    color: var(--shimpz-color-text-muted);
    font-size: 0.84rem;
    line-height: 1.55;
    text-wrap: pretty;
  }

  /* Neutral ink: cut corners and faint scanlines, no border. */
  .tip {
    --cut: 0.5rem;
    display: flex;
    grid-column: 2;
    align-items: baseline;
    justify-self: start;
    max-width: 100%;
    padding: var(--gap-inside) var(--gap-item);
    background:
      repeating-linear-gradient(0deg, color-mix(in oklab, var(--shimpz-color-text) 4%, transparent) 0 1px, transparent 1px 3px),
      color-mix(in oklab, var(--shimpz-color-bg) 95%, var(--shimpz-color-text));
    clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut)));
    color: var(--shimpz-color-text);
    font: 500 0.78rem/1.45 var(--shimpz-font-mono);
    letter-spacing: 0.01em;
  }

  /* The Creator's links: one design-system link button per row, named by its network, full width. */
  .rail {
    position: sticky;
    top: var(--gap-panel);
    display: grid;
    gap: var(--gap-group);
    padding: var(--gap-panel);
    background: var(--shimpz-color-surface);
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut-lg)) 0, 100% var(--shimpz-cut-lg), 100% 100%, var(--shimpz-cut-lg) 100%, 0 calc(100% - var(--shimpz-cut-lg)));
    box-shadow: inset 0 0 0 1px var(--shimpz-color-border);
  }

  .social ul { display: grid; gap: var(--gap-item); margin: 0; padding: 0; list-style: none; }
  .social :global(.shimpz-action-link) {
    --link-border: color-mix(in oklab, var(--shimpz-color-cyan) 30%, transparent);
    width: 100%;
    justify-content: flex-start;
    border-width: 0.5px;
  }
  .social svg { width: 1rem; height: 1rem; fill: currentColor; }

  .missing { margin: 0; color: var(--shimpz-color-text-muted); }

  @media (max-width: 1080px) {
    .layout.with-rail { grid-template-columns: minmax(0, 1fr); }
    .rail { position: static; max-width: 46rem; }
  }

  @media (max-width: 820px) {
    .hero-row { grid-template-columns: auto minmax(0, 1fr); gap: var(--gap-group); }
    .icon-frame { width: 4.5rem; height: 4.5rem; }
    h1 { font-size: 1.6rem; }
    .cta { grid-column: 1 / -1; justify-items: stretch; }
    .target { justify-items: center; }
    .cta :global(.shimpz-button) { width: 100%; }
    .title { font-size: 1.2rem; }
  }
</style>
