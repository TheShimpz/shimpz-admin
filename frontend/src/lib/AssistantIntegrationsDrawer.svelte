<script>
  import {
    Button,
    Card,
    Drawer,
    EmptyState,
    Notice,
    ScrollArea,
    Toolbar,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';
  import { assistantIntegrationProviderLabel } from '$lib/localChat.js';

  let {
    open = false,
    integrations = [],
    synced = false,
    pending = undefined,
    working = '',
    onclose = undefined,
    onconnect = undefined,
  } = $props();

  let closeButton = $state();
  let expandedAssistantId = $state('');
  let provider = $derived(pending?.requirements?.[0]?.provider ?? '');
  let providerLabel = $derived(assistantIntegrationProviderLabel(provider));
  let copy = $derived($t('assistantIntegrations'));
  let groups = $derived.by(() => {
    const grouped = new Map();
    for (const integration of integrations) {
      if (grouped.has(integration.assistant_id)) continue;
      grouped.set(integration.assistant_id, {
        id: integration.assistant_id,
        name: integration.assistant_name,
        summary: integration.assistant_summary,
        version: integration.assistant_version,
      });
    }
    return [...grouped.values()];
  });

  function toggleAssistant(assistantId) {
    expandedAssistantId = expandedAssistantId === assistantId ? '' : assistantId;
  }

  async function connect(challengeId) {
    try {
      await onconnect?.(challengeId);
    } catch {
      // The parent exposes the localized failure in the persistent chat error area.
    }
  }

  function handleKeydown(event) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      onclose?.();
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
    <Button bind:element={closeButton} variant="ghost" size="icon" type="button" onclick={() => onclose?.()} aria-label={copy.closeDrawer}>×</Button>
  </header>

  <p class="drawer-lead">{copy.drawerLead}</p>

  <ScrollArea class="integration-content">
    <div class="integration-status" aria-live="polite">
      {#if pending}
        <Notice class="pending" variant="warning">
          <strong>{copy.pendingTitle}</strong>
          <p>{$t('assistantIntegrations.pendingLead', { provider: providerLabel })}</p>
          <Toolbar>
            <Button type="button" disabled={working === 'connect'} onclick={() => connect(pending.challenge_id)}>
              {working === 'connect'
                ? $t('assistantIntegrations.connecting', { provider: providerLabel })
                : copy.connect}
            </Button>
          </Toolbar>
        </Notice>
      {/if}

      {#if !synced}
        <EmptyState compact title={copy.loading} />
      {:else if groups.length === 0}
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
          <Card
            class="assistant-group"
            title={assistant.name}
            description={`v${assistant.version}`}
            padding="compact"
            aria-label={assistant.name}
            {action}
          >
            <div id={detailsId} class="assistant-details" hidden={!expanded}>
              <p>{assistant.summary}</p>
            </div>
          </Card>
        {/each}
      </div>
    {/if}
  </ScrollArea>
</Drawer>

<style>
  :global([data-slot="drawer"]#assistant-integrations-drawer) { min-height: 0; grid-template-rows: auto auto minmax(0, 1fr); gap: 0.75rem; overflow: hidden; }
  :global([data-slot="drawer"]#assistant-integrations-drawer:not([hidden])) { display: grid; }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.75rem; }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header p { margin: 0 0 0.25rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  :global([data-slot="drawer"]#assistant-integrations-drawer) > header h2 { margin: 0; font-size: 1rem; }
  .drawer-lead { margin: 0; color: var(--text-faint); font-size: 0.68rem; line-height: 1.5; }
  :global(.integration-content) { min-height: 0; padding-inline-end: 0.25rem; }
  :global(.pending) { display: grid; gap: 0.45rem; margin-bottom: 0.9rem; }
  :global(.pending strong) { color: var(--warn); font-family: var(--font-mono); font-size: 0.66rem; text-transform: uppercase; }
  :global(.pending p) { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  .assistant-groups { display: grid; gap: 0.8rem; }
  :global(.assistant-group > [data-slot="card-header"]) { position: relative; border-bottom: 1px solid var(--border); background: var(--surface-2); }
  :global(.assistant-group [data-slot="card-title"]) { font-size: 0.82rem; }
  :global(.assistant-group [data-slot="card-description"]) { color: var(--accent); font-family: var(--font-mono); font-size: 0.56rem; overflow-wrap: anywhere; }
  :global(.assistant-group > [data-slot="card-content"]) { padding: 0; }
  :global(.assistant-toggle.shimpz-button) { color: var(--accent); border-color: transparent; }
  :global(.assistant-toggle.shimpz-button::after) { content: ''; position: absolute; inset: 0; }
  :global(.assistant-toggle svg) { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-linecap: square; stroke-linejoin: miter; stroke-width: 1.75; transition: transform var(--duration-fast) var(--ease); }
  :global(.assistant-toggle[aria-expanded="true"] svg) { transform: rotate(180deg); }
  .assistant-details[hidden] { display: none; }
  .assistant-details p { margin: 0; padding: 0.75rem; color: var(--text-dim); font-size: 0.66rem; line-height: 1.5; }
  @media (max-width: 420px) {
    :global(.assistant-group > [data-slot="card-header"]) { flex-direction: row; align-items: center; }
  }
</style>
