<script>
  import { get } from 'svelte/store';

  import { commandsReady } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { focusMark, regainFocus } from '#lib/shell/focus.js';
  import { t } from '#lib/i18n/index.js';
  import { isFactorCode } from '#lib/auth/factor.js';
  import { authenticateWithPasskey, passkeyFailure } from '#lib/auth/passkey.js';
  import { secondFactorRefusal } from '#lib/auth/refusal.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { SecurityError } from '#lib/auth/security.js';
  import { sessionContext } from '#lib/session/context.js';

  // A confirmed Supervisor operation (ADR-0051), such as replacing the recovery codes or the signing key: the Supervisor
  // password, then one second factor bound to it. A code is the default; a passkey is offered beside it only where this
  // address has one. `begin(password)` resolves to the offer, `complete(proof)` to what `ondone` receives, and
  // `failures` words the operation's own refusal codes. Both go over the Admin session socket, so the confirmation is
  // offered only while it is open; one it lost before Admin answered may or may not have happened, and says so.
  let {
    lead,
    action,
    working,
    passkeyHint,
    expired,
    begin,
    complete,
    failures = {},
    ondone,
    oncancel,
  } = $props();

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
  let ready = $derived(password.length > 0 && (method === 'passkey' || isFactorCode(code)));
  let fields = $derived({ ...$t('security'), passkeyHint });

  $effect(() => {
    document.getElementById(`${id}-password`)?.focus();
    return () => { live = false; };
  });

  // The field a refusal leaves to fix takes the focus once the controls the request disabled are enabled again; focus
  // the person moved meanwhile stays where it is.
  let refocus = '';
  let mark = 0;

  function regain() {
    const field = refocus;
    refocus = '';
    void regainFocus(() => document.getElementById(`${id}-${field}`), { shown: () => live, since: mark });
  }

  // Each refusal says what to fix where it is fixed; nothing typed is ever echoed back.
  function refused(failure) {
    const reason = failure instanceof SecurityError ? failure.code : '';
    const shown = secondFactorRefusal(failure, {
      reason,
      words: { ...$t('security'), expired, outcomeUnknown: $t('shell.outcomeUnknown') },
      operation: (other) => {
        if (!(other instanceof SecurityError)) return null;
        return Object.hasOwn(failures, other.code) ? failures[other.code] : $t('security.unavailable');
      },
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
      error = $t('security.passkeyMissing');
      refocus = 'code';
      return null;
    }
    return { credential: await authenticateWithPasskey(offer.passkey) };
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || !ready || !$commandsReady) return;
    busy = true;
    mark = focusMark();
    passwordError = codeError = error = '';
    try {
      const offer = await begin(password);
      const factor = live ? await proof(offer) : null;
      // A dialog closed while the passkey was asked for never runs the operation.
      if (!factor || !live) return;
      const result = await complete(factor);
      password = code = '';
      ondone(result);
    } catch (failure) {
      refused(failure);
    } finally {
      busy = false;
      if (refocus) regain();
    }
  }
</script>

<form class="regeneration" onsubmit={submit}>
  <p class="lead">{lead}</p>
  <SecondFactor {id} copy={fields} {busy} {passkeyOffered} bind:password bind:code bind:method {passwordError} {codeError}
    {error} />
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="confirm" type="submit" disabled={busy || !ready || !$commandsReady}>{busy ? working : action}</DialogAction>
  </footer>
</form>

<style>
  .regeneration { display: grid; gap: var(--gap-group); margin: 0; }
  .lead { margin: 0; color: var(--text-dim); line-height: 1.6; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
</style>
