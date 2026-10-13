<script>
  import { page } from '$app/state';
  import { getContext, onMount, tick, untrack } from 'svelte';
  import { Button, Notice, Skeleton, Toolbar } from '@shimpz/frontend';
  import AssistantRow from '#lib/AssistantRow.svelte';
  import { acquireIcon, localIcon, MAX_CACHED_ICONS, publicIcon } from '#lib/assistantIconCache.js';
  import { publicCatalog, snapshotSummary, stagedSnapshots, syncedFamily } from '#lib/assistantSources.js';
  import { INITIAL_VIEW_READINESS } from '#lib/shell/initialView.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { groupLocalAssistantSnapshots, projectPublishedAssistants } from '#lib/localSnapshots.js';
  import { teamContext } from '#lib/teams/context.js';
  import { TEAM_ID_RE } from '#lib/ids.js';

  const ICON_PRESENTATION_BUDGET_MS = 1500;
  // How far beyond the screen a row's icon is already shown, so scrolling meets icons that are ready.
  const NEAR_SCREEN_PX = 400;

  // The staged snapshots and the public catalog in the interface language, each a synced value the session keeps
  // (ADR-0114): shown at once when read before, read again whenever they may be stale, one is staged or removed, or a
  // failure clears by itself.
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
  // Every row's icon, keyed by exactly what it shows, in the order the rows show.
  let rowIcons = $derived(catalogPresentationPending ? [] : [
    ...localSnapshotGroups.map((group) => localIcon(group.primary)),
    ...visiblePublicAssistants.map((assistant) => publicIcon(assistant)),
  ]);
  // The rows on or near the screen, by icon key: only their icons are shown, and never more than the session's icon
  // budget holds, so a long catalog decodes its icons as they scroll in and never holds more than the budget allows.
  let nearRows = $state(new Set());
  let iconEntries = $derived(rowIcons.filter((icon) => nearRows.has(icon.key)).slice(0, MAX_CACHED_ICONS));
  let grid = $state();
  $effect(() => {
    if (!grid) return undefined;
    const near = new Set();
    const publish = () => {
      nearRows = new Set(near);
    };
    const intersections = new IntersectionObserver((records) => {
      for (const record of records) {
        if (record.isIntersecting) near.add(record.target.dataset.iconKey);
        else near.delete(record.target.dataset.iconKey);
      }
      publish();
    }, { rootMargin: `${NEAR_SCREEN_PX}px 0px` });
    // Each row is observed as it renders or changes its icon; the rows already on screen are known at once, so their
    // icons show in the first frame rather than after the observer's first report.
    const observe = () => {
      intersections.disconnect();
      near.clear();
      const bottom = window.innerHeight + NEAR_SCREEN_PX;
      for (const row of grid.querySelectorAll('a.assistant-row')) {
        intersections.observe(row);
        const box = row.getBoundingClientRect();
        if (box.bottom >= -NEAR_SCREEN_PX && box.top <= bottom) near.add(row.dataset.iconKey);
      }
      publish();
    };
    observe();
    const rows = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes' || record.target === grid)) observe();
    });
    // A row added, removed, or showing another build's icon (a staged Assistant built again keeps its row) is seen.
    rows.observe(grid, { childList: true, subtree: true, attributeFilter: ['data-icon-key'] });
    return () => {
      rows.disconnect();
      intersections.disconnect();
    };
  });

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

  function boundedFailure(error, fallback) {
    return error instanceof Error && error.name !== 'AbortError' ? error.message : fallback;
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Each icon the rows show is pinned in the session's icon cache, which shows one it holds at once and loads and decodes
  // any other; a row no longer shown unpins its icon and stops waiting for it. Past the presentation budget an icon still
  // on its way shows as unavailable, never as a substitute mark, and one that arrives late replaces that mark.
  const iconPins = new Map();
  const iconBudgets = new Set();
  $effect(() => {
    const entries = iconEntries;
    untrack(() => presentIcons(entries));
  });

  function presentIcons(entries) {
    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [key, pin] of iconPins) {
      if (wanted.has(key)) continue;
      pin.release();
      iconPins.delete(key);
      delete catalogIconUrls[key];
      delete catalogIconFailures[key];
    }
    const missing = entries.filter((entry) => !iconPins.has(entry.key));
    if (!missing.length) return;
    for (const entry of missing) showIcon(entry);
    if (missing.every((entry) => catalogIconUrls[entry.key])) return;
    const budget = globalThis.setTimeout(() => {
      iconBudgets.delete(budget);
      for (const entry of missing) {
        if (!catalogIconUrls[entry.key] && iconPins.has(entry.key)) catalogIconFailures[entry.key] = true;
      }
    }, ICON_PRESENTATION_BUDGET_MS);
    iconBudgets.add(budget);
  }

  function showIcon(icon) {
    const pin = acquireIcon(icon);
    iconPins.set(icon.key, pin);
    if (pin.cached) {
      catalogIconUrls[icon.key] = pin.cached;
      return;
    }
    pin.url.then((url) => {
      if (iconPins.get(icon.key) !== pin) return;
      catalogIconUrls[icon.key] = url;
      delete catalogIconFailures[icon.key];
    }, () => {
      if (iconPins.get(icon.key) === pin) catalogIconFailures[icon.key] = true;
    });
  }

  // The first view settles once the catalog is presented and painted.
  let viewSettled = false;
  $effect(() => {
    if (catalogPresentationPending || viewSettled) return;
    viewSettled = true;
    void tick().then(nextPaint).then(() => initialViewReadiness?.settleAssistants?.());
  });

  // Leaving unpins every icon: the session's cache keeps them for the next visit.
  onMount(() => () => {
    for (const budget of iconBudgets) globalThis.clearTimeout(budget);
    for (const pin of iconPins.values()) pin.release();
    iconPins.clear();
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
  <div class="assistant-grid" bind:this={grid}>
    {#if catalogPresentationPending}
      <Skeleton class="assistant-catalog-loading" height="18rem" />
    {:else}
      {#each localSnapshotGroups as group (group.assistant_id)}
        <AssistantRow
          id={`assistant-${group.assistant_id}`}
          href={assistantHref(group.assistant_id)}
          name={group.primary.name}
          summary={localSnapshotSummary(group.primary)}
          data-icon-key={localIcon(group.primary).key}
          iconSrc={catalogIconUrls[localIcon(group.primary).key]}
          iconStatus={catalogIconFailures[localIcon(group.primary).key] ? 'failed' : 'loading'}
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
          data-icon-key={publicIcon(assistant).key}
          iconSrc={catalogIconUrls[publicIcon(assistant).key]}
          iconStatus={catalogIconFailures[publicIcon(assistant).key] ? 'failed' : 'loading'}
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
