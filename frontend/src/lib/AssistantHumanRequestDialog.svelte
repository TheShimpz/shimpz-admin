<script>
  import {
    Button,
    Card,
    Notice,
    PowerRequestFields,
    PromptDialog,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    open = $bindable(false),
    challenge,
    working = false,
    onrespond = () => {},
  } = $props();

  let challengeId = $state('');
  let fieldValue = $state();
  let fieldValid = $state(false);
  let validationError = $state('');

  let request = $derived(challenge?.request);
  let kind = $derived(request?.kind ?? '');
  let isAuth = $derived(kind.startsWith('auth:'));
  let isInput = $derived(kind.startsWith('input:'));
  let copy = $derived($t('humanRequest'));
  let kicker = $derived(isAuth ? copy.authKicker : isInput ? copy.inputKicker : copy.approvalKicker);
  let primaryLabel = $derived(
    kind === 'approval' ? copy.approve : isAuth ? (kind === 'auth:phishing-resistant' ? copy.usePasskey : copy.authorize) : copy.submit,
  );
  let fieldLabels = $derived({
    required: copy.required,
    optional: copy.optional,
    chooseOption: copy.chooseOption,
    selectionHint: $t('humanRequest.selectionHint', {
      minimum: String(request?.min_selections ?? 0),
      maximum: String(request?.max_selections ?? 0),
    }),
    thirdPartySecret: $t('humanRequest.thirdPartySecret', { assistant: challenge?.assistant?.name ?? '' }),
    reauthHint: copy.reauthHint,
    reauthLabel: copy.authorize,
    secondFactorHint: copy.secondFactorHint,
    secondFactorLabel: copy.secondFactorLabel,
    secondFactorPlaceholder: copy.secondFactorPlaceholder,
    passkeyHint: copy.passkeyHint,
  });

  $effect(() => {
    const nextId = challenge?.challenge_id ?? '';
    if (nextId === challengeId) return;
    challengeId = nextId;
    validationError = '';
  });

  function deny(event) {
    event?.preventDefault();
    if (!working && challenge) onrespond({ decision: 'deny' });
  }

  function submit(event) {
    event.preventDefault();
    if (working || !challenge) return;
    if (!fieldValid) {
      validationError = copy.invalid;
      return;
    }
    validationError = '';
    onrespond({ decision: 'submit', value: fieldValue });
  }
</script>

{#if challenge && request}
  <PromptDialog
    bind:open
    {kicker}
    title={request.title}
    titleId="human-request-title"
    lead={request.description}
    size="md"
    oncancel={deny}
    onsubmit={submit}
  >
    <p class="paused">
      {copy.paused}
      <span>{$t('humanRequest.expires', { seconds: String(challenge.expires_in) })}</span>
    </p>
    <Card class="request-origin" padding="compact">
      <div><span>{copy.assistant}</span><strong>{challenge.assistant.name}</strong><code>{challenge.assistant.id}</code></div>
      <div><span>{copy.power}</span><strong>{challenge.power.summary}</strong><code>{challenge.power.id}</code></div>
    </Card>

    <PowerRequestFields
      {request}
      resetKey={challenge.challenge_id}
      labels={fieldLabels}
      bind:value={fieldValue}
      bind:valid={fieldValid}
    />

    {#if validationError}<Notice variant="error">{validationError}</Notice>{/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={working} onclick={deny}>{copy.cancel}</Button>
      <Button type="submit" disabled={working}>{primaryLabel}</Button>
    {/snippet}
  </PromptDialog>
{/if}

<style>
  .paused { margin: 0; color: var(--text-dim); font-size: 0.72rem; line-height: 1.5; }
  .paused span { color: var(--accent); font-family: var(--font-mono); }
  :global(.request-origin > [data-slot="card-content"]) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--shimpz-space-4); }
  :global(.request-origin [data-slot="card-content"] > div) { display: grid; min-width: 0; gap: 0.18rem; }
  :global(.request-origin span) { color: var(--text-faint); font: 600 0.58rem/1.2 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  :global(.request-origin strong) { overflow: hidden; font-size: 0.78rem; line-height: 1.4; text-overflow: ellipsis; }
  :global(.request-origin code) { overflow: hidden; color: var(--accent); font-size: 0.6rem; text-overflow: ellipsis; }
  @media (max-width: 520px) { :global(.request-origin > [data-slot="card-content"]) { grid-template-columns: 1fr; } }
</style>
