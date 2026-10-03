<script>
  import { tick } from 'svelte';
  import {
    Notice,
    ActionRequestFields,
    PromptDialog,
    TextLink,
  } from '@shimpz/frontend';
  import AttachmentChip from '$lib/AttachmentChip.svelte';
  import { attachmentKind, identifierName } from '$lib/attachments.js';
  import DialogAction from '$lib/DialogAction.svelte';
  import { t } from '$lib/i18n.js';
  import { displayedHumanRequest } from '$lib/localChat.js';

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

  // Every Assistant-authored word comes from the rendered copy in the interface language; the kind, bounds, and option
  // values stay the canonical request's, so an answer always submits exactly what Team fingerprinted (ADR-0091).
  let request = $derived(challenge ? displayedHumanRequest(challenge) : undefined);
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
  // The Brain's purpose explains why; it never replaces the Assistant's own description of what will be authorized,
  // so any other request keeps that scope visible beside the purpose.
  let scope = $derived(
    !rejected && !isStoredInput && challenge?.purpose && request?.description !== challenge.purpose
      ? request?.description ?? ''
      : '',
  );
  // An authorization request may name the one original file its approved Action receives, with any metadata embedded
  // in it; the person sees exactly that file before authorizing (ADR-0093).
  let disclosedFile = $derived(rejected ? null : challenge?.file ?? null);
  let fileDisclosure = $derived(
    disclosedFile
      ? $t('attachments.consent.disclosure', {
          action: identifierName(challenge?.action?.id),
          assistant: challenge?.assistant?.name ?? '',
        })
      : '',
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

    {#if scope}
      <p class="request-scope">{scope}</p>
    {/if}

    {#if disclosedFile}
      <div class="request-file">
        <ul aria-label={$t('attachments.consent.file')}>
          <AttachmentChip
            name={disclosedFile.name}
            size={disclosedFile.size}
            kind={attachmentKind(disclosedFile.media_type)}
          />
        </ul>
        <p>{fileDisclosure}</p>
      </div>
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
      {#if ondismiss}
        <DialogAction kind="dismiss" type="button" disabled={working} onclick={cancel}>{dismissLabel}</DialogAction>
      {/if}
      <DialogAction kind="cancel" type="button" disabled={working} onclick={deny}>{copy.cancel}</DialogAction>
      {#if rejected}
        <DialogAction kind="retry" type="button" disabled={working || (locked && retrySeconds > 0)} onclick={retry}>
          {locked && retrySeconds > 0
            ? $t('humanRequest.retryCountdown', { seconds: String(retrySeconds) })
            : copy.retry}
        </DialogAction>
      {:else}
        <DialogAction kind="confirm" type="submit" disabled={working}>{primaryLabel}</DialogAction>
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
  .request-scope { max-width: 58ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.84rem; line-height: 1.55; }
  .clock { margin-inline-start: auto; color: var(--shimpz-color-text-muted); font: 500 0.7rem/1.45 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .request-file { display: grid; gap: 0.4rem; max-width: 58ch; }
  .request-file ul { margin: 0; padding: 0; list-style: none; }
  .request-file p { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; line-height: 1.55; }
  .request-state:focus-visible { outline: 2px solid var(--shimpz-color-yellow); outline-offset: 3px; }
</style>
