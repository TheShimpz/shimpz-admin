<script>
  import { Notice } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import DialogAction from '$lib/DialogAction.svelte';
  import { t } from '$lib/i18n.js';
  import { acknowledgeFailedAttempts, clearSecuritySummary, loadSecuritySummary, securitySummary } from '$lib/security.js';

  // The second-factor attempts refused since the previous sign-in (ADR-0051). The report stays on every page until the
  // Supervisor acknowledges the exact count it shows; one refused meanwhile keeps it on screen.
  let busy = $state(false);
  let error = $state('');
  let count = $derived($securitySummary?.failedAttempts ?? 0);

  async function acknowledge() {
    if (busy || count < 1) return;
    busy = true;
    error = '';
    try {
      await acknowledgeFailedAttempts(fetch, count);
    } catch {
      error = $t('security.acknowledgeFailed');
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    // Without a summary there is nothing to report; the next sign-in reads it again.
    loadSecuritySummary().catch(() => {});
    return clearSecuritySummary;
  });
</script>

{#if count > 0}
  <div class="security-alert">
    <Notice variant="warning" title={$t('security.alertTitle')}>
      <p>{$t('security.alertMessage', { count })}</p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <DialogAction kind="confirm" type="button" size="sm" disabled={busy} onclick={acknowledge}>
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
