<script module>
  // How long before the session idles out the person is asked whether to stay signed in.
  export const WARNING_MS = 120_000;
</script>

<script>
  import { Button, Modal } from '@shimpz/frontend';

  import { sessionDeadlines } from '#lib/adminSocket.js';
  import { t } from '#lib/i18n.js';

  // Only the person's own input keeps the session alive (ADR-0114): a turn under way or a request waiting for them does
  // not. Shortly before it idles out, timed from Admin's clock, the person is asked; answering is their own input, which
  // the shell reports, so Admin restarts the idle time and tells the page its new deadline, which withdraws the warning.
  // A session about to reach its absolute expiry is not asked about: staying cannot extend it.
  const id = $props.id();
  let dialog = $state();
  let warning = $state(false);

  $effect(() => {
    const deadlines = $sessionDeadlines;
    warning = false;
    if (!deadlines || deadlines.absoluteAt <= deadlines.idleAt) return;
    const timer = setTimeout(() => {
      warning = true;
    }, Math.max(0, deadlines.idleAt - WARNING_MS - performance.now()));
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!dialog) return;
    if (warning && !dialog.open) dialog.showModal();
    else if (!warning && dialog.open) dialog.close();
  });

  function stay() {
    warning = false;
  }

  function cancel(event) {
    event.preventDefault();
    stay();
  }
</script>

<Modal bind:element={dialog} class="session-expiry" size="sm" labelledBy={`${id}-title`} role="alertdialog"
  aria-describedby={`${id}-body`} oncancel={cancel}>
  <div class="frame">
    <h2 id={`${id}-title`}>{$t('shell.sessionExpiring.title')}</h2>
    <p id={`${id}-body`}>{$t('shell.sessionExpiring.body')}</p>
    <Button type="button" onclick={stay}>{$t('shell.sessionExpiring.stay')}</Button>
  </div>
</Modal>

<style>
  .frame {
    display: grid;
    gap: var(--shimpz-space-3, 0.75rem);
    padding: var(--shimpz-space-5, 1.25rem);
    background: var(--shimpz-color-surface);
    border: 1px solid var(--shimpz-color-border);
  }
  h2 { margin: 0; font-size: 1.05rem; }
  p { margin: 0; color: var(--shimpz-color-text-muted); }
  .frame :global(.shimpz-button) { justify-self: end; }
</style>
