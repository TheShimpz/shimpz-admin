<script>
  import { DialogFrame, Modal, Notice } from '@shimpz/frontend';
  import DialogAction from '#lib/DialogAction.svelte';
  import { acknowledgeWebFile, saveFile } from '#lib/chat/attachments/files.js';
  import { t } from '#lib/i18n/index.js';
  import { recoverFocus } from '#lib/shell/focus.js';

  // Saving a file the Browser downloaded from the web (ADR-0117 §7): the dialog says what the file is and that it came
  // from a public website Shimpz did not check. Download records the Supervisor's acknowledgement with Team, which only
  // then releases the original, and saves it; Cancel, Esc, and the backdrop close it with nothing recorded. A failure
  // keeps the dialog open and says so.
  let { teamId, file, onclose } = $props();

  const id = $props.id();
  let dialog = $state();
  let busy = $state(false);
  let failed = $state(false);
  let copy = $derived($t('attachments').web);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  function close() {
    if (busy) return;
    dialog?.close();
    onclose();
  }

  function cancel(event) {
    event.preventDefault();
    close();
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    failed = false;
    try {
      await acknowledgeWebFile(teamId, file.id);
      await saveFile(teamId, file);
    } catch {
      failed = true;
      return;
    } finally {
      busy = false;
    }
    close();
  }
</script>

<Modal bind:element={dialog} labelledBy={`${id}-title`} oncancel={cancel}>
  <form onsubmit={submit} {@attach recoverFocus}>
    <DialogFrame kicker={copy.kicker} title={copy.title} titleId={`${id}-title`} lead={$t('attachments.web.lead', { name: file.name })}>
      <Notice variant="warning">{copy.risk}</Notice>
      {#if failed}<Notice variant="error">{copy.failed}</Notice>{/if}
      {#snippet footer()}
        <DialogAction kind="cancel" type="button" disabled={busy} onclick={close}>{copy.cancel}</DialogAction>
        <DialogAction kind="confirm" type="submit" disabled={busy}>{busy ? copy.downloading : copy.download}</DialogAction>
      {/snippet}
    </DialogFrame>
  </form>
</Modal>
