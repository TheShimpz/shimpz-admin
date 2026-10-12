<script>
  import { page } from '$app/state';
  import { getContext, onMount, tick, untrack } from 'svelte';
  import { Button, Notice, Skeleton, Toolbar } from '@shimpz/frontend';
  import AssistantRow from '#lib/AssistantRow.svelte';
  import { publicCatalog, snapshotSummary, stagedSnapshots, syncedFamily } from '#lib/assistantSources.js';
  import { INITIAL_VIEW_READINESS } from '#lib/initialView.js';
  import { locale, t } from '#lib/i18n.js';
  import { loadLocalAssistantIcon, loadPublicAssistantIcon } from '#lib/localAssistantIcons.js';
  import { groupLocalAssistantSnapshots, projectPublishedAssistants } from '#lib/localSnapshots.js';
  import { teamContext } from '#lib/teamContext.js';
  import { TEAM_ID_RE } from '#lib/validate.js';

  const ICON_PRESENTATION_BUDGET_MS = 1500;
  // How long an icon request may stay open after its presentation budget: a slow host still delivers it, a request that
  // never answers does not hold its connection forever.
  const ICON_REQUEST_LIMIT_MS = 30_000;

  // The staged snapshots and the public catalog in the interface language, each a synced value (ADR-0114): read while
  // the page shows them, again whenever one is staged or removed, and again after a failure that clears by itself.
  const snapshots = stagedSnapshots();
  let catalog = $derived(publicCatalog($locale));
  // A staged snapshot's summary per interface language, read by Team from the snapshot's own pack (ADR-0091).
  const summaryFamily = syncedFamily((key) => {
    const [language, imageId] = key.split('|');
    return snapshotSummary(imageId, language);
  });
  // The catalog last read, with its language: switching the language keeps it on screen until the new one is read.
  let shownCatalog = $state(null);
  $effect(() => {
    if ($catalog.status === 'ready') shownCatalog = { locale: $locale, assistants: $catalog.value };
  });

  let catalogIconUrls = $state({});
  // Keys whose icon could not be presented; their cards stop showing a loading face.
  let catalogIconFailures = $state({});
  const initialViewReadiness = getContext(INITIAL_VIEW_READINESS);
  let copy = $derived($t('assistantStore'));
  let localCopy = $derived($t('store'));
  let pageCopy = $derived($t('assistantPage'));
  let runningTeams = $derived($teamContext.teams.filter((team) => team.status === 'running'));
  // Unknown until read. A failure is said once it happens, while the value keeps reading again on its own (a failure
  // that clears by itself) or until the person asks (a refusal); the page never waits on a failed source.
  let localFailure = $derived($snapshots.status === 'error' ? $snapshots.error : $snapshots.status === 'loading' ? $snapshots.failing : null);
  let publicFailure = $derived($catalog.status === 'error' ? $catalog.error : $catalog.status === 'loading' ? $catalog.failing : null);
  let localSettled = $derived($snapshots.status === 'ready' || Boolean(localFailure));
  let publicSettled = $derived(shownCatalog !== null || Boolean(publicFailure));
  let localSnapshotGroups = $derived(groupLocalAssistantSnapshots($snapshots.value ?? []));
  let publicAssistants = $derived(shownCatalog?.assistants ?? []);
  let visiblePublicAssistants = $derived(projectPublishedAssistants(publicAssistants, localSnapshotGroups, localSettled));
  let catalogPresentationPending = $derived(!localSettled || !publicSettled);
  let catalogBusy = $derived(catalogPresentationPending || $snapshots.status === 'loading' || $catalog.status === 'loading');
  let localSnapshotError = $derived(localFailure ? boundedFailure(localFailure, localCopy.localFailure) : '');
  let publicCatalogError = $derived(publicFailure ? boundedFailure(publicFailure, copy.genericFailure) : '');
  let summaryKeys = $derived(
    $locale === 'en' ? [] : localSnapshotGroups.map((group) => summaryKey($locale, group.primary)),
  );
  let summaryStates = $derived(summaryFamily.of(summaryKeys));
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
  // Every icon the shown rows need, keyed by exactly what it shows.
  let iconEntries = $derived(catalogPresentationPending ? [] : [
    ...localSnapshotGroups.map((group) => ({ key: localIconKey(group.primary), local: group.primary.image_id })),
    ...visiblePublicAssistants.map((assistant) => ({ key: publicIconKey(assistant), public: assistant.assistant_id })),
  ]);

  // Each row opens its Assistant's page for the Team this catalog acts for.
  function assistantHref(assistantId) {
    const team = activeTeamRecord?.id;
    return `/assistants/${assistantId}${team ? `?team=${encodeURIComponent(team)}` : ''}`;
  }

  function summaryKey(language, snapshot) {
    return `${language}|${snapshot.image_id}`;
  }

  // English is the snapshot's catalog summary itself; any other language shows only its pack translation.
  function localSnapshotSummary(snapshot) {
    if ($locale === 'en') return snapshot.summary;
    return $summaryStates[summaryKey($locale, snapshot)]?.value ?? '';
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

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Icons are images, read over HTTP once per key the rows show. A key no longer shown releases its image and drops an
  // icon still on its way; past the presentation budget an icon still on its way shows as unavailable, never as a
  // substitute mark, and one that arrives late replaces that mark.
  const iconRequests = new Map();
  const iconBudgets = new Set();
  $effect(() => {
    const entries = iconEntries;
    untrack(() => presentIcons(entries));
  });

  function presentIcons(entries) {
    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [key, controller] of iconRequests) {
      if (wanted.has(key)) continue;
      controller.abort();
      iconRequests.delete(key);
    }
    for (const [key, url] of Object.entries(catalogIconUrls)) {
      if (wanted.has(key)) continue;
      URL.revokeObjectURL(url);
      delete catalogIconUrls[key];
      delete catalogIconFailures[key];
    }
    const missing = entries.filter((entry) => !catalogIconUrls[entry.key] && !iconRequests.has(entry.key));
    if (!missing.length) return;
    for (const entry of missing) void loadIcon(entry);
    const budget = globalThis.setTimeout(() => {
      iconBudgets.delete(budget);
      for (const entry of missing) {
        if (!catalogIconUrls[entry.key] && iconRequests.has(entry.key)) catalogIconFailures[entry.key] = true;
      }
    }, ICON_PRESENTATION_BUDGET_MS);
    iconBudgets.add(budget);
  }

  async function loadIcon(entry) {
    const controller = new AbortController();
    iconRequests.set(entry.key, controller);
    const limit = globalThis.setTimeout(() => controller.abort(), ICON_REQUEST_LIMIT_MS);
    try {
      const icon = entry.local
        ? await loadLocalAssistantIcon(fetch, entry.local, { signal: controller.signal })
        : await loadPublicAssistantIcon(fetch, entry.public, { signal: controller.signal });
      const url = await decodedIconUrl(icon, controller.signal);
      if (iconRequests.get(entry.key) !== controller) {
        URL.revokeObjectURL(url);
        return;
      }
      catalogIconUrls[entry.key] = url;
      delete catalogIconFailures[entry.key];
    } catch {
      if (iconRequests.get(entry.key) === controller) catalogIconFailures[entry.key] = true;
    } finally {
      globalThis.clearTimeout(limit);
      if (iconRequests.get(entry.key) === controller) iconRequests.delete(entry.key);
    }
  }

  // The first view settles once the catalog is presented and painted.
  let viewSettled = false;
  $effect(() => {
    if (catalogPresentationPending || viewSettled) return;
    viewSettled = true;
    void tick().then(nextPaint).then(() => initialViewReadiness?.settleAssistants?.());
  });

  onMount(() => () => {
    for (const budget of iconBudgets) globalThis.clearTimeout(budget);
    for (const controller of iconRequests.values()) controller.abort();
    iconRequests.clear();
    for (const url of Object.values(catalogIconUrls)) URL.revokeObjectURL(url);
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
          summary={shownCatalog?.locale === $locale ? assistant.summary : ''}
          iconSrc={catalogIconUrls[publicIconKey(assistant)]}
          iconStatus={catalogIconFailures[publicIconKey(assistant)] ? 'failed' : 'loading'}
          badge={localCopy.publicBadge}
          installed={installedIds.has(assistant.assistant_id)}
          installedLabel={pageCopy.installedState}
        />
      {/each}
    {/if}
  </div>

  {#if localSnapshotError || publicCatalogError}
    <Toolbar class="catalog-actions">
      {#if localSnapshotError}
        <Button variant="secondary" type="button" onclick={() => snapshots.refresh()}>{localCopy.localRetry}</Button>
      {/if}
      {#if publicCatalogError}
        <Button variant="secondary" type="button" onclick={() => catalog.refresh()}>{copy.retryStore}</Button>
      {/if}
    </Toolbar>
  {/if}
</section>

<style>
  /* From the sidebar to the viewport's edge: the header starts where every row's icon does, one page step in. */
  .assistant-catalog {
    display: grid;
    gap: var(--gap-item);
    width: 100cqw;
    margin-inline: calc((100% - 100cqw) / 2);
    padding-inline: var(--shimpz-page-padding);
  }
  /* Two per row, edge to edge; each row keeps the page step inside. */
  .assistant-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-inline: calc(-1 * var(--shimpz-page-padding));
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
