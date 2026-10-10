<script>
  import { Notice, RadioField, TextField } from '@shimpz/frontend';
  import { get } from 'svelte/store';

  import DialogAction from '$lib/DialogAction.svelte';
  import { t } from '$lib/i18n.js';
  import { authenticateWithPasskey, passkeyFailure } from '$lib/passkey.js';
  import { beginRecoveryCodes, replaceRecoveryCodes, SecurityError } from '$lib/security.js';
  import { sessionContext } from '$lib/sessionContext.js';

  // Replacing every recovery code (ADR-0051) is a confirmed operation: the Supervisor password, then one second factor
  // bound to it. A code is the default; a passkey is offered beside it only where this address has one.
  let { ondone, oncancel } = $props();

  const id = $props.id();
  let password = $state('');
  let code = $state('');
  let method = $state('totp');
  let passkeyOffered = $state(get(sessionContext).passkeyRegistered);
  let passwordError = $state('');
  let codeError = $state('');
  let error = $state('');
  let busy = $state(false);
  let live = true;
  let ready = $derived(password.length > 0 && (method === 'passkey' || /^[0-9]{6}$/.test(code)));

  $effect(() => {
    document.getElementById(`${id}-password`)?.focus();
    return () => { live = false; };
  });

  function focus(field) {
    queueMicrotask(() => document.getElementById(`${id}-${field}`)?.focus());
  }

  // Each refusal says what to fix where it is fixed; nothing typed is ever echoed back.
  function refused(failure) {
    const reason = failure instanceof SecurityError ? failure.code : '';
    if (reason === 'password-incorrect') {
      password = '';
      passwordError = $t('security.passwordIncorrect');
      focus('password');
    } else if (reason === 'code-incorrect') {
      code = '';
      codeError = $t('security.codeIncorrect');
      focus('code');
    } else if (reason === 'authentication-locked') {
      error = $t('security.locked', { seconds: failure.retryAfter || 60 });
    } else if (reason === 'code-locked') {
      code = '';
      error = $t('security.codeLocked');
    } else if (reason === 'authentication-expired') {
      error = $t('security.expired');
    } else if (reason === 'passkey-failed' || reason === 'passkey-suspended') {
      error = $t('security.passkeyFailed');
    } else if (failure instanceof SecurityError) {
      error = $t('security.unavailable');
    } else {
      error = $t(passkeyFailure(failure) === 'canceled' ? 'security.passkeyCanceled' : 'security.passkeyFailed');
    }
  }

  async function proof(offer) {
    if (method === 'totp') return { code };
    if (!offer.passkey) {
      passkeyOffered = false;
      method = 'totp';
      error = $t('security.passkeyMissing');
      focus('code');
      return null;
    }
    return { credential: await authenticateWithPasskey(offer.passkey) };
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !ready) return;
    busy = true;
    passwordError = codeError = error = '';
    try {
      const offer = await beginRecoveryCodes(fetch, password);
      const factor = live ? await proof(offer) : null;
      // A dialog closed while the passkey was asked for never replaces the codes.
      if (!factor || !live) return;
      const codes = await replaceRecoveryCodes(fetch, factor);
      password = code = '';
      ondone(codes);
    } catch (failure) {
      refused(failure);
    } finally {
      busy = false;
    }
  }
</script>

<form class="regeneration" onsubmit={submit}>
  <p class="lead">{$t('security.regenerateLead')}</p>
  <TextField id={`${id}-password`} label={$t('security.password')} type="password" bind:value={password}
    autocomplete="current-password" required disabled={busy} error={passwordError} />
  {#if passkeyOffered}
    <fieldset class="method" disabled={busy}>
      <legend>{$t('security.method')}</legend>
      <RadioField id={`${id}-method-code`} name={`${id}-method`} label={$t('security.methodCode')} optionValue="totp" bind:value={method} />
      <RadioField id={`${id}-method-passkey`} name={`${id}-method`} label={$t('security.methodPasskey')} optionValue="passkey" bind:value={method} />
    </fieldset>
  {/if}
  {#if method === 'totp'}
    <TextField id={`${id}-code`} label={$t('security.code')} type="text" bind:value={code}
      autocomplete="one-time-code" inputmode="numeric" pattern={'[0-9]{6}'} minlength="6" maxlength="6" required
      disabled={busy} error={codeError} />
  {:else}
    <p class="hint">{$t('security.passkeyHint')}</p>
  {/if}
  {#if error}<Notice variant="error">{error}</Notice>{/if}
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="confirm" type="submit" disabled={busy || !ready}>{busy ? $t('security.generating') : $t('security.generate')}</DialogAction>
  </footer>
</form>

<style>
  .regeneration { display: grid; gap: var(--gap-group); margin: 0; }
  .lead { margin: 0; color: var(--text-dim); line-height: 1.6; }
  .method { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--gap-group); min-width: 0; margin: 0; padding: 0; border: 0; }
  .method legend { margin-block-end: var(--gap-item); padding: 0; font: 600 0.7rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.07em; }
  .hint { margin: 0; color: var(--text-dim); font-size: 0.8rem; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
</style>
