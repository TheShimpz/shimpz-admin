<script>
  import { Notice } from '@shimpz/frontend';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import DialogAction from '#lib/DialogAction.svelte';
  import { t } from '#lib/i18n/index.js';
  import { acknowledgeFailedAttempts, securitySummary } from '#lib/auth/security.js';
  import { recoverFocus } from '#lib/shell/focus.js';

  // The second-factor attempts refused since the previous sign-in (ADR-0051). The report stays on every page until the
  // Supervisor acknowledges the exact count it shows; one refused meanwhile keeps it on screen. The summary is read over
  // the session socket while it is shown, and again whenever Admin says it changed.
  let busy = $state(false);
  let error = $state('');
  let count = $derived($securitySummary?.failedAttempts ?? 0);

  async function acknowledge() {
    if (busy || count < 1) return;
    busy = true;
    error = '';
    try {
      await acknowledgeFailedAttempts(count);
    } catch (failure) {
      error = $t(outcomeUnknown(failure) ? 'shell.outcomeUnknown' : 'security.acknowledgeFailed');
    } finally {
      busy = false;
    }
  }

</script>

{#if count > 0}
  <!-- Acknowledge, which its request disabled, takes back the focus it dropped once enabled again. -->
  <div class="security-alert" {@attach recoverFocus}>
    <Notice variant="warning" title={$t('security.alertTitle')}>
      <p>{$t('security.alertMessage', { count })}</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <DialogAction kind="confirm" type="button" size="sm" disabled={busy || !$commandsReady} onclick={acknowledge}>
        {busy ? $t('security.acknowledging') : $t('security.acknowledge')}
      </DialogAction>
    </Notice>
  </div>
{/if}

<style>
  .security-alert { padding: var(--gap-group) var(--gap-panel) 0; }
  .security-alert p { margin: 0 0 var(--gap-item); }
  .error { color: var(--shimpz-color-danger, var(--text)); }
</style>
