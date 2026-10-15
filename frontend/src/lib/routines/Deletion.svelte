<script>
  import { get } from 'svelte/store';

  import { call, commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { authenticateWithPasskey, passkeyFailure } from '#lib/auth/passkey.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { beginRoutineDeletion, deleteRoutine, RoutineError } from '#lib/routines/protocol.js';
  import { routineErrorMessage } from '#lib/routines/words.js';
  import { sessionContext } from '#lib/session/context.js';
  import { LocalApiError } from '#lib/api.js';

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
  // Every confirmation's words, with this deletion's own where it differs: its hints, expiry, code lock, and buttons.
  let words = $derived({ ...$t('security'), ...copy });

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
      passwordError = words.passwordIncorrect;
      focus('password');
    } else if (reason === 'code-incorrect') {
      code = '';
      codeError = words.codeIncorrect;
      focus('code');
    } else if (reason === 'authentication-locked') {
      error = fill(words.locked, { seconds: failure.retryAfter || 60 });
    } else if (reason === 'code-locked') {
      code = '';
      error = words.codeLocked;
    } else if (reason === 'authentication-expired') {
      error = words.expired;
    } else if (reason === 'passkey-failed' || reason === 'passkey-suspended') {
      error = words.passkeyFailed;
    } else if (reason === 'authentication-unavailable' || reason === 'authentication-origin-refused') {
      error = words.unavailable;
    } else if (failure instanceof RoutineError) {
      error = routineErrorMessage(failure, errors);
    } else if (outcomeUnknown(failure)) {
      error = $t('shell.outcomeUnknown');
    } else if (failure instanceof LocalApiError) {
      // The socket dropped before the request left: nothing was asked, and the panel stays for another try.
      error = words.unavailable;
    } else {
      error = words[passkeyFailure(failure) === 'canceled' ? 'passkeyCanceled' : 'passkeyFailed'];
    }
  }

  async function proof(offer) {
    if (method === 'totp') return { code };
    if (!offer.passkey) {
      passkeyOffered = false;
      method = 'totp';
      error = words.passkeyMissing;
      focus('code');
      return null;
    }
    return { credential: await authenticateWithPasskey(offer.passkey) };
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !ready || !$commandsReady) return;
    busy = true;
    passwordError = codeError = error = '';
    let sent = false;
    try {
      const offer = await beginRoutineDeletion(call, teamId, routineId, password);
      const factor = live ? await proof(offer) : null;
      // A panel closed while the passkey was asked for never sends the deletion.
      if (!factor || !live) return;
      sent = true;
      const { deleted } = await deleteRoutine(call, teamId, routineId, factor);
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
    <SecondFactor {id} copy={words} {busy} {passkeyOffered} bind:password bind:code bind:method {passwordError} {codeError}
      {error} />
  </div>
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="danger" type="submit" disabled={busy || !ready || !$commandsReady}>{busy ? copy.deleting : copy.delete}</DialogAction>
  </footer>
</form>

<style>
  .deletion { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-height: 0; margin: 0; }
  .content { display: grid; align-content: start; gap: var(--gap-group); min-width: 0; padding: var(--gap-panel); overflow: auto; }
  .lead { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); padding: var(--gap-group) var(--gap-panel); border-block-start: 1px solid var(--shimpz-color-border); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
  @media (forced-colors: active) { .foot { border-color: CanvasText; } }
</style>
