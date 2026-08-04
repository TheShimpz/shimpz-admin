<script>
  import {
    Button,
    Card,
    DialogFrame,
    Modal,
    Notice,
    ScrollArea,
    StatusBadge,
    TextField,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';
  import { assistantIntegrationProviderLabel } from '$lib/localChat.js';

  let {
    open = false,
    challenge = undefined,
    onclose = undefined,
    onauthorize = undefined,
    oncomplete = undefined,
    oncancel = undefined,
  } = $props();
  let dialog = $state();
  let submitting = $state(false);
  let submitError = $state('');
  let activeChallengeId = $state('');
  let awaitingCompletion = $state(false);
  let completionCode = $state('');
  let provider = $derived(challenge?.requirements?.[0]?.provider ?? '');
  let providerLabel = $derived(assistantIntegrationProviderLabel(provider));
  let copy = $derived($t('assistantIntegrations'));

  async function close(event) {
    event?.preventDefault();
    if (submitting) return;
    const challengeId = challenge?.challenge_id;
    if (awaitingCompletion && challengeId) {
      submitting = true;
      await oncancel?.(challengeId);
    }
    awaitingCompletion = false;
    completionCode = '';
    submitting = false;
    submitError = '';
    onclose?.();
  }

  async function authorize() {
    if (submitting || !challenge) return;
    submitting = true;
    submitError = '';
    try {
      const result = await onauthorize?.(challenge.challenge_id);
      if (result?.completion_mode === 'code') {
        awaitingCompletion = true;
        submitting = false;
      }
    } catch {
      submitError = copy.authorizationFailed;
      submitting = false;
    }
  }

  async function complete() {
    if (submitting || !challenge) return;
    submitting = true;
    submitError = '';
    try {
      await oncomplete?.(challenge.challenge_id, completionCode.trim());
    } catch {
      submitError = copy.completionFailed;
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
    awaitingCompletion = false;
    completionCode = '';
  });
</script>

<Modal size="lg" bind:element={dialog} labelledBy="assistant-integrations-dialog-title" oncancel={close}>
  <DialogFrame
    kicker={copy.dialogKicker}
    title={copy.dialogTitle}
    titleId="assistant-integrations-dialog-title"
    lead={$t('assistantIntegrations.dialogLead', { provider: providerLabel })}
  >
    {#if awaitingCompletion}
      <Card
        class="completion"
        title={copy.completionTitle}
        description={copy.completionLead}
        tone="accent"
      >
        <TextField
          id="assistant-integration-completion-code"
          label={copy.completionLabel}
          bind:value={completionCode}
          aria-describedby="assistant-integration-completion-lead"
          autocomplete="off"
          spellcheck="false"
          disabled={submitting}
        />
      </Card>
    {:else}
      <ScrollArea class="requirements">
        {#each challenge?.requirements ?? [] as requirement (`${requirement.assistant_id}:${requirement.integration_id}`)}
          <Card
            class="requirement"
            title={requirement.name}
            description={requirement.summary}
            padding="compact"
          >
            {#snippet header()}
              <div class="assistant-identity">
                <strong>{requirement.assistant_name}</strong>
                <code>{requirement.assistant_id}</code>
              </div>
            {/snippet}
            {#snippet action()}<StatusBadge tone="info">{providerLabel}</StatusBadge>{/snippet}
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
          </Card>
        {/each}
      </ScrollArea>
    {/if}

    {#if submitError}<Notice variant="error">{submitError}</Notice>{/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={submitting} onclick={close}>{copy.cancel}</Button>
      {#if awaitingCompletion}
        <Button type="button" disabled={submitting || !completionCode.trim()} onclick={complete}>
          {submitting ? copy.completing : copy.complete}
        </Button>
      {:else}
        <Button type="button" disabled={submitting} onclick={authorize}>
          {$t(
            submitting ? 'assistantIntegrations.authorizing' : 'assistantIntegrations.authorize',
            { provider: providerLabel },
          )}
        </Button>
      {/if}
    {/snippet}
  </DialogFrame>
</Modal>

<style>
  :global(.requirements) { display: grid; min-height: 0; gap: 0.8rem; }
  :global(.completion) { min-height: 13rem; align-content: center; }
  :global(.completion > .content) { display: grid; align-content: center; }
  :global(.requirement > .content) { display: grid; gap: 0.65rem; }
  .assistant-identity { display: grid; gap: 0.18rem; }
  .assistant-identity code { color: var(--accent); font-size: 0.56rem; }
  :global(.requirement section) { display: grid; gap: 0.4rem; }
  :global(.requirement section > span) { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.54rem; letter-spacing: 0.1em; text-transform: uppercase; }
  li p { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chips code { border: 1px solid var(--border-strong); padding: 0.18rem 0.4rem; color: var(--accent); font-size: 0.56rem; }
  ul { display: grid; margin: 0; border: 1px solid var(--border); padding: 0; list-style: none; }
  li { display: grid; gap: 0.2rem; padding: 0.55rem; }
  li + li { border-top: 1px solid var(--border); }
  li strong { font-size: 0.7rem; }
</style>
