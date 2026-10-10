<script>
  import DialogAction from '$lib/DialogAction.svelte';
  import { t } from '$lib/i18n.js';
  import { recoveryCodesText } from '$lib/security.js';

  // A fresh set of recovery codes (ADR-0051), shown this one time: Admin keeps only their digests. The Supervisor copies
  // or downloads them, then continues.
  let { codes, ondone } = $props();
  let status = $state('');

  function text() {
    return recoveryCodesText(codes, $t('security.codesFileHeading'));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      status = $t('security.copied');
    } catch {
      status = $t('security.copyFailed');
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'shimpz-recovery-codes.txt';
    document.body.append(link);
    link.click();
    link.remove();
    queueMicrotask(() => URL.revokeObjectURL(url));
  }
</script>

<div class="recovery-codes">
  <ol aria-label={$t('security.codesLabel')}>
    {#each codes as code (code)}<li><code>{code}</code></li>{/each}
  </ol>
  <div class="save">
    <DialogAction kind="confirm" variant="secondary" type="button" onclick={copy}>{$t('security.copy')}</DialogAction>
    <DialogAction kind="confirm" variant="secondary" type="button" onclick={download}>{$t('security.download')}</DialogAction>
  </div>
  <p class="status" role="status">{status}</p>
  <DialogAction kind="confirm" type="button" onclick={ondone}>{$t('security.codesDone')}</DialogAction>
</div>

<style>
  .recovery-codes { display: grid; gap: var(--gap-group); }
  ol { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap-item) var(--gap-group); margin: 0; padding: var(--gap-group); border: 1px solid var(--border); list-style: none; }
  code { color: var(--accent); font-family: var(--font-mono); font-size: 0.9rem; letter-spacing: 0.04em; }
  .save { display: flex; flex-wrap: wrap; gap: var(--gap-item); }
  .status { min-height: 1.2em; margin: 0; color: var(--text-dim); font-size: 0.8rem; }
  @media (max-width: 460px) { ol { grid-template-columns: 1fr; } }
</style>
