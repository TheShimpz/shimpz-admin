<script>
  import { Button, Modal, Notice } from '@shimpz/frontend';

  import DialogAction from '$lib/DialogAction.svelte';
  import { locale, t } from '$lib/i18n.js';
  import RecoveryCodes from '$lib/RecoveryCodes.svelte';
  import OperationConfirmation from '$lib/OperationConfirmation.svelte';
  import {
    beginRecoveryCodes,
    beginSupervisorKeyRotation,
    replaceRecoveryCodes,
    rotateSupervisorKey,
    securitySummary,
  } from '$lib/security.js';

  // The Supervisor's sign-in security settings (ADR-0051): how many recovery codes are left, and replacing them all.
  let { dialog = $bindable(), onclose } = $props();
  const id = $props.id();
  // `summary` reads the counts, `confirm` asks for the password and a second factor before replacing the recovery codes,
  // `codes` shows the new set once, and `rotate` confirms replacing the Supervisor signing key.
  let view = $state('summary');
  // Set once a key replacement completed, until the dialog closes.
  let rotated = $state(false);
  // The content exists only while the dialog is open, so nothing in it speaks to assistive technology meanwhile.
  let opened = $state(false);
  let codes = $state(null);
  let remaining = $derived($securitySummary?.recoveryCodesRemaining);
  let signIns = $derived($securitySummary?.signIns);

  function signedInAt(at) {
    return new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
  }

  export function open() {
    view = 'summary';
    codes = null;
    rotated = false;
    opened = true;
    dialog?.showModal();
  }

  function close() {
    view = 'summary';
    codes = null;
    rotated = false;
    opened = false;
    dialog?.close();
    onclose?.();
  }

  function replaced(fresh) {
    codes = fresh;
    view = 'codes';
  }
</script>

<Modal bind:element={dialog} class="security-dialog" size="md" labelledBy={`${id}-title`} oncancel={(event) => { event.preventDefault(); close(); }}>
  {#if opened}
  <div class="frame">
    <header class="head">
      <h2 id={`${id}-title`}>{$t('security.title')}</h2>
      <Button variant="ghost" size="sm" iconOnly type="button" aria-label={$t('security.close')} title={$t('security.close')} onclick={close}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </Button>
    </header>
    <div class="body">
      {#if view === 'codes' && codes}
        <h3>{$t('security.codesTitle')}</h3>
        <p class="lead">{$t('security.codesLead')}</p>
        <RecoveryCodes {codes} ondone={() => { codes = null; view = 'summary'; }} />
      {:else if view === 'confirm'}
        <OperationConfirmation
          lead={$t('security.regenerateLead')}
          action={$t('security.generate')}
          working={$t('security.generating')}
          passkeyHint={$t('security.passkeyHint')}
          expired={$t('security.expired')}
          begin={beginRecoveryCodes}
          complete={replaceRecoveryCodes}
          ondone={replaced}
          oncancel={() => (view = 'summary')}
        />
      {:else if view === 'rotate'}
        <OperationConfirmation
          lead={$t('security.rotateLead')}
          action={$t('security.rotate')}
          working={$t('security.rotating')}
          passkeyHint={$t('security.rotatePasskeyHint')}
          expired={$t('security.rotateExpired')}
          begin={beginSupervisorKeyRotation}
          complete={rotateSupervisorKey}
          failures={{
            'supervisor-key-rotation-refused': $t('security.rotateRefused'),
            'supervisor-key-rotation-pending': $t('security.rotatePending'),
            'supervisor-key-rotation-busy': $t('security.rotateBusy'),
            'supervisor-key-unavailable': $t('security.rotateUnavailable'),
          }}
          ondone={() => { rotated = true; view = 'summary'; }}
          oncancel={() => (view = 'summary')}
        />
      {:else}
        <section class="history" aria-labelledby={`${id}-history`}>
          <h3 id={`${id}-history`}>{$t('security.historyLabel')}</h3>
          {#if !signIns}
            <p>{$t('security.historyUnavailable')}</p>
          {:else}
            <p>
              {signIns.previous
                ? $t('security.lastSignIn', {
                  time: signedInAt(signIns.previous.at),
                  origin: signIns.previous.origin ?? $t('security.originUnknown'),
                })
                : $t('security.lastSignInNone')}
            </p>
            {#if signIns.previous}<p>{$t('security.failuresSince', { count: signIns.failuresSince })}</p>{/if}
          {/if}
        </section>
        <section class="recovery" aria-labelledby={`${id}-codes`}>
          <h3 id={`${id}-codes`}>{$t('security.codesLabel')}</h3>
          {#if remaining === undefined}
            <Notice variant="error">{$t('security.summaryUnavailable')}</Notice>
          {:else if remaining === 0}
            <Notice variant="warning">{$t('security.codesNone')}</Notice>
          {:else}
            <p>{$t('security.codesRemaining', { count: remaining })}</p>
          {/if}
          <DialogAction kind="confirm" variant="secondary" type="button" onclick={() => (view = 'confirm')}>{$t('security.regenerate')}</DialogAction>
        </section>
        <section class="key" aria-labelledby={`${id}-key`}>
          <h3 id={`${id}-key`}>{$t('security.keyLabel')}</h3>
          <p>{$t('security.keyLead')}</p>
          {#if rotated}<Notice variant="success">{$t('security.rotated')}</Notice>{/if}
          <DialogAction kind="confirm" variant="secondary" type="button" onclick={() => { rotated = false; view = 'rotate'; }}>{$t('security.rotate')}</DialogAction>
        </section>
      {/if}
    </div>
  </div>
  {/if}
</Modal>

<style>
  .frame { display: grid; background: var(--shimpz-color-surface); border: 1px solid var(--shimpz-color-border); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-group); padding: var(--gap-group) var(--gap-panel); border-block-end: 1px solid var(--shimpz-color-border); }
  h2 { margin: 0; font-size: 1rem; }
  h3 { margin: 0; color: var(--text-dim); font: 700 0.72rem/1 var(--shimpz-font-mono); letter-spacing: 0.09em; text-transform: uppercase; }
  .body { display: grid; gap: var(--gap-group); padding: var(--gap-panel); }
  .recovery, .history, .key { display: grid; justify-items: start; gap: var(--gap-group); }
  .recovery p, .history p, .key p, .lead { margin: 0; color: var(--text-dim); line-height: 1.6; }
  svg { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
</style>
