<script>
  import { commandsReady } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { t } from '#lib/i18n/index.js';
  import { Confirmation } from '#lib/auth/confirmation.svelte.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { SecurityError } from '#lib/auth/security.js';

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
  let words = $derived({ ...$t('security'), passkeyHint, expired, outcomeUnknown: $t('shell.outcomeUnknown') });
  const form = new Confirmation(id, {
    words: () => words,
    begin: (password) => begin(password),
    complete: (factor) => complete(factor),
    ondone: (result) => ondone(result),
    errorType: SecurityError,
    failureWords: (failure) => (Object.hasOwn(failures, failure.code) ? failures[failure.code] : $t('security.unavailable')),
    spendsProof: false,
  });

  $effect(() => form.open());
</script>

<form class="regeneration" onsubmit={form.submit}>
  <p class="lead">{lead}</p>
  <SecondFactor {id} copy={words} busy={form.busy} passkeyOffered={form.passkeyOffered} bind:password={form.password}
    bind:code={form.code} bind:method={form.method} passwordError={form.passwordError} codeError={form.codeError}
    error={form.error} />
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={form.busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="confirm" type="submit" disabled={form.busy || !form.ready || !$commandsReady}>{form.busy ? working : action}</DialogAction>
  </footer>
</form>

<style>
  .regeneration { display: grid; gap: var(--gap-group); margin: 0; }
  .lead { margin: 0; color: var(--text-dim); line-height: 1.6; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
</style>
