<script>
  import {
    Button,
    DialogFrame,
    Modal,
    Notice,
    TextField,
  } from '@shimpz/frontend';
  import { locale, t } from '$lib/i18n.js';
  import {
    assistantIntegrationLabels,
    assistantIntegrationMessageParts,
    localizedIntegrationList,
  } from '$lib/assistantIntegrationMessages.js';
  import { assistantIntegrationProviderLabel } from '$lib/localChat.js';

  let {
    open = false,
    challenge = undefined,
    installedAssistants = [],
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
  let activeRequirement = $state();
  let copy = $derived($t('assistantIntegrations'));
  let requirements = $derived(challenge?.requirements ?? []);
  let actionIds = $derived([...new Set(requirements.flatMap((requirement) => (
    requirement.actions.map((action) => action.id)
  )))]);
  let assistantLabels = $derived(assistantIntegrationLabels(requirements, installedAssistants));
  let providerLabels = $derived([...new Set(requirements.map((requirement) => (
    assistantIntegrationProviderLabel(requirement.provider)
  )))]);
  let nextRequirement = $derived(activeRequirement ?? requirements[0]);
  let nextProviderLabel = $derived(nextRequirement
    ? assistantIntegrationProviderLabel(nextRequirement.provider)
    : '');
  let scopes = $derived([...new Set(nextRequirement?.scopes ?? [])]);
  let messageValues = $derived({
    actions: localizedIntegrationList(actionIds, $locale),
    assistants: localizedIntegrationList(assistantLabels, $locale),
    provider: nextProviderLabel,
    providers: localizedIntegrationList(providerLabels, $locale),
  });
  let hasSingleRequirement = $derived(requirements.length === 1);
  let hasSingleAction = $derived(
    actionIds.length === 1 && assistantLabels.length === 1 && hasSingleRequirement,
  );
  let dialogTitleKey = $derived(hasSingleRequirement
    ? 'assistantIntegrations.dialogTitle'
    : 'assistantIntegrations.dialogTitleMultiple');
  let dialogTitle = $derived(awaitingCompletion
    ? copy.completionTitle
    : $t(dialogTitleKey, messageValues));
  let dialogTitleParts = $derived(assistantIntegrationMessageParts(
    awaitingCompletion ? copy.completionTitle : $t(dialogTitleKey),
    messageValues,
  ));
  let dialogContextKey = $derived(hasSingleAction
    ? 'assistantIntegrations.dialogContextSingle'
    : 'assistantIntegrations.dialogContextMultiple');
  let dialogContextParts = $derived(assistantIntegrationMessageParts(
    $t(dialogContextKey),
    messageValues,
  ));

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
    activeRequirement = undefined;
    submitting = false;
    submitError = '';
    onclose?.();
  }

  async function authorize(requirement) {
    if (submitting || !challenge) return;
    submitting = true;
    activeRequirement = requirement;
    submitError = '';
    try {
      const result = await onauthorize?.(challenge.challenge_id, requirement);
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
    activeRequirement = undefined;
  });
</script>

{#snippet titleContent()}
  {#each dialogTitleParts as part}
    {#if part.emphasized}<strong class="dynamic"><bdi>{part.text}</bdi></strong>{:else}{part.text}{/if}
  {/each}
{/snippet}

<Modal size="lg" bind:element={dialog} labelledBy="assistant-integrations-dialog-title" oncancel={close}>
  <DialogFrame
    kicker={copy.dialogKicker}
    title={dialogTitle}
    {titleContent}
    titleId="assistant-integrations-dialog-title"
  >
    {#if awaitingCompletion}
      <p id="assistant-integration-completion-lead" class="context">{copy.completionLead}</p>
      <TextField
        id="assistant-integration-completion-code"
        label={copy.completionLabel}
        bind:value={completionCode}
        autocomplete="off"
        spellcheck="false"
        disabled={submitting}
        aria-describedby="assistant-integration-completion-lead"
      />
    {:else}
      {#if hasSingleRequirement}
        <p class="context">
          {#each dialogContextParts as part}
            {#if part.emphasized}<strong class="dynamic"><bdi>{part.text}</bdi></strong>{:else}{part.text}{/if}
          {/each}
        </p>
      {/if}
      {#if hasSingleRequirement}
        <section class="chips" aria-label={copy.permissions}>
          {#each scopes as scope (scope)}<strong><bdi>{scope}</bdi></strong>{/each}
        </section>
      {:else}
        <section class="requirements" aria-label={copy.permissions}>
          {#each requirements as requirement (`${requirement.assistant_id}/${requirement.integration_id}`)}
            {@const requirementProvider = assistantIntegrationProviderLabel(requirement.provider)}
            {@const requirementActive = activeRequirement?.assistant_id === requirement.assistant_id
              && activeRequirement?.integration_id === requirement.integration_id}
            <article>
              <div class="requirement-copy">
                <strong class="requirement-name"><bdi>{requirement.name}</bdi></strong>
                <span><bdi>{requirement.assistant_name}</bdi></span>
                <p>{requirement.summary}</p>
                <div class="chips">
                  {#each requirement.scopes as scope (scope)}<strong><bdi>{scope}</bdi></strong>{/each}
                </div>
              </div>
              <Button
                type="button"
                disabled={submitting}
                aria-label={`${$t('assistantIntegrations.authorize', { provider: requirementProvider })} — ${requirement.name}`}
                onclick={() => authorize(requirement)}
              >
                {$t(
                  submitting && requirementActive
                    ? 'assistantIntegrations.authorizing'
                    : 'assistantIntegrations.authorize',
                  { provider: requirementProvider },
                )}
              </Button>
            </article>
          {/each}
        </section>
      {/if}
    {/if}

    {#if submitError}<Notice variant="error">{submitError}</Notice>{/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={submitting} onclick={close}>{copy.cancel}</Button>
      {#if awaitingCompletion}
        <Button type="button" disabled={submitting || !completionCode.trim()} onclick={complete}>
          {submitting ? copy.completing : copy.complete}
        </Button>
      {:else if hasSingleRequirement}
        <Button type="button" disabled={submitting} onclick={() => authorize(nextRequirement)}>
          {$t(
            submitting
              ? 'assistantIntegrations.authorizing'
              : 'assistantIntegrations.authorize',
            messageValues,
          )}
        </Button>
      {/if}
    {/snippet}
  </DialogFrame>
</Modal>

<style>
  .context { max-width: 74ch; margin: 0; color: var(--text-dim); font-size: 0.84rem; line-height: 1.55; }
  .dynamic { color: var(--shimpz-color-cyan); font-weight: 700; }
  .requirements { display: grid; gap: 0.65rem; }
  .requirements article { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; border: 1px solid var(--border); padding: 0.75rem; }
  .requirement-copy { display: grid; gap: 0.28rem; min-width: 0; }
  .requirement-name { color: var(--text); font-size: 0.78rem; }
  .requirement-copy > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.58rem; }
  .requirement-copy p { margin: 0; color: var(--text-dim); font-size: 0.68rem; line-height: 1.45; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chips strong { border: 1px solid var(--border-strong); padding: 0.28rem 0.5rem; color: var(--shimpz-color-cyan); font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; }
  @media (max-width: 560px) {
    .requirements article { grid-template-columns: 1fr; }
    .requirements :global(.shimpz-button) { width: 100%; }
  }
</style>
