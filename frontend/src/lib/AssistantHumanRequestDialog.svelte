<script>
  import { tick } from 'svelte';
  import {
    Button,
    Notice,
    ActionRequestFields,
    PromptDialog,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';
  import { humanRequestContextParts } from '$lib/humanRequestMessages.js';

  let {
    open = $bindable(false),
    challenge,
    rejection,
    working = false,
    onrespond = () => {},
    onretry = () => {},
    onexpire = () => {},
  } = $props();

  let challengeId = $state('');
  let fieldValue = $state();
  let fieldValid = $state(false);
  let validationError = $state('');
  let retrySeconds = $state(0);
  let countdownChallengeId = $state('');
  let remainingSeconds = $state(0);
  let fieldsContainer = $state();
  let stateStatus = $state();

  let request = $derived(challenge?.request);
  let kind = $derived(request?.kind ?? '');
  let isAuth = $derived(kind.startsWith('auth:'));
  let isInput = $derived(kind.startsWith('input:'));
  let isStoredInput = $derived(kind === 'input:password' && Boolean(request?.stored_input));
  let copy = $derived($t('humanRequest'));
  let rejected = $derived(Boolean(rejection));
  let locked = $derived(rejection?.reason === 'authentication-locked');
  let validating = $derived(working && kind === 'auth:password' && !rejected);
  let kicker = $derived(rejected ? copy.validationKicker : isAuth ? copy.authKicker : isInput ? copy.inputKicker : copy.approvalKicker);
  let title = $derived(rejected ? (locked ? copy.lockedTitle : copy.deniedTitle) : request?.title);
  let rejectionMessage = $derived(
    rejected
      ? locked
        ? copy.lockedLead
        : $t('humanRequest.deniedLead', { remaining: String(rejection?.attempts_remaining ?? 0) })
      : '',
  );
  let primaryLabel = $derived(
    kind === 'approval' ? copy.approve : isAuth ? (kind === 'auth:passkey' ? copy.usePasskey : copy.authorize) : copy.submit,
  );
  let displayedSeconds = $derived(
    challenge?.challenge_id === countdownChallengeId
      ? remainingSeconds
      : challenge?.expires_in ?? 0,
  );
  let contextParts = $derived(
    challenge ? humanRequestContextParts(copy.context, challenge, displayedSeconds) : [],
  );
  let fieldLabels = $derived({
    chooseOption: copy.chooseOption,
    selectionHint: $t('humanRequest.selectionHint', {
      minimum: String(request?.min_selections ?? 0),
      maximum: String(request?.max_selections ?? 0),
    }),
    passwordLabel: copy.passwordLabel,
    totpLabel: copy.totpLabel,
    totpPlaceholder: copy.totpPlaceholder,
  });

  $effect(() => {
    const nextId = challenge?.challenge_id ?? '';
    if (nextId === challengeId) return;
    challengeId = nextId;
    validationError = '';
  });

  $effect(() => {
    const nextId = challenge?.challenge_id ?? '';
    const seconds = challenge?.expires_in ?? 0;
    countdownChallengeId = nextId;
    remainingSeconds = seconds;
    if (!nextId || seconds < 1) return;
    const deadline = Date.now() + (seconds * 1000);
    let fired = false;
    const update = () => {
      remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (remainingSeconds === 0) {
        clearInterval(timer);
        if (!fired) {
          fired = true;
          onexpire(nextId);
        }
      }
    };
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const focusKey = challengeId && !working && !rejected ? challengeId : '';
    if (focusKey) void focusFields(focusKey);
  });

  $effect(() => {
    const stateKey = validating
      ? `${challengeId}:validating`
      : rejected ? `${challengeId}:${rejection?.reason}` : '';
    if (!stateKey) return;
    if (validating) {
      fieldValue = undefined;
      fieldValid = false;
    }
    void focusState(stateKey);
  });

  $effect(() => {
    const delay = rejection?.reason === 'authentication-locked' ? rejection.retry_after : 0;
    if (!delay) {
      retrySeconds = 0;
      return;
    }
    const deadline = Date.now() + (delay * 1000);
    const update = () => {
      retrySeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
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
    const responseValue = fieldValue;
    if (kind === 'auth:password' || kind === 'input:password') {
      fieldValue = undefined;
      fieldValid = false;
    }
    onrespond({ decision: 'submit', value: responseValue });
  }

  function retry(event) {
    event.preventDefault();
    if (!working && (!locked || retrySeconds === 0)) onretry();
  }

  async function focusFields(expectedKey) {
    await tick();
    if (working || rejected || challengeId !== expectedKey) return;
    fieldsContainer?.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
  }

  async function focusState(expectedKey) {
    await tick();
    const currentKey = validating
      ? `${challengeId}:validating`
      : rejected ? `${challengeId}:${rejection?.reason}` : '';
    if (currentKey === expectedKey) stateStatus?.focus({ preventScroll: true });
  }
</script>

{#if challenge && request}
  <PromptDialog
    bind:open
    {kicker}
    {title}
    lead={request.description}
    titleId="human-request-title"
    size="md"
    oncancel={deny}
    onsubmit={submit}
  >
    <p class="request-context">{#each contextParts as part}{#if part.emphasized}<strong><bdi>{part.text}</bdi></strong>{:else}{part.text}{/if}{/each}</p>
    {#if isStoredInput}<Notice>{copy.storedInputLead}</Notice>{/if}

    {#if rejected}
      <div class="request-state" bind:this={stateStatus} tabindex="-1">
        <Notice variant="error">
          <p>{rejectionMessage}</p>
          <p>{copy.mayExpire}</p>
        </Notice>
      </div>
    {:else if validating}
      <div class="request-state" bind:this={stateStatus} tabindex="-1">
        <Notice>{copy.validating}</Notice>
      </div>
    {:else}
      <div bind:this={fieldsContainer}>
        <ActionRequestFields
          {request}
          resetKey={challenge.challenge_id}
          labels={fieldLabels}
          bind:value={fieldValue}
          bind:valid={fieldValid}
        />
        {#if validationError}<Notice variant="error">{validationError}</Notice>{/if}
      </div>
    {/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={working} onclick={deny}>{copy.cancel}</Button>
      {#if rejected}
        <Button type="button" disabled={working || (locked && retrySeconds > 0)} onclick={retry}>
          {locked && retrySeconds > 0
            ? $t('humanRequest.retryCountdown', { seconds: String(retrySeconds) })
            : copy.retry}
        </Button>
      {:else}
        <Button type="submit" disabled={working}>{primaryLabel}</Button>
      {/if}
    {/snippet}
  </PromptDialog>
{/if}

<style>
  .request-context { margin: 0; color: var(--text-dim); font-size: 0.72rem; line-height: 1.55; }
  .request-context strong { color: var(--shimpz-color-cyan); font-family: var(--shimpz-font-mono); font-weight: 700; }
  .request-state:focus-visible { outline: 2px solid var(--shimpz-color-yellow); outline-offset: 3px; }
</style>
