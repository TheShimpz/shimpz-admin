<script>
  import { t } from '$lib/i18n.js';
  import { assistantAccountProviderLabel } from '$lib/localChat.js';

  let { open = false, challenge = undefined, onclose = undefined, onauthorize = undefined } = $props();
  let dialog = $state();
  let submitting = $state(false);
  let submitError = $state('');
  let activeChallengeId = $state('');
  let provider = $derived(challenge?.requirements?.[0]?.provider ?? '');
  let providerLabel = $derived(assistantAccountProviderLabel(provider));
  let copy = $derived($t('assistantAccounts'));

  function close(event) {
    event?.preventDefault();
    if (submitting) return;
    submitError = '';
    onclose?.();
  }

  async function authorize() {
    if (submitting || !challenge) return;
    submitting = true;
    submitError = '';
    try {
      await onauthorize?.(challenge.challenge_id);
    } catch {
      submitError = copy.authorizationFailed;
      submitting = false;
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && challenge && !dialog.open) dialog.showModal();
    if ((!open || !challenge) && dialog.open) dialog.close();
  });

  $effect(() => {
    const challengeId = challenge?.challenge_id ?? '';
    if (challengeId === activeChallengeId) return;
    activeChallengeId = challengeId;
    submitting = false;
    submitError = '';
  });
</script>

<dialog bind:this={dialog} aria-labelledby="assistant-accounts-dialog-title" oncancel={close}>
  <section class="dialog-panel">
    <header>
      <p>{copy.dialogKicker}</p>
      <h2 id="assistant-accounts-dialog-title">{copy.dialogTitle}</h2>
      <span>{$t('assistantAccounts.dialogLead', { provider: providerLabel })}</span>
    </header>

    <div class="requirements">
      {#each challenge?.requirements ?? [] as requirement (`${requirement.assistant_id}:${requirement.account_id}`)}
        <article>
          <header>
            <div>
              <strong>{requirement.assistant_name}</strong>
              <code>{requirement.assistant_id}</code>
            </div>
            <span>{providerLabel}</span>
          </header>
          <h3>{requirement.name}</h3>
          <p>{requirement.summary}</p>
          <section aria-label={copy.scopesTitle}>
            <span>{copy.scopesTitle}</span>
            <div class="chips">
              {#each requirement.scopes as scope (scope)}<code>{scope}</code>{/each}
            </div>
          </section>
          <section aria-label={copy.powers}>
            <span>{copy.powers}</span>
            <ul>
              {#each requirement.powers as power (power.id)}
                <li><strong>{power.name}</strong><p>{power.summary}</p></li>
              {/each}
            </ul>
          </section>
        </article>
      {/each}
    </div>

    {#if submitError}<p class="dialog-error" role="alert">{submitError}</p>{/if}
    <footer>
      <button type="button" class="secondary" disabled={submitting} onclick={close}>{copy.cancel}</button>
      <button type="button" class="primary" disabled={submitting} onclick={authorize}>
        {$t(
          submitting ? 'assistantAccounts.authorizing' : 'assistantAccounts.authorize',
          { provider: providerLabel },
        )}
      </button>
    </footer>
  </section>
</dialog>

<style>
  dialog { width: min(48rem, calc(100vw - 2rem)); max-height: 90dvh; border: 0; padding: 0; background: transparent; color: var(--text); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.86); backdrop-filter: blur(8px); }
  .dialog-panel { --pad: clamp(1.2rem, 3vw, 2rem); display: grid; max-height: 90dvh; grid-template-rows: auto minmax(0, 1fr) auto auto; padding: var(--pad); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px #000; clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut)); overflow: hidden; }
  .dialog-panel > header p { margin: 0 0 0.7rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
  .dialog-panel > header h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.45rem); letter-spacing: -0.05em; }
  .dialog-panel > header span { display: block; margin: 0.7rem 0 1.1rem; color: var(--text-dim); font-size: 0.72rem; line-height: 1.55; }
  .requirements { display: grid; min-height: 0; gap: 0.8rem; overflow-y: auto; overscroll-behavior: contain; }
  article { display: grid; gap: 0.65rem; border: 1px solid var(--border-strong); padding: 0.85rem; background: #030506; }
  article > header { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; }
  article > header div { display: grid; gap: 0.18rem; }
  article > header code { color: var(--accent); font-size: 0.56rem; }
  article > header span { color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; font-weight: 700; }
  article h3 { margin: 0; font-size: 0.86rem; }
  article > p, li p { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  article section { display: grid; gap: 0.4rem; }
  article section > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.54rem; letter-spacing: 0.1em; text-transform: uppercase; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chips code { border: 1px solid var(--border-strong); padding: 0.18rem 0.4rem; color: var(--accent); font-size: 0.56rem; }
  ul { display: grid; margin: 0; border: 1px solid var(--border); padding: 0; list-style: none; }
  li { display: grid; gap: 0.2rem; padding: 0.55rem; }
  li + li { border-top: 1px solid var(--border); }
  li strong { font-size: 0.7rem; }
  .dialog-error { margin: 0.75rem 0 0; color: var(--danger); font-size: 0.7rem; }
  footer { display: flex; margin: 1rem calc(0px - var(--pad)) calc(0px - var(--pad)); }
  footer button { width: 50%; min-height: 3.2rem; flex: 1 1 0; border: 0; cursor: pointer; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; text-transform: uppercase; }
  footer .secondary { box-shadow: inset 0 0 0 1px var(--border-strong); background: transparent; color: var(--text-dim); }
  footer .primary { background: var(--accent); color: var(--accent-ink); }
  footer button:disabled { cursor: not-allowed; opacity: 0.42; }
  @media (max-width: 640px) { dialog { width: calc(100vw - 1rem); } .dialog-panel { --pad: 1rem; max-height: 94dvh; } }
</style>
