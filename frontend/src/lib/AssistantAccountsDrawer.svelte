<script>
  import {
    assistantAccountProviderLabel,
    assistantAccountsCopy,
  } from '$lib/assistantAccountsCopy.js';
  import { locale } from '$lib/i18n.js';

  let {
    open = false,
    accounts = [],
    synced = false,
    pending = undefined,
    working = '',
    onclose = undefined,
    onconnect = undefined,
    ondisconnect = undefined,
  } = $props();

  let closeButton = $state();
  let provider = $derived(pending?.requirements?.[0]?.provider ?? '');
  let copy = $derived(assistantAccountsCopy($locale, provider));
  let pendingIdentities = $derived(new Set((pending?.requirements ?? []).map((requirement) => (
    `${requirement.assistant_id}\u0000${requirement.account_id}`
  ))));
  let groups = $derived.by(() => {
    const grouped = new Map();
    for (const account of accounts) {
      const group = grouped.get(account.assistant_id) ?? {
        id: account.assistant_id,
        name: account.assistant_name,
        accounts: [],
      };
      group.accounts.push(account);
      grouped.set(account.assistant_id, group);
    }
    return [...grouped.values()];
  });

  function statusLabel(status) {
    if (status === 'connected') return copy.statusConnected;
    if (status === 'expired') return copy.statusExpired;
    if (status === 'reauthorization-required') return copy.statusReauthorization;
    return copy.statusMissing;
  }

  function accountLabel(account) {
    if (!account) return copy.noAccount;
    if (account.username) return `@${account.username}`;
    return account.name ?? account.id;
  }

  function identity(account) {
    return `${account.assistant_id}\u0000${account.id}`;
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

<aside id="assistant-accounts-drawer" aria-labelledby="assistant-accounts-title" hidden={!open}>
  <header>
    <div>
      <p>{copy.drawerKicker}</p>
      <h2 id="assistant-accounts-title">{copy.drawerTitle}</h2>
    </div>
    <button bind:this={closeButton} type="button" onclick={() => onclose?.()} aria-label={copy.closeDrawer}>×</button>
  </header>

  <p class="drawer-lead">{copy.drawerLead}</p>

  <div class="account-content" aria-live="polite">
    {#if pending}
      <section class="pending">
        <strong>{copy.pendingTitle}</strong>
        <p>{copy.pendingLead}</p>
        <button type="button" disabled={working === 'connect'} onclick={() => connect(pending.challenge_id)}>
          {working === 'connect' ? copy.connecting : copy.connect}
        </button>
      </section>
    {/if}

    {#if !synced}
      <p class="empty">{copy.loading}</p>
    {:else if groups.length === 0}
      <p class="empty">{copy.empty}</p>
    {:else}
      <div class="assistant-groups">
        {#each groups as assistant (assistant.id)}
          <section class="assistant-group" aria-labelledby={`account-assistant-${assistant.id}`}>
            <header>
              <h3 id={`account-assistant-${assistant.id}`}>{assistant.name}</h3>
              <code>{assistant.id}</code>
            </header>
            <ul>
              {#each assistant.accounts as account (account.id)}
                {@const itemIdentity = identity(account)}
                <li>
                  <div class="account-heading">
                    <strong>{account.name}</strong>
                    <em class:connected={account.status === 'connected'}>{statusLabel(account.status)}</em>
                  </div>
                  <p>{account.summary}</p>
                  <dl>
                    <div><dt>{copy.provider}</dt><dd>{assistantAccountProviderLabel(account.provider)}</dd></div>
                    <div><dt>{copy.account}</dt><dd>{accountLabel(account.account)}</dd></div>
                    <div><dt>{copy.scopes}</dt><dd>{account.scopes.join(' · ')}</dd></div>
                  </dl>
                  {#if !pendingIdentities.has(itemIdentity) && account.status !== 'missing'}
                    <button
                      class="disconnect"
                      type="button"
                      disabled={working === itemIdentity}
                      onclick={() => ondisconnect?.(account)}
                    >{working === itemIdentity ? copy.disconnecting : copy.disconnect}</button>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</aside>

<style>
  aside { display: grid; width: min(27rem, 37vw); height: 100vh; height: 100dvh; min-width: 20rem; min-height: 0; max-height: 100dvh; grid-template-rows: auto auto minmax(0, 1fr); gap: 0.75rem; border-inline-start: 1px solid var(--admin-divider); border-bottom: 1px solid var(--admin-divider); padding: 1rem; background: #050708; overflow: hidden; }
  aside[hidden] { display: none; }
  aside > header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.75rem; }
  aside > header p { margin: 0 0 0.25rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  aside > header h2 { margin: 0; font-size: 1rem; }
  aside > header button { display: grid; width: 2.25rem; height: 2.25rem; place-items: center; border: 1px solid var(--border-strong); padding: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 1.1rem; }
  .drawer-lead { margin: 0; color: var(--text-faint); font-size: 0.68rem; line-height: 1.5; }
  .account-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 0.25rem; }
  .empty { margin: 1rem 0; color: var(--text-faint); font-size: 0.72rem; }
  .pending { display: grid; gap: 0.45rem; margin-bottom: 0.9rem; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border-strong)); padding: 0.8rem; background: color-mix(in srgb, var(--warn) 5%, #050708); }
  .pending strong { color: var(--warn); font-family: var(--font-mono); font-size: 0.66rem; text-transform: uppercase; }
  .pending p { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  .pending button, li > button { min-height: 2.5rem; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  .pending button { border: 0; background: var(--warn); color: #131100; }
  .assistant-groups { display: grid; gap: 0.8rem; }
  .assistant-group { border: 1px solid var(--border-strong); background: #020405; }
  .assistant-group > header { display: grid; gap: 0.15rem; padding: 0.75rem; border-bottom: 1px solid var(--border-strong); background: var(--surface-2); }
  .assistant-group h3 { margin: 0; font-size: 0.82rem; }
  .assistant-group header code { color: var(--accent); font-size: 0.56rem; }
  ul { display: grid; margin: 0; padding: 0; list-style: none; }
  li { display: grid; gap: 0.55rem; padding: 0.75rem; }
  li + li { border-top: 1px solid var(--border); }
  .account-heading { display: flex; align-items: start; justify-content: space-between; gap: 0.6rem; }
  .account-heading strong { font-size: 0.74rem; }
  .account-heading em { color: var(--warn); font-family: var(--font-mono); font-size: 0.52rem; font-style: normal; text-transform: uppercase; }
  .account-heading em.connected { color: var(--success); }
  li > p { margin: 0; color: var(--text-dim); font-size: 0.66rem; line-height: 1.5; }
  dl { display: grid; gap: 0.45rem; margin: 0; }
  dl div { display: grid; gap: 0.18rem; }
  dt { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.52rem; letter-spacing: 0.08em; text-transform: uppercase; }
  dd { margin: 0; color: var(--text); font-size: 0.62rem; overflow-wrap: anywhere; }
  li > button.disconnect { border-color: var(--danger); color: var(--danger); }
  button:disabled { cursor: not-allowed; opacity: 0.42; }
  @media (max-width: 820px) { aside { position: fixed; z-index: 110; inset-block: 0; inset-inline-end: 0; width: min(92vw, 27rem); min-width: 0; box-shadow: -1rem 0 2rem rgba(0, 0, 0, 0.65); } }
</style>
