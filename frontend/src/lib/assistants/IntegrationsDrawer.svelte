<script>
  import {
    AssistantIcon,
    Button,
    Card,
    Drawer,
    EmptyState,
    Notice,
    ScrollArea,
    Toolbar,
  } from '@shimpz/frontend';
  import { untrack } from 'svelte';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { installedIconUrl } from '#lib/assistants/icons.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { installedSummary } from '#lib/assistants/sources.js';
  import { locale, t } from '#lib/i18n/index.js';
  import {
    assistantIntegrationProviderLabel,
    clearAssistantStoredInput,
    teamIntegrations,
  } from '#lib/assistants/integrations.js';
  import { refreshTeamInventory, teamContext } from '#lib/teams/context.js';

  let {
    open = false,
    teamId = '',
    pending = undefined,
    // The Integration authorization the page has in flight, named `assistant/integration`.
    authorizing = '',
    onclose,
    onconnect,
    // Says a failure in the chat's error area: its message and its detail.
    onerror,
  } = $props();

  // The Team's Integrations and Stored Inputs while the drawer is open, each a synced value (ADR-0114); closing the
  // drawer forgets them.
  let sources = $state(null);
  let integrationsState = $state(null);
  let storedInputsState = $state(null);
  let storedInputWorking = $state('');
  let working = $derived(authorizing || storedInputWorking);

  $effect(() => {
    const shownTeamId = open ? teamId : '';
    if (!shownTeamId) {
      sources = null;
      integrationsState = null;
      storedInputsState = null;
      return undefined;
    }
    const read = teamIntegrations(shownTeamId);
    sources = read;
    const stops = [
      read.integrations.subscribe((state) => { integrationsState = { teamId: shownTeamId, ...state }; }),
      read.storedInputs.subscribe((state) => { storedInputsState = { teamId: shownTeamId, ...state }; }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  });

  // A clear in flight belongs to the Team it was asked for: another Team's drawer is free to act.
  $effect(() => {
    void teamId;
    storedInputWorking = '';
  });

  // What the drawer shows: both read for the Team, and every Assistant they name in the Team's inventory. One that names
  // an Assistant the inventory does not list yet waits for the inventory's next read.
  let view = $derived.by(() => {
    const listed = integrationsState?.teamId === teamId ? integrationsState.value : null;
    const stored = storedInputsState?.teamId === teamId ? storedInputsState.value : null;
    if (!listed || !stored) return { ready: false, integrations: [], storedInputs: [], unknown: false };
    const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
    const unknown = listed.some((integration) => !installed.has(integration.assistant_id)) ||
      stored.some((item) => !installed.has(item.assistant_id));
    return unknown
      ? { ready: false, integrations: [], storedInputs: [], unknown: true }
      : { ready: true, integrations: listed, storedInputs: stored, unknown: false };
  });
  let integrations = $derived(view.integrations);
  let storedInputs = $derived(view.storedInputs);
  let synced = $derived(view.ready);

  // An Assistant the Integrations name but the inventory does not: the inventory is read again, and an inventory read
  // that still does not list it says the drawer cannot be shown.
  let inventoryChecked = '';
  $effect(() => {
    if (!view.unknown) {
      inventoryChecked = '';
      return;
    }
    const checkedTeamId = teamId;
    if (inventoryChecked === checkedTeamId) return;
    inventoryChecked = checkedTeamId;
    void refreshTeamInventory().catch(() => {}).then(() => {
      if (teamId === checkedTeamId && view.unknown) onerror(copy.inventoryFailed, '');
    });
  });

  // A refused read of either is said once; an outage is retried on its own and is the shell's to say.
  $effect(() => {
    const refused = [integrationsState, storedInputsState].find((state) => state?.status === 'error');
    if (refused && refused.teamId === teamId) {
      onerror(copy.inventoryFailed, refused.error?.message ?? copy.inventoryFailed);
    }
  });

  let closeButton = $state();
  let expandedAssistantId = $state('');
  let copy = $derived($t('assistantIntegrations'));
  let groups = $derived.by(() => {
    const grouped = new Map();
    for (const integration of integrations) {
      if (grouped.has(integration.assistant_id)) continue;
      grouped.set(integration.assistant_id, {
        id: integration.assistant_id,
        name: integration.assistant_name,
        version: integration.assistant_version,
      });
    }
    return [...grouped.values()];
  });

  // The Team's own installed-icon route; sources exist only while the drawer is open so a closed drawer fetches none.
  function iconSource(assistantId) {
    if (!open || !teamId) return undefined;
    return installedIconUrl(teamId, assistantId);
  }

  // The expanded Assistant's summary in the interface language, read by Team from its binding's pack (ADR-0091) as a
  // synced value of that Team's inventory; one that cannot be read in that language stays empty rather than showing
  // another language. A closed drawer reads none.
  const NO_SUMMARY = { subscribe: (run) => { run({ status: 'loading', value: null, error: null }); return () => {}; } };
  let summaryKey = $derived(open && teamId && expandedAssistantId ? `${teamId}|${expandedAssistantId}|${$locale}` : '');
  let summarySource = $derived.by(() => {
    const key = summaryKey;
    return untrack(() => (key ? installedSummary(teamId, expandedAssistantId, $locale) : NO_SUMMARY));
  });
  let expandedSummary = $derived($summarySource.value ?? '');

  function toggleAssistant(assistantId) {
    expandedAssistantId = expandedAssistantId === assistantId ? '' : assistantId;
  }

  async function connect(challengeId, requirement) {
    try {
      await onconnect(challengeId, requirement);
    } catch {
      // The parent exposes the localized failure in the persistent chat error area.
    }
  }

  async function clearStoredInput(item) {
    const clearedTeamId = teamId;
    const key = `${item?.assistant_id}/${item?.stored_input_id}`;
    if (
      !clearedTeamId ||
      storedInputWorking ||
      !storedInputs.some((candidate) => (
        candidate.assistant_id === item?.assistant_id &&
        candidate.stored_input_id === item?.stored_input_id &&
        candidate.status === 'stored'
      ))
    ) return;
    storedInputWorking = key;
    const read = sources;
    try {
      await clearAssistantStoredInput(clearedTeamId, item.assistant_id, item.stored_input_id);
      // What the drawer shows next is the Stored Inputs read after Admin announces the change, never this answer.
      if (read?.teamId === clearedTeamId) await read.storedInputs.refresh();
    } catch (reason) {
      if (teamId !== clearedTeamId) return;
      // A change Admin never confirmed before it disconnected may or may not have happened.
      const detail = outcomeUnknown(reason)
        ? $t('shell.outcomeUnknown')
        : reason instanceof Error ? reason.message : copy.storedInputClearFailed;
      onerror(copy.storedInputClearFailed, detail);
    } finally {
      if (teamId === clearedTeamId) storedInputWorking = '';
    }
  }

  function handleKeydown(event) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }

  $effect(() => {
    if (!open) {
      expandedAssistantId = '';
      return;
    }
    const button = closeButton;
    queueMicrotask(() => button?.focus());
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<Drawer id="assistant-integrations-drawer" labelledBy="assistant-integrations-title" {open}>
  <header>
    <div>
      <p>{copy.drawerKicker}</p>
      <h2 id="assistant-integrations-title">{copy.drawerTitle}</h2>
    </div>
    <Button bind:element={closeButton} variant="ghost" size="icon" type="button" onclick={() => onclose()} aria-label={copy.closeDrawer}>×</Button>
  </header>

  <p class="drawer-lead">{copy.drawerLead}</p>

  <ScrollArea class="integration-content">
    <div class="integration-status" aria-live="polite">
      {#if pending}
        <Notice class="pending" variant="warning">
          <strong>{copy.pendingTitle}</strong>
          {#each pending.requirements as requirement (`${requirement.assistant_id}/${requirement.integration_id}`)}
            {@const requirementKey = `${requirement.assistant_id}/${requirement.integration_id}`}
            {@const requirementProvider = assistantIntegrationProviderLabel(requirement.provider)}
            <div class="pending-requirement">
              <p>{$t('assistantIntegrations.pendingLead', { provider: requirementProvider })}</p>
              <Toolbar>
                <Button
                  type="button"
                  disabled={Boolean(working) || !$commandsReady}
                  aria-label={`${$t('assistantIntegrations.authorize', { provider: requirementProvider })} — ${requirement.name}`}
                  onclick={() => connect(pending.challenge_id, requirement)}
                >
                  {working === requirementKey
                    ? $t('assistantIntegrations.connecting', { provider: requirementProvider })
                    : $t('assistantIntegrations.authorize', { provider: requirementProvider })}
                </Button>
              </Toolbar>
            </div>
          {/each}
        </Notice>
      {/if}

      {#if !synced}
        <EmptyState compact title={copy.loading} />
      {:else if groups.length === 0 && storedInputs.length === 0}
        <EmptyState compact title={copy.empty} />
      {/if}
    </div>

    {#if synced && groups.length > 0}
      <div class="assistant-groups">
        {#each groups as assistant (assistant.id)}
          {@const expanded = expandedAssistantId === assistant.id}
          {@const detailsId = `assistant-integration-group-${assistant.id}`}
          {#snippet action()}
            <Button
              class="assistant-toggle"
              variant="ghost"
              size="icon"
              type="button"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={$t(
                expanded
                  ? 'assistantIntegrations.collapseAssistant'
                  : 'assistantIntegrations.expandAssistant',
                { assistant: assistant.name },
              )}
              onclick={() => toggleAssistant(assistant.id)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Button>
          {/snippet}
          {#snippet header()}
            <div class="assistant-heading">
              <AssistantIcon assistant={assistant.id} src={iconSource(assistant.id)} size={36} />
              <div>
                <h3 data-slot="card-title">{assistant.name}</h3>
                <p data-slot="card-description">v{assistant.version}</p>
              </div>
            </div>
          {/snippet}
          <Card
            class="assistant-group"
            padding="compact"
            aria-label={assistant.name}
            {header}
            {action}
          >
            {@const summary = assistant.id === expandedAssistantId ? expandedSummary : ''}
            <div id={detailsId} class="assistant-details" hidden={!expanded}>
              {#if summary}<p>{summary}</p>{/if}
            </div>
          </Card>
        {/each}
      </div>
    {/if}

    {#if synced && storedInputs.length > 0}
      <section class="stored-inputs" aria-labelledby="assistant-stored-inputs-title">
        <h3 id="assistant-stored-inputs-title">{copy.storedInputsTitle}</h3>
        {#each storedInputs as item (`${item.assistant_id}/${item.stored_input_id}`)}
          {@const itemKey = `${item.assistant_id}/${item.stored_input_id}`}
          <div class="stored-input-row">
            <AssistantIcon assistant={item.assistant_id} src={iconSource(item.assistant_id)} size={28} loading="lazy" />
            <div>
              <strong>{$assistantName(item.assistant_id)}</strong>
              <code>{item.stored_input_id}</code>
              <span>{item.status === 'stored' ? copy.storedInputStored : copy.storedInputMissing}</span>
            </div>
            {#if item.status === 'stored'}
              <Button
                variant="danger"
                size="compact"
                type="button"
                disabled={Boolean(working) || !$commandsReady}
                onclick={() => clearStoredInput(item)}
              >
                {working === itemKey ? copy.storedInputClearing : copy.storedInputClear}
              </Button>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
  </ScrollArea>
</Drawer>

<style>
  :global([data-slot="drawer"]#assistant-integrations-drawer) { min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); gap: var(--gap-group); overflow: hidden; border-radius: 0; }
  :global([data-slot="drawer"]#assistant-integrations-drawer:not([hidden])) { display: grid; }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: var(--gap-group); }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header p { margin: 0 0 var(--gap-inside); color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header h2 { margin: 0; font-size: 1rem; }
  .drawer-lead { margin: 0; color: var(--text-faint); font-size: 0.68rem; line-height: 1.5; }
  :global(.integration-content) { min-height: 0; padding-inline-end: var(--gap-inside); }
  :global(.pending) { display: grid; gap: var(--gap-item); margin-bottom: var(--gap-group); }
  :global(.pending strong) { color: var(--warn); font-family: var(--font-mono); font-size: 0.66rem; text-transform: uppercase; }
  :global(.pending p) { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  .pending-requirement { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--gap-item); border-top: 1px solid var(--border); border-radius: 0; padding-top: var(--gap-item); }
  .assistant-groups { display: grid; gap: var(--gap-group); }
  :global(.assistant-group > [data-slot="card-header"]) { position: relative; border-bottom: 1px solid var(--border); border-radius: 0; background: var(--surface-2); }
  /* The heading is presentation under the full-row toggle, so a click on the icon or name still reaches the toggle. */
  .assistant-heading { display: flex; min-width: 0; align-items: center; gap: var(--gap-item); pointer-events: none; }
  .assistant-heading > div { display: grid; min-width: 0; gap: var(--gap-inside); }
  :global(.assistant-group) h3[data-slot="card-title"] { margin: 0; font: 700 0.82rem/1.3 var(--shimpz-font-mono); letter-spacing: -0.015em; overflow-wrap: anywhere; }
  :global(.assistant-group) p[data-slot="card-description"] { margin: 0; }
  :global(.assistant-group [data-slot="card-description"]) { color: var(--accent); font-family: var(--font-mono); font-size: 0.56rem; overflow-wrap: anywhere; }
  :global(.assistant-group [data-slot="card-action"]) { width: var(--shimpz-control-height-md); }
  :global(.assistant-group > [data-slot="card-content"]) { padding: 0; }
  :global(.assistant-toggle.shimpz-button) { position: absolute; inset: 0; width: 100%; min-height: 100%; justify-content: flex-end; padding-inline: var(--gap-group); color: var(--accent); background: transparent; border-color: transparent; clip-path: none; }
  :global(.assistant-toggle.shimpz-button:hover:not(:disabled)) { color: var(--accent); background: transparent; border-color: transparent; box-shadow: none; }
  :global(.assistant-toggle svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-linecap: square; stroke-linejoin: miter; stroke-width: 1.75; }
  :global(.assistant-toggle[aria-expanded="true"] svg) { transform: rotate(180deg); }
  .assistant-details[hidden] { display: none; }
  .assistant-details p { margin: 0; padding: var(--gap-item) var(--gap-group); color: var(--text-dim); font-size: 0.66rem; line-height: 1.5; }
  .stored-inputs { display: grid; gap: var(--gap-item); margin-top: var(--gap-group); }
  .stored-inputs h3 { margin: 0; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .stored-input-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--gap-item); border: 1px solid var(--border); padding: var(--gap-item) var(--gap-group); background: var(--surface-1); }
  .stored-input-row > div { display: grid; min-width: 0; gap: var(--gap-inside); }
  .stored-input-row strong { color: var(--text); font-size: 0.7rem; }
  .stored-input-row code { color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; overflow-wrap: anywhere; }
  .stored-input-row span { color: var(--text-faint); font-size: 0.62rem; }
  @media (max-width: 420px) {
    :global(.assistant-group > [data-slot="card-header"]) { flex-direction: row; align-items: center; }
    .pending-requirement { grid-template-columns: 1fr; }
    .stored-input-row { grid-template-columns: auto minmax(0, 1fr); }
    .stored-input-row > :global(.shimpz-button) { grid-column: 1 / -1; }
  }
</style>
