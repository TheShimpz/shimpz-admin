<script>
  import { call, commandsReady } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { LocalApiError } from '#lib/api.js';
  import { t } from '#lib/i18n/index.js';
  import { Confirmation } from '#lib/auth/confirmation.svelte.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { beginSignInDeletion, deleteSignIn } from './signIns.js';

  // Deleting the Team's browser session (ADR-0117, 2026-10-20 amendment): Admin checks the Supervisor password, then
  // one second factor bound to the exact session shown (its generation and Team), and only then asks Team to delete
  // it. A code is the default; a passkey is offered beside it only where this address has one. A session that changed
  // meanwhile is refused, and the person opens it again to see what it holds now.
  let { teamId, signIn, copy, ondone, oncancel } = $props();

  const id = $props.id();
  let words = $derived({ ...$t('security'), ...copy, outcomeUnknown: $t('shell.outcomeUnknown') });
  const failures = { 'sign-in-changed': 'changed', 'sign-in-absent': 'absent' };
  const form = new Confirmation(id, {
    words: () => words,
    begin: (password) => beginSignInDeletion(teamId, password, call),
    complete: (factor) => deleteSignIn(teamId, signIn, factor, call),
    ondone: (outcome) => ondone(outcome),
    errorType: LocalApiError,
    failureWords: (failure) => copy[failures[failure.code]] ?? copy.failed,
    spendsProof: true,
  });

  $effect(() => form.open());
</script>

<form class="deletion" onsubmit={form.submit}>
  <p class="lead">{copy.lead}</p>
  <SecondFactor {id} copy={words} {form} />
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={form.busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="danger" type="submit" disabled={form.busy || !form.ready || !$commandsReady}>
      {form.busy ? copy.deleting : copy.delete}
    </DialogAction>
  </footer>
</form>

<style>
  .deletion { display: grid; gap: var(--gap-group); margin: 0; }
  .lead { max-width: 62ch; margin: 0; color: var(--shimpz-color-text); font-size: 0.9rem; line-height: 1.6; }
  .foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-group); }
  .foot > :global(:first-child) { margin-inline-end: auto; }
</style>
