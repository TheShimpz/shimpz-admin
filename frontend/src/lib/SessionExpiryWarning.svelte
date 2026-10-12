<script module>
  // How long before the session idles out the person is asked whether to stay signed in.
  export const WARNING_MS = 120_000;
</script>

<script>
  import { Button, Modal } from '@shimpz/frontend';

  import { sessionDeadlines } from '#lib/adminSocket.js';
  import { locale, t } from '#lib/i18n.js';

  // Only the person's own input keeps the session alive (ADR-0114): a turn under way or a request waiting for them does
  // not. Shortly before it idles out, timed from Admin's clock, the person is asked; answering is their own input, which
  // the shell reports, so Admin restarts the idle time and tells the page its new deadline. Only that confirmation
  // withdraws the warning: one Admin did not renew stays in front of the person. A session about to reach its absolute
  // expiry is not asked about: staying cannot extend it.
  const id = $props.id();
  let dialog = $state();
  let warning = $state(false);
  let now = $state(performance.now());
  // The seconds left before the session idles out, in the visible title; the dialog is named by its fixed title, so the
  // countdown is never announced every second.
  let remaining = $derived(
    $sessionDeadlines ? Math.max(0, Math.ceil(($sessionDeadlines.idleAt - now) / 1000)) : 0,
  );
  let countdown = $derived(
    new Intl.NumberFormat($locale, { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(remaining),
  );

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
    if (!warning) return;
    now = performance.now();
    const timer = setInterval(() => {
      now = performance.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (!dialog) return;
    if (warning && !dialog.open) dialog.showModal();
    else if (!warning && dialog.open) dialog.close();
  });

  // Pressing the button, like Escape, is the person's input the shell reports; the renewed deadline closes the warning.
  function stay() {}

  function cancel(event) {
    event.preventDefault();
  }
</script>

<Modal bind:element={dialog} class="session-expiry" size="sm" labelledBy={`${id}-title`} role="alertdialog"
  aria-describedby={`${id}-body`} oncancel={cancel}>
  <div class="frame">
    <h2>
      <span class="sr-only" id={`${id}-title`}>{$t('shell.sessionExpiring.title')}</span>
      <span aria-hidden="true">{$t('shell.sessionExpiring.countdown', { time: countdown })}</span>
    </h2>
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
  h2 { font-variant-numeric: tabular-nums; }
</style>
