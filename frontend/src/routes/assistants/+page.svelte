<script>
  import { page } from '$app/state';
  import { getContext, onMount, tick, untrack } from 'svelte';
  import { Button, Notice, Skeleton, Toolbar } from '@shimpz/frontend';
  import AssistantRow from '$lib/AssistantRow.svelte';
  import { INITIAL_VIEW_READINESS } from '$lib/initialView.js';
  import { listLocalAssistantSnapshots, listPublicAssistantCatalog } from '$lib/localApi.js';
  import { locale, t } from '$lib/i18n.js';
  import {
    loadLocalAssistantIcon,
    loadLocalAssistantSummary,
    loadPublicAssistantIcon,
  } from '$lib/localAssistantIcons.js';
  import { groupLocalAssistantSnapshots, projectPublishedAssistants } from '$lib/localSnapshots.js';
  import { teamContext } from '$lib/teamContext.js';
  import { TEAM_ID_RE } from '$lib/validate.js';

  const ICON_PRESENTATION_BUDGET_MS = 1500;
  // How long an icon request may stay open after its presentation budget: a slow host still delivers it, a request that
  // never answers does not hold its connection forever.
  const ICON_REQUEST_LIMIT_MS = 30_000;

  let publicAssistants = $state([]);
  // The interface language the presented public catalog was read in; its summaries show only while it is selected.
  let publicCatalogLocale = $state('');
  let publicCatalogPhase = $state('loading');
  let publicCatalogError = $state('');
  let localSnapshots = $state([]);
  let localSnapshotPhase = $state('idle');
  let localSnapshotSettled = $state(false);
  let localSnapshotError = $state('');
  // A staged snapshot's summary per interface language, read by Team from the snapshot's own pack (ADR-0091).
  let localSummaries = $state({});
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
  let pageCopy = $derived($t('assistantPage'));
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  let localSnapshotGroups = $derived(groupLocalAssistantSnapshots(localSnapshots));
  let visiblePublicAssistants = $derived(
    projectPublishedAssistants(
      publicAssistants,
      localSnapshotGroups,
      localSnapshotSettled,
    ),
  );
  let catalogPresentationPending = $derived(
    !catalogPresentationSettled,
  );
  let catalogBusy = $derived(catalogPresentationPending || catalogRefreshing);
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
  // The selected Team's installed Assistants: a row marks one installed in the Team its page acts for.
  let installedIds = $derived(new Set(
    activeTeamRecord ? $teamContext.installedAssistants.map((entry) => entry.assistant) : [],
  ));
  let installedCount = $derived(
    [...localSnapshotGroups, ...visiblePublicAssistants].filter((entry) => installedIds.has(entry.assistant_id)).length,
  );

  // Each row opens its Assistant's page for the Team this catalog acts for.
  function assistantHref(assistantId) {
    const team = activeTeamRecord?.id;
    return `/assistants/${assistantId}${team ? `?team=${encodeURIComponent(team)}` : ''}`;
  }
  function localSummaryKey(language, snapshot) {
    return `${language}:${snapshot.image_id}`;
  }

  // English is the snapshot's catalog summary itself; any other language shows only its pack translation.
  function localSnapshotSummary(snapshot) {
    return $locale === 'en' ? snapshot.summary : localSummaries[localSummaryKey($locale, snapshot)] ?? '';
  }

  async function loadLocalSummaries(snapshots, language, request, signal) {
    if (language === 'en') return;
    await Promise.allSettled(snapshots.map(async (snapshot) => {
      const key = localSummaryKey(language, snapshot);
      if (localSummaries[key]) return;
      try {
        const summary = await loadLocalAssistantSummary(fetch, snapshot.image_id, language, { signal });
        if (request === catalogPresentationRequest) localSummaries[key] = summary;
      } catch {
        // An unavailable translation leaves the summary empty rather than showing another language.
      }
    }));
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
    localSnapshotError = '';
    if (!catalogPresentationSettled) localSnapshotPhase = 'loading';

    try {
      const [publicResult, localResult] = await Promise.allSettled([
        listPublicAssistantCatalog(fetch, language, controller.signal),
        listLocalAssistantSnapshots(fetch, controller.signal),
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
      publicCatalogLocale = language;
      publicCatalogPhase = nextPublicPhase;
      publicCatalogError = nextPublicError;
      localSnapshots = nextLocalSnapshots;
      localSnapshotPhase = nextLocalPhase;
      localSnapshotError = nextLocalError;
      localSnapshotSettled = true;
      catalogIconUrls = nextUrls;
      catalogIconFailures = {};
      catalogPresentationSettled = true;
      catalogRefreshing = false;
      await tick();
      await nextPaint();
      releaseObsoleteIconUrls(previousUrls, nextUrls);
      if (request !== catalogPresentationRequest) return;
      initialViewReadiness?.settleAssistants?.();

      const summaries = loadLocalSummaries(
        groups.map((group) => group.primary),
        language,
        request,
        controller.signal,
      );
      // Past the presentation budget an icon still on its way is shown as unavailable, never as a substitute mark, and
      // never as loading forever. Its request still completes, and an icon that arrives late replaces that mark.
      const iconBudget = globalThis.setTimeout(() => {
        if (request !== catalogPresentationRequest) return;
        for (const entry of entries) {
          if (!catalogIconUrls[entry.key]) catalogIconFailures[entry.key] = true;
        }
      }, ICON_PRESENTATION_BUDGET_MS);
      const iconLimit = globalThis.setTimeout(() => iconController.abort(), ICON_REQUEST_LIMIT_MS);
      await Promise.allSettled(entries.map(async (entry) => {
        if (catalogIconUrls[entry.key]) return;
        try {
          const url = await decodedIconUrl(await entry.load(), iconController.signal);
          if (request !== catalogPresentationRequest) {
            URL.revokeObjectURL(url);
            return;
          }
          catalogIconUrls[entry.key] = url;
          delete catalogIconFailures[entry.key];
        } catch {
          if (request === catalogPresentationRequest) catalogIconFailures[entry.key] = true;
        }
      }));
      globalThis.clearTimeout(iconBudget);
      globalThis.clearTimeout(iconLimit);
      controller.signal.removeEventListener('abort', abortIcons);
      await summaries;
    } finally {
      if (request === catalogPresentationRequest) catalogRefreshing = false;
    }
  }

  // The catalog and staged snapshot summaries follow the interface language and reload when it changes.
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

  {#if !catalogPresentationPending && localSnapshotGroups.length + visiblePublicAssistants.length > 0}
    <header class="catalog-header">
      <div class="catalog-team">
        <span class="team-label">{pageCopy.team}</span>
        <span class="team-name">{activeTeamRecord?.name ?? ''}</span>
      </div>
      <p class="catalog-count">
        <span class="count">{localSnapshotGroups.length + visiblePublicAssistants.length}</span> {pageCopy.assistants}
        <span class="sep" aria-hidden="true">//</span>
        <span class="count on">{installedCount}</span> {pageCopy.installed}
      </p>
    </header>
  {/if}
  <div class="assistant-grid">
    {#if catalogPresentationPending}
      <Skeleton class="assistant-catalog-loading" height="18rem" />
    {:else}
      {#each localSnapshotGroups as group (group.assistant_id)}
        <AssistantRow
          id={`assistant-${group.assistant_id}`}
          href={assistantHref(group.assistant_id)}
          name={group.primary.name}
          summary={localSnapshotSummary(group.primary)}
          iconSrc={catalogIconUrls[localIconKey(group.primary)]}
          iconStatus={catalogIconFailures[localIconKey(group.primary)] ? 'failed' : 'loading'}
          badge={localCopy.localBadge}
          badgeTone="local"
          installed={installedIds.has(group.assistant_id)}
          installedLabel={pageCopy.installedState}
        />
      {/each}

      {#each visiblePublicAssistants as assistant (assistant.assistant_id)}
        <AssistantRow
          id={`assistant-${assistant.assistant_id}`}
          href={assistantHref(assistant.assistant_id)}
          name={assistant.name}
          summary={publicCatalogLocale === $locale ? assistant.summary : ''}
          iconSrc={catalogIconUrls[publicIconKey(assistant)]}
          iconStatus={catalogIconFailures[publicIconKey(assistant)] ? 'failed' : 'loading'}
          badge={localCopy.publicBadge}
          installed={installedIds.has(assistant.assistant_id)}
          installedLabel={pageCopy.installedState}
        />
      {/each}
    {/if}
  </div>

  {#if localSnapshotPhase === 'error' || publicCatalogPhase === 'error'}
    <Toolbar class="catalog-actions">
      {#if localSnapshotPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadCatalogPresentation}>{localCopy.localRetry}</Button>
      {/if}
      {#if publicCatalogPhase === 'error'}
        <Button variant="secondary" type="button" onclick={loadCatalogPresentation}>{copy.retryStore}</Button>
      {/if}
    </Toolbar>
  {/if}
</section>

<style>
  .assistant-catalog {
    display: grid;
    gap: var(--gap-item);
  }
  /* Two per row, edge to edge across the content column. */
  .assistant-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100cqw;
    margin-inline: calc((100% - 100cqw) / 2);
  }
  .catalog-header { display: grid; gap: var(--gap-item); }
  .catalog-team { display: grid; gap: var(--gap-inside); }
  .team-label { color: var(--shimpz-color-text-dim); font: 600 0.62rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .team-name { color: var(--shimpz-color-text); font: 700 1.6rem/1.1 var(--shimpz-font-mono); letter-spacing: -0.03em; }
  /* With the catalog's item gap, the grid starts one panel step (24px) below the header it belongs to. */
  .catalog-count {
    margin: 0 0 var(--gap-group);
    color: var(--shimpz-color-text-dim);
    font: 600 0.66rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .catalog-count .count { color: var(--shimpz-color-cyan); }
  .catalog-count .on { color: var(--shimpz-color-green); }
  .catalog-count .sep { margin: 0 var(--gap-item); color: var(--shimpz-color-border); }
</style>
