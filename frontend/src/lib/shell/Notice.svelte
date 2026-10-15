<script>
  import { Toast } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import {
    DEFAULT_ADMIN_NOTICE_DURATION_MS,
    createAdminNoticeTimer,
    adminNotice,
    dismissAdminNotice,
  } from '#lib/shell/notice.js';
  import { t } from '#lib/i18n/index.js';

  let host = $state();
  let paused = $state(false);
  let closeLabel = $derived($t('shell.close'));

  const noticeTimer = createAdminNoticeTimer({
    now: () => Date.now(),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    onExpire: dismissAdminNotice,
    onPauseChange: (value) => { paused = value; },
  });

  function focusLeft() { queueMicrotask(() => { if (!host?.contains(document.activeElement)) noticeTimer.release('focus'); }); }
  function visibilityChanged() { if (document.hidden) noticeTimer.hold('hidden'); else noticeTimer.release('hidden'); }
  function dismissCurrentNotice() {
    const id = $adminNotice?.id;
    if (!id) return;
    noticeTimer.stop();
    dismissAdminNotice(id);
  }

  $effect(() => {
    const notice = $adminNotice;
    if (notice) noticeTimer.start(notice.id, DEFAULT_ADMIN_NOTICE_DURATION_MS, document.hidden);
    else noticeTimer.stop();
    return () => noticeTimer.stop();
  });

  onMount(() => {
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { noticeTimer.stop(); document.removeEventListener('visibilitychange', visibilityChanged); };
  });
</script>

{#if $adminNotice}
  {#key $adminNotice.id}
    <Toast
      bind:element={host}
      class="admin-toast"
      tone={$adminNotice.tone === 'error' ? 'error' : $adminNotice.tone === 'success' ? 'success' : 'info'}
      label={$adminNotice.label}
      durationMs={DEFAULT_ADMIN_NOTICE_DURATION_MS}
      {paused}
      {closeLabel}
      onClose={dismissCurrentNotice}
      onmouseenter={() => noticeTimer.hold('pointer')}
      onmouseleave={() => noticeTimer.release('pointer')}
      onfocusin={() => noticeTimer.hold('focus')}
      onfocusout={focusLeft}
    >{$adminNotice.message}</Toast>
  {/key}
{/if}
