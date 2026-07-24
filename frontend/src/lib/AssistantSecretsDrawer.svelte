<script>
  import { t } from '$lib/i18n.js';

  let {
    open = false,
    assistants = [],
    synced = false,
    pending = undefined,
    approvalCount = 0,
    approvalsSynced = false,
    approvalsLoading = false,
    onclose = undefined,
    onprovide = undefined,
    onrotate = undefined,
    onrevoke = undefined,
  } = $props();

  let closeButton = $state();
  let copy = $derived($t('assistantSecrets'));
  let management = $derived($t('assistantSecretManagement'));

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

<aside id="assistant-secrets-drawer" aria-labelledby="assistant-secrets-title" hidden={!open}>
  <header>
    <div>
      <p>{copy.drawerKicker}</p>
      <h2 id="assistant-secrets-title">{copy.drawerTitle}</h2>
    </div>
    <button
      bind:this={closeButton}
      type="button"
      onclick={() => onclose?.()}
      aria-label={copy.closeDrawer}
      title={copy.closeDrawer}
    >×</button>
  </header>

  <p class="drawer-lead">{copy.drawerLead}</p>

  <div class="secret-content" aria-live="polite">
    {#if pending}
      <section class="pending" aria-labelledby="pending-secrets-title">
        <p id="pending-secrets-title">{copy.pendingTitle}</p>
        <span>{copy.pendingLead}</span>
        <button type="button" onclick={() => onprovide?.()}>{copy.provide}</button>
      </section>
    {/if}

    {#if !synced}
      <p class="empty">{copy.loading}</p>
    {:else if assistants.length === 0}
      <p class="empty">{copy.noAssistants}</p>
    {:else}
      <div class="assistant-groups">
        {#each assistants as assistant (assistant.id)}
          <section class="assistant-group" aria-labelledby={`secret-assistant-${assistant.id}`}>
            <header>
              <div>
                <h3 id={`secret-assistant-${assistant.id}`}>{assistant.name}</h3>
                <code>{assistant.id}</code>
              </div>
            </header>

            {#if assistant.secrets.length === 0}
              <p class="no-secrets">{copy.noSecrets}</p>
            {:else}
              <ul>
                {#each assistant.secrets as secret (secret.id)}
                  <li>
                    <div class="secret-heading">
                      <strong>{secret.name}</strong>
                      <span class:configured={secret.configured} class:missing={!secret.configured}>
                        <b aria-hidden="true">{secret.configured ? '✓' : '!'}</b>
                        {secret.configured ? copy.configured : copy.missing}
                      </span>
                    </div>
                    <p>{secret.summary}</p>
                    <div class="secret-meta">
                      <code>{secret.id}</code>
                      {#if secret.configured && secret.mask}
                        <span>{copy.mask}: <code dir="ltr">{secret.mask}</code></span>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              <button class="rotate" type="button" onclick={() => onrotate?.(assistant)}>
                {management.rotate}
              </button>
            {/if}
          </section>
        {/each}
      </div>
    {/if}

    <section class="approvals" aria-labelledby="remembered-approvals-title">
      <h3 id="remembered-approvals-title">{management.approvalsTitle}</h3>
      <p>{management.approvalsLead}</p>
      {#if !approvalsSynced}<span>{copy.loading}</span>
      {:else if approvalCount === 0}<span>{management.noApprovals}</span>
      {:else}
        <strong>{approvalCount}</strong>
        <button type="button" disabled={approvalsLoading} onclick={() => onrevoke?.()}>{management.revoke}</button>
      {/if}
    </section>
  </div>
</aside>

<style>
  aside {
    display: grid;
    width: min(27rem, 37vw);
    height: 100vh;
    height: 100dvh;
    min-width: 20rem;
    min-height: 0;
    max-height: 100dvh;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 0.75rem;
    border-inline-start: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    padding: 1rem;
    background: #050708;
    overflow: hidden;
  }

  aside[hidden] { display: none; }
  aside > header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.75rem; }
  aside > header p { margin: 0 0 0.25rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  aside > header h2 { margin: 0; font-size: 1rem; }
  aside > header button { display: grid; width: 2.25rem; height: 2.25rem; place-items: center; border: 1px solid var(--border-strong); padding: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 1.1rem; }
  aside > header button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .drawer-lead { margin: 0; color: var(--text-faint); font-size: 0.68rem; line-height: 1.5; }
  .secret-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 0.25rem; }
  .empty { margin: 1rem 0; color: var(--text-faint); font-size: 0.72rem; }
  .pending { display: grid; gap: 0.45rem; margin-bottom: 0.9rem; border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border-strong)); padding: 0.8rem; background: color-mix(in srgb, var(--warn) 5%, #050708); }
  .pending p { margin: 0; color: var(--warn); font-family: var(--font-mono); font-size: 0.66rem; font-weight: 700; text-transform: uppercase; }
  .pending span { color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  .pending button { min-height: 2.5rem; border: 0; padding: 0 0.8rem; background: var(--warn); color: #131100; cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  .assistant-groups { display: grid; gap: 0.8rem; }
  .assistant-group { border: 1px solid var(--border-strong); background: #020405; }
  .assistant-group > header { padding: 0.75rem; border-bottom: 1px solid var(--border-strong); background: var(--surface-2); }
  .assistant-group h3 { margin: 0; font-size: 0.82rem; }
  .assistant-group header code { display: block; margin-top: 0.15rem; color: var(--accent); font-size: 0.56rem; }
  .assistant-group ul { display: grid; margin: 0; padding: 0; list-style: none; }
  .assistant-group li { display: grid; gap: 0.35rem; padding: 0.75rem; }
  .assistant-group li + li { border-top: 1px solid var(--border); }
  .secret-heading { display: flex; align-items: start; justify-content: space-between; gap: 0.65rem; }
  .secret-heading strong { font-size: 0.73rem; }
  .secret-heading span { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 0.28rem; color: var(--danger); font-family: var(--font-mono); font-size: 0.53rem; text-transform: uppercase; }
  .secret-heading span.configured { color: var(--success); }
  .secret-heading b { display: grid; width: 1rem; height: 1rem; place-items: center; border: 1px solid currentColor; font-size: 0.58rem; }
  .assistant-group li > p { margin: 0; color: var(--text-dim); font-size: 0.66rem; line-height: 1.5; }
  .secret-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.4rem; color: var(--text-faint); font-size: 0.56rem; }
  .secret-meta > code { color: var(--accent); }
  .secret-meta span code { margin-inline-start: 0.2rem; color: var(--success); }
  .no-secrets { margin: 0; padding: 0.75rem; color: var(--text-faint); font-size: 0.66rem; }
  .rotate { width: 100%; min-height: 2.7rem; border: 0; box-shadow: inset 0 0 0 1px var(--border-strong); background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  .approvals { display: grid; gap: 0.45rem; margin-top: 0.9rem; border: 1px solid var(--border-strong); padding: 0.8rem; background: #020405; }
  .approvals h3 { margin: 0; font-size: 0.8rem; }
  .approvals p, .approvals span { margin: 0; color: var(--text-dim); font-size: 0.65rem; line-height: 1.45; }
  .approvals strong { color: var(--success); font-family: var(--font-mono); font-size: 0.75rem; }
  .approvals button { min-height: 2.7rem; border: 1px solid var(--danger); background: transparent; color: var(--danger); cursor: pointer; font-family: var(--font-mono); font-size: 0.56rem; font-weight: 700; text-transform: uppercase; }

  @media (max-width: 820px) {
    aside { position: fixed; z-index: 110; inset-block: 0; inset-inline-end: 0; width: min(92vw, 27rem); min-width: 0; box-shadow: -1rem 0 2rem rgba(0, 0, 0, 0.65); }
  }
</style>
