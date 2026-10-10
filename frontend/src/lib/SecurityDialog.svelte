<script>
  import { Button, Modal, Notice } from '@shimpz/frontend';

  import DialogAction from '$lib/DialogAction.svelte';
  import { t } from '$lib/i18n.js';
  import RecoveryCodes from '$lib/RecoveryCodes.svelte';
  import RecoveryCodesRegeneration from '$lib/RecoveryCodesRegeneration.svelte';
  import { securitySummary } from '$lib/security.js';

  // The Supervisor's sign-in security settings (ADR-0051): how many recovery codes are left, and replacing them all.
  let { dialog = $bindable(), onclose } = $props();
  const id = $props.id();
  // `summary` reads the counts, `confirm` asks for the password and a second factor, `codes` shows the new set once.
  let view = $state('summary');
  // The content exists only while the dialog is open, so nothing in it speaks to assistive technology meanwhile.
  let opened = $state(false);
  let codes = $state(null);
  let remaining = $derived($securitySummary?.recoveryCodesRemaining);

  export function open() {
    view = 'summary';
    codes = null;
    opened = true;
    dialog?.showModal();
  }

  function close() {
    view = 'summary';
    codes = null;
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
        <RecoveryCodesRegeneration ondone={replaced} oncancel={() => (view = 'summary')} />
      {:else}
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
  .recovery { display: grid; justify-items: start; gap: var(--gap-group); }
  .recovery p, .lead { margin: 0; color: var(--text-dim); line-height: 1.6; }
  svg { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.8; }
</style>
