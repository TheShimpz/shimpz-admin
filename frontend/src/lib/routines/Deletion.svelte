<script>
  import { tick } from 'svelte';
  import { get } from 'svelte/store';

  import { call, commandsReady } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { t } from '#lib/i18n/index.js';
  import { authenticateWithPasskey, passkeyFailure } from '#lib/auth/passkey.js';
  import { isFactorCode } from '#lib/auth/factor.js';
  import { AUTHENTICATION_REFUSALS, secondFactorRefusal } from '#lib/auth/refusal.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { beginRoutineDeletion, deleteRoutine, RoutineError } from '#lib/routines/protocol.js';
  import { routineErrorMessage } from '#lib/routines/words.js';
  import { sessionContext } from '#lib/session/context.js';

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
  let ready = $derived(password.length > 0 && (method === 'passkey' || isFactorCode(code)));
  // Every confirmation's words, with this deletion's own where it differs: its hints, expiry, code lock, and buttons.
  let words = $derived({ ...$t('security'), ...copy });

  $effect(() => {
    document.getElementById(`${id}-password`)?.focus();
    return () => { live = false; };
  });

  // The field a refusal leaves to fix takes the focus once the controls the request disabled are enabled again; focus
  // the person moved meanwhile stays where it is.
  let refocus = '';

  async function regain() {
    const field = refocus;
    refocus = '';
    await tick();
    const focused = document.activeElement;
    if (live && (!focused || focused === document.body)) document.getElementById(`${id}-${field}`)?.focus();
  }

  // Each refusal says what to fix where it is fixed; nothing typed is ever echoed back.
  function refused(failure) {
    const reason = failure instanceof RoutineError ? failure.code : '';
    const shown = secondFactorRefusal(failure, {
      reason,
      words: { ...words, outcomeUnknown: $t('shell.outcomeUnknown') },
      operation: (other) => (other instanceof RoutineError ? routineErrorMessage(other, errors) : null),
      ceremony: passkeyFailure,
    });
    if (shown.clear === 'password') password = '';
    if (shown.clear === 'code') code = '';
    passwordError = shown.passwordError ?? '';
    codeError = shown.codeError ?? '';
    error = shown.error ?? '';
    // A refusal of the whole form names no field: the password, enabled again, takes the focus.
    refocus = shown.focus ?? 'password';
  }

  async function proof(offer) {
    if (method === 'totp') return { code };
    if (!offer.passkey) {
      passkeyOffered = false;
      method = 'totp';
      error = words.passkeyMissing;
      refocus = 'code';
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
      // Admin refused the proof itself, so Team was never asked: what was typed stays for the next try.
      if (sent && !(failure instanceof RoutineError && AUTHENTICATION_REFUSALS.has(failure.code))) password = code = '';
      refused(failure);
    } finally {
      busy = false;
      if (refocus) void regain();
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
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); padding: var(--gap-group) var(--gap-panel); border-block-start: 1px solid var(--shimpz-color-border); border-radius: 0; }
  .foot > :global(:first-child) { margin-inline-end: auto; }
  @media (forced-colors: active) { .foot { border-color: CanvasText; } }
</style>
