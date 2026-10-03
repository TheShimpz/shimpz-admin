<script>
  import { Notice, RadioField, TextField } from '@shimpz/frontend';
  import { get } from 'svelte/store';

  import DialogAction from '$lib/DialogAction.svelte';
  import { authenticateWithPasskey, passkeyFailure } from '$lib/passkey.js';
  import { beginRoutineDeletion, deleteRoutine, fillRoutineCopy, routineErrorMessage, RoutineError } from '$lib/routine.js';
  import { sessionContext } from '$lib/sessionContext.js';

  // Deleting one Routine (ADR-0051, ADR-0086): the whole panel is this confirmation. Admin checks the Supervisor
  // password, then one second factor bound to this Routine, and only then asks Team to delete it. A code is the
  // default; a passkey is offered beside it only where this address has one. Cancel returns to the panel.
  let { teamId, routineId, copy, errors, busy = $bindable(false), ondone, oncancel } = $props();

  const id = $props.id();
  let password = $state('');
  let code = $state('');
  let method = $state('totp');
  let passkeyOffered = $state(get(sessionContext).passkeyRegistered);
  let passwordError = $state('');
  let codeError = $state('');
  let error = $state('');
  let live = true;
  // Admin refused the proof itself, so Team was never asked: what was typed stays for the next try.
  const REFUSALS = new Set([
    'password-incorrect', 'authentication-locked', 'code-incorrect', 'code-locked', 'authentication-expired',
    'passkey-failed', 'passkey-suspended', 'authentication-unavailable', 'authentication-origin-refused',
  ]);
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
    const reason = failure instanceof RoutineError ? failure.code : '';
    if (reason === 'password-incorrect') {
      password = '';
      passwordError = copy.passwordIncorrect;
      focus('password');
    } else if (reason === 'code-incorrect') {
      code = '';
      codeError = copy.codeIncorrect;
      focus('code');
    } else if (reason === 'authentication-locked') {
      error = fillRoutineCopy(copy.locked, { seconds: failure.retryAfter || 60 });
    } else if (reason === 'code-locked') {
      code = '';
      error = copy.codeLocked;
    } else if (reason === 'authentication-expired') {
      error = copy.expired;
    } else if (reason === 'passkey-failed' || reason === 'passkey-suspended') {
      error = copy.passkeyFailed;
    } else if (reason === 'authentication-unavailable' || reason === 'authentication-origin-refused') {
      error = copy.unavailable;
    } else if (failure instanceof RoutineError) {
      error = routineErrorMessage(failure, errors);
    } else {
      error = copy[passkeyFailure(failure) === 'canceled' ? 'passkeyCanceled' : 'passkeyFailed'];
    }
  }

  async function proof(offer) {
    if (method === 'totp') return { code };
    if (!offer.passkey) {
      passkeyOffered = false;
      method = 'totp';
      error = copy.passkeyMissing;
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
    let sent = false;
    try {
      const offer = await beginRoutineDeletion(fetch, teamId, routineId, password);
      const factor = live ? await proof(offer) : null;
      // A panel closed while the passkey was asked for never sends the deletion.
      if (!factor || !live) return;
      sent = true;
      const { deleted } = await deleteRoutine(fetch, teamId, routineId, factor);
      password = code = '';
      ondone(deleted);
    } catch (failure) {
      if (sent && !(failure instanceof RoutineError && REFUSALS.has(failure.code))) password = code = '';
      refused(failure);
    } finally {
      busy = false;
    }
  }
</script>

<form class="deletion" onsubmit={submit}>
  <div class="content">
    <p class="lead">{copy.lead}</p>
    <TextField id={`${id}-password`} label={copy.password} type="password" bind:value={password}
      autocomplete="current-password" required disabled={busy} error={passwordError} />
    {#if passkeyOffered}
      <fieldset class="method" disabled={busy}>
        <legend>{copy.method}</legend>
        <RadioField id={`${id}-method-code`} name={`${id}-method`} label={copy.methodCode} optionValue="totp" bind:value={method} />
        <RadioField id={`${id}-method-passkey`} name={`${id}-method`} label={copy.methodPasskey} optionValue="passkey" bind:value={method} />
      </fieldset>
    {/if}
    {#if method === 'totp'}
      <TextField id={`${id}-code`} label={copy.code} hint={copy.codeHint} type="text" bind:value={code}
        autocomplete="one-time-code" inputmode="numeric" pattern={'[0-9]{6}'} minlength="6" maxlength="6" required
        disabled={busy} error={codeError} />
    {:else}
      <p class="hint">{copy.passkeyHint}</p>
    {/if}
    {#if error}<Notice variant="error">{error}</Notice>{/if}
  </div>
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={busy} onclick={oncancel}>{copy.cancel}</DialogAction>
    <DialogAction kind="danger" type="submit" disabled={busy || !ready}>{busy ? copy.deleting : copy.delete}</DialogAction>
  </footer>
</form>

<style>
  .deletion { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; margin: 0; }
  .content { display: grid; align-content: start; gap: var(--shimpz-space-4); min-width: 0; padding: var(--shimpz-space-4); overflow: auto; }
  .lead { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; }
  .method { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--shimpz-space-2); min-width: 0; margin: 0; padding: 0; border: 0; }
  .method legend { margin-block-end: 0.4rem; padding: 0; color: var(--shimpz-color-text); font: 600 0.7rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.07em; }
  .hint { margin: 0; color: var(--shimpz-color-text-dim); font-size: 0.8rem; line-height: 1.45; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--shimpz-space-2); padding: var(--shimpz-space-3) var(--shimpz-space-4); border-block-start: 1px solid var(--shimpz-color-border); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
  @media (forced-colors: active) { .foot { border-color: CanvasText; } }
</style>
