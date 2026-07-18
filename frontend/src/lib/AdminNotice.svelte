<script>
  import { onMount } from 'svelte';

  import {
    DEFAULT_ADMIN_NOTICE_DURATION_MS,
    createAdminNoticeTimer,
    adminNotice,
    dismissAdminNotice,
    validAdminNoticeDuration,
  } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';

  let { defaultDurationMs = DEFAULT_ADMIN_NOTICE_DURATION_MS } = $props();

  let host = $state();
  let paused = $state(false);

  let closeLabel = $derived($t('integration.close'));
  let safeDefaultDurationMs = $derived(
    validAdminNoticeDuration(defaultDurationMs)
      ? defaultDurationMs
      : DEFAULT_ADMIN_NOTICE_DURATION_MS,
  );
  let durationMs = $derived($adminNotice?.durationMs ?? safeDefaultDurationMs);

  const noticeTimer = createAdminNoticeTimer({
    now: () => Date.now(),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
    onExpire: dismissAdminNotice,
    onPauseChange: (value) => { paused = value; },
  });

  function focusLeft() {
    queueMicrotask(() => {
      if (!host?.contains(document.activeElement)) noticeTimer.release('focus');
    });
  }

  function visibilityChanged() {
    if (document.hidden) noticeTimer.hold('hidden');
    else noticeTimer.release('hidden');
  }

  function dismissCurrentNotice() {
    const id = $adminNotice?.id;
    if (!id) return;
    noticeTimer.stop();
    dismissAdminNotice(id);
  }

  $effect(() => {
    const notice = $adminNotice;
    if (notice) noticeTimer.start(notice.id, notice.durationMs ?? safeDefaultDurationMs, document.hidden);
    else noticeTimer.stop();
    return () => noticeTimer.stop();
  });

  onMount(() => {
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      noticeTimer.stop();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  });
</script>

{#if $adminNotice}
  {#key $adminNotice.id}
    <section
      bind:this={host}
      class:error={$adminNotice.tone === 'error'}
      class:success={$adminNotice.tone === 'success'}
      class:paused
      class="admin-notice"
      role={$adminNotice.tone === 'error' ? 'alert' : 'status'}
      aria-live={$adminNotice.tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      style={`--notice-duration:${durationMs}ms`}
      onmouseenter={() => noticeTimer.hold('pointer')}
      onmouseleave={() => noticeTimer.release('pointer')}
      onfocusin={() => noticeTimer.hold('focus')}
      onfocusout={focusLeft}
    >
      <span class="notice-progress" aria-hidden="true"></span>
      <div class="notice-copy">
        {#if $adminNotice.label}<span>{$adminNotice.label}</span>{/if}
        <strong>{$adminNotice.message}</strong>
      </div>
      <button type="button" onclick={dismissCurrentNotice} aria-label={closeLabel}>×</button>
    </section>
  {/key}
{/if}

<style>
  .admin-notice {
    position: relative;
    z-index: 5;
    display: grid;
    min-height: 3.75rem;
    place-items: center;
    overflow: hidden;
    padding: 0.8rem 3.7rem;
    border-bottom: 1px solid var(--admin-divider);
    background: rgba(0, 240, 255, 0.045);
    isolation: isolate;
  }
  .admin-notice::after {
    position: absolute;
    z-index: -2;
    inset: 0;
    background: linear-gradient(90deg, rgba(0, 240, 255, 0.035), transparent 38%, rgba(255, 61, 242, 0.025));
    content: '';
  }
  .admin-notice.error { background: rgba(255, 96, 125, 0.055); }
  .admin-notice.success { background: rgba(5, 255, 161, 0.05); }
  .notice-progress {
    position: absolute;
    z-index: -1;
    inset: 0;
    background: linear-gradient(90deg, rgba(0, 240, 255, 0.02), rgba(0, 240, 255, 0.1));
    transform: scaleX(0);
    transform-origin: left;
    animation: notice-progress var(--notice-duration) linear forwards;
  }
  .error .notice-progress { background: linear-gradient(90deg, rgba(255, 96, 125, 0.025), rgba(255, 96, 125, 0.1)); }
  .success .notice-progress { background: linear-gradient(90deg, rgba(5, 255, 161, 0.025), rgba(5, 255, 161, 0.1)); }
  .paused .notice-progress { animation-play-state: paused; }
  .notice-copy { display: flex; max-width: min(72rem, 100%); align-items: baseline; justify-content: center; gap: 0.8rem; text-align: center; }
  .notice-copy span { color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase; }
  .error .notice-copy span { color: var(--danger); }
  .success .notice-copy span { color: var(--success); }
  .notice-copy strong { color: var(--text); font-size: clamp(0.82rem, 1.2vw, 0.96rem); line-height: 1.45; }
  button { position: absolute; top: 50%; inset-inline-end: 1rem; display: grid; width: 2rem; height: 2rem; place-items: center; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; font-family: var(--font-mono); font-size: 1.2rem; transform: translateY(-50%); }
  button:hover { background: rgba(255, 255, 255, 0.055); color: var(--accent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; background: rgba(255, 255, 255, 0.075); color: var(--accent); }
  @keyframes notice-progress { to { transform: scaleX(1); } }
  @media (prefers-reduced-motion: reduce) { .notice-progress { animation-name: none; transform: none; } }
  @media (max-width: 620px) { .admin-notice { padding-inline: 2.8rem; } .notice-copy { align-items: center; flex-direction: column; gap: 0.2rem; } button { inset-inline-end: 0.45rem; } }
</style>
