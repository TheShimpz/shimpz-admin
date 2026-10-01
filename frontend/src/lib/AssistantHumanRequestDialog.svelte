<script>
  import { tick } from 'svelte';
  import {
    Button,
    Notice,
    ActionRequestFields,
    PromptDialog,
    TextLink,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    open = $bindable(false),
    challenge,
    rejection,
    working = false,
    onrespond = () => {},
    onretry = () => {},
    onexpire = () => {},
    // A Routine run's challenge may be dismissed without an answer, leaving the run frozen (ADR-0086); chat has none.
    ondismiss = null,
    dismissLabel = '',
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
  let isStoredInput = $derived(kind === 'input:password' && Boolean(request?.stored_input));
  let rejected = $derived(Boolean(rejection));
  // Lead with why this task needs the pause, as the Brain wrote it for this conversation. A Stored Input request is
  // worded by Admin in the interface language: without the Brain's reason it says that its Assistant needs the key.
  let lead = $derived(
    rejected
      ? request?.description
      : challenge?.purpose
        ?? (isStoredInput ? $t('humanRequest.storedInputNeed', { assistant: challenge?.assistant?.name ?? '' }) : request?.description),
  );
  // Team sends a key page only for a Stored Input request, copied from its reviewed Assistant's declaration.
  let helpUrl = $derived(isStoredInput ? challenge?.help_url ?? '' : '');
  let copy = $derived($t('humanRequest'));
  let locked = $derived(rejection?.reason === 'authentication-locked');
  let validating = $derived(working && kind === 'auth:password' && !rejected);
  // A Stored Input title names the Assistant, so its kicker carries only the exact version; every other request keeps
  // its Assistant-authored title, so its kicker names the reviewed Assistant beside the version.
  let kicker = $derived(
    rejected
      ? copy.validationKicker
      : isStoredInput
        ? `v${challenge?.assistant?.version ?? ''}`
        : `${challenge?.assistant?.name ?? ''} · v${challenge?.assistant?.version ?? ''}`,
  );
  // A Stored Input request is always worded by Admin in the interface language; only its Assistant's name is dynamic.
  let title = $derived(
    rejected
      ? (locked ? copy.lockedTitle : copy.deniedTitle)
      : isStoredInput
        ? challenge?.assistant?.name ?? ''
        : request?.title,
  );
  let fieldRequest = $derived(
    isStoredInput
      ? {
          ...request,
          label: $t('humanRequest.storedInputLabel', { assistant: challenge?.assistant?.name ?? '' }),
          placeholder: copy.storedInputPlaceholder,
        }
      : request,
  );
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
  let clock = $derived(`${Math.floor(displayedSeconds / 60)}:${String(displayedSeconds % 60).padStart(2, '0')}`);
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

  function cancel(event) {
    if (!ondismiss) {
      deny(event);
      return;
    }
    event?.preventDefault();
    if (!working) ondismiss();
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
    lead={helpUrl && !rejected ? undefined : lead}
    titleId="human-request-title"
    size="md"
    oncancel={cancel}
    onsubmit={submit}
  >
    {#if helpUrl && !rejected}
      <!-- With a key page, the explanation ends in its link, so the next step reads as one sentence. -->
      <p class="request-lead">
        {lead}
        <TextLink href={helpUrl} title={helpUrl} target="_blank" rel="noopener noreferrer">{copy.keyHelp} ↗</TextLink>
        {copy.keyHelpAfter}
      </p>
    {/if}

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
          request={fieldRequest}
          resetKey={challenge.challenge_id}
          labels={fieldLabels}
          bind:value={fieldValue}
          bind:valid={fieldValid}
        />
        {#if validationError}<Notice variant="error">{validationError}</Notice>{/if}
      </div>
    {/if}
    <div class="request-meta">
      <span class="clock" role="timer">{$t('humanRequest.expiresIn', { time: clock })}</span>
    </div>
    {#snippet footer()}
      <!-- Every action in this dialog is one standard control: a glitch host with its label and a mnemonic icon. -->
      {#if ondismiss}
        <Button class="glitch-host request-action" type="button" variant="ghost" disabled={working} onclick={cancel}>
          <span class="glitch-text">{dismissLabel}</span>
          <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"></path></svg>
        </Button>
      {/if}
      <Button class="glitch-host request-action" type="button" variant="secondary" disabled={working} onclick={deny}>
        <span class="glitch-text">{copy.cancel}</span>
        <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </Button>
      {#if rejected}
        <Button class="glitch-host request-action" type="button" disabled={working || (locked && retrySeconds > 0)} onclick={retry}>
          <span class="glitch-text">{locked && retrySeconds > 0
            ? $t('humanRequest.retryCountdown', { seconds: String(retrySeconds) })
            : copy.retry}</span>
          <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"></path></svg>
        </Button>
      {:else}
        <Button class="glitch-host request-action" type="submit" disabled={working}>
          <span class="glitch-text">{primaryLabel}</span>
          <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
        </Button>
      {/if}
    {/snippet}
  </PromptDialog>
{/if}

<style>
  /* One quiet row under the field with the time left before the request expires. */
  .request-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--shimpz-space-3);
    color: var(--shimpz-color-text-dim);
    font: 400 0.76rem/1.45 var(--shimpz-font-sans);
  }
  .request-lead { max-width: 58ch; margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.84rem; line-height: 1.55; }
  .clock { margin-inline-start: auto; color: var(--shimpz-color-text-muted); font: 500 0.7rem/1.45 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  :global(.shimpz-button.request-action) { display: inline-flex; align-items: center; gap: 0.45rem; }
  :global(.shimpz-button.request-action svg) { width: 0.95rem; height: 0.95rem; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .request-state:focus-visible { outline: 2px solid var(--shimpz-color-yellow); outline-offset: 3px; }
</style>
