<script>
  import {
    Button,
    Card,
    Drawer,
    EmptyState,
    Notice,
    ScrollArea,
    StatusBadge,
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
    ondisconnect = undefined,
  } = $props();

  let closeButton = $state();
  let provider = $derived(pending?.requirements?.[0]?.provider ?? '');
  let providerLabel = $derived(assistantIntegrationProviderLabel(provider));
  let copy = $derived($t('assistantIntegrations'));
  let pendingIdentities = $derived(new Set((pending?.requirements ?? []).map((requirement) => (
    `${requirement.assistant_id}\u0000${requirement.integration_id}`
  ))));
  let groups = $derived.by(() => {
    const grouped = new Map();
    for (const integration of integrations) {
      const group = grouped.get(integration.assistant_id) ?? {
        id: integration.assistant_id,
        name: integration.assistant_name,
        integrations: [],
      };
      group.integrations.push(integration);
      grouped.set(integration.assistant_id, group);
    }
    return [...grouped.values()];
  });

  function statusLabel(status) {
    if (status === 'connected') return copy.statusConnected;
    if (status === 'expired') return copy.statusExpired;
    if (status === 'reauthorization-required') return copy.statusReauthorization;
    return copy.statusMissing;
  }

  function integrationLabel(integration) {
    if (!integration) return copy.noIntegration;
    if (integration.username) return `@${integration.username}`;
    return integration.name ?? integration.id;
  }

  function identity(integration) {
    return `${integration.assistant_id}\u0000${integration.id}`;
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
    if (!open) return;
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

  <ScrollArea class="integration-content" aria-live="polite">
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
    {:else}
      <div class="assistant-groups">
        {#each groups as assistant (assistant.id)}
          <Card
            class="assistant-group"
            title={assistant.name}
            description={assistant.id}
            padding="compact"
            aria-label={assistant.name}
          >
            <ul>
              {#each assistant.integrations as integration (integration.id)}
                {@const itemIdentity = identity(integration)}
                <li>
                  <div class="integration-heading">
                    <strong>{integration.name}</strong>
                    <StatusBadge tone={integration.status === 'connected' ? 'success' : 'warning'}>
                      {statusLabel(integration.status)}
                    </StatusBadge>
                  </div>
                  <p>{integration.summary}</p>
                  <dl>
                    <div><dt>{copy.provider}</dt><dd>{assistantIntegrationProviderLabel(integration.provider)}</dd></div>
                    <div><dt>{copy.integration}</dt><dd>{integrationLabel(integration.integration)}</dd></div>
                    <div><dt>{copy.scopes}</dt><dd>{integration.scopes.join(' · ')}</dd></div>
                  </dl>
                  <Toolbar align="end">
                    {#if !pendingIdentities.has(itemIdentity) && integration.status !== 'missing'}
                      <Button
                        variant="danger"
                        size="compact"
                        type="button"
                        disabled={working === itemIdentity}
                        onclick={() => ondisconnect?.(integration)}
                      >{working === itemIdentity ? copy.disconnecting : copy.disconnect}</Button>
                    {/if}
                  </Toolbar>
                </li>
              {/each}
            </ul>
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
  :global(.assistant-group > [data-slot="card-header"]) { border-bottom: 1px solid var(--border); background: var(--surface-2); }
  :global(.assistant-group [data-slot="card-title"]) { font-size: 0.82rem; }
  :global(.assistant-group [data-slot="card-description"]) { color: var(--accent); font-family: var(--font-mono); font-size: 0.56rem; overflow-wrap: anywhere; }
  :global(.assistant-group > [data-slot="card-content"]) { padding: 0; }
  ul { display: grid; margin: 0; padding: 0; list-style: none; }
  li { display: grid; gap: 0.55rem; padding: 0.75rem; }
  li + li { border-top: 1px solid var(--border); }
  .integration-heading { display: flex; align-items: start; justify-content: space-between; gap: 0.6rem; }
  .integration-heading strong { font-size: 0.74rem; }
  li > p { margin: 0; color: var(--text-dim); font-size: 0.66rem; line-height: 1.5; }
  dl { display: grid; gap: 0.45rem; margin: 0; }
  dl div { display: grid; gap: 0.18rem; }
  dt { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.52rem; letter-spacing: 0.08em; text-transform: uppercase; }
  dd { margin: 0; color: var(--text); font-size: 0.62rem; overflow-wrap: anywhere; }
</style>
