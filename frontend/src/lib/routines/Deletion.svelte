<script>
  import { call, commandsReady } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { t } from '#lib/i18n/index.js';
  import { Confirmation } from '#lib/auth/confirmation.svelte.js';
  import SecondFactor from '#lib/auth/SecondFactor.svelte';
  import { beginRoutineDeletion, deleteRoutine, RoutineError } from '#lib/routines/protocol.js';
  import { routineErrorMessage } from '#lib/routines/words.js';

  // Deleting one Routine (ADR-0051, ADR-0086): the whole panel is this confirmation. Admin checks the Supervisor
  // password, then one second factor bound to this Routine, and only then asks Team to delete it. A code is the
  // default; a passkey is offered beside it only where this address has one. Cancel returns to the panel. A failure
  // once Team was asked empties what was typed.
  let { teamId, routineId, copy, errors, busy = $bindable(false), ondone, oncancel } = $props();

  const id = $props.id();
  // Every confirmation's words, with this deletion's own where it differs: its hints, expiry, code lock, and buttons.
  let words = $derived({ ...$t('security'), ...copy, outcomeUnknown: $t('shell.outcomeUnknown') });
  const form = new Confirmation(id, {
    words: () => words,
    begin: (password) => beginRoutineDeletion(call, teamId, routineId, password),
    complete: async (factor) => (await deleteRoutine(call, teamId, routineId, factor)).deleted,
    ondone: (deleted) => ondone(deleted),
    errorType: RoutineError,
    failureWords: (failure) => routineErrorMessage(failure, errors),
    spendsProof: true,
  });

  $effect(() => form.open());
  $effect(() => {
    busy = form.busy;
  });
</script>

<form class="deletion" onsubmit={form.submit}>
  <div class="content">
    <p class="lead">{copy.lead}</p>
    <SecondFactor {id} copy={words} {form} />
  </div>
  <footer class="foot">
    <DialogAction kind="cancel" type="button" disabled={form.busy} onclick={oncancel}>{$t('security.cancel')}</DialogAction>
    <DialogAction kind="danger" type="submit" disabled={form.busy || !form.ready || !$commandsReady}>{form.busy ? copy.deleting : copy.delete}</DialogAction>
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
