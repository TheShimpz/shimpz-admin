import { writable } from 'svelte/store';

export const DEFAULT_ADMIN_NOTICE_DURATION_MS = 10_000;
export const MIN_ADMIN_NOTICE_DURATION_MS = 1_000;
export const MAX_ADMIN_NOTICE_DURATION_MS = 120_000;

const TONES = new Set(['error', 'info', 'success']);
let nextId = 0;

export const adminNotice = writable(null);

export function validAdminNoticeDuration(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_ADMIN_NOTICE_DURATION_MS &&
    value <= MAX_ADMIN_NOTICE_DURATION_MS
  );
}

function text(value, field, required = true) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 300 || (required && !value)) {
    throw new TypeError(`Invalid Admin notice ${field}.`);
  }
  return value;
}

export function showAdminNotice({ tone = 'info', label = '', message, durationMs = null } = {}) {
  if (!TONES.has(tone)) throw new TypeError('Invalid Admin notice tone.');
  if (
    durationMs !== null &&
    !validAdminNoticeDuration(durationMs)
  ) {
    throw new TypeError('Invalid Admin notice duration.');
  }
  const notice = {
    id: ++nextId,
    tone,
    label: text(label, 'label', false),
    message: text(message, 'message'),
    durationMs,
  };
  adminNotice.set(notice);
  return notice.id;
}

export function dismissAdminNotice(id) {
  let dismissed = false;
  adminNotice.update((notice) => {
    if (!notice || notice.id !== id) return notice;
    dismissed = true;
    return null;
  });
  return dismissed;
}

export function clearAdminNotice() {
  adminNotice.set(null);
}

export function createAdminNoticeTimer({ now, setTimer, clearTimer, onExpire, onPauseChange }) {
  if (![now, setTimer, clearTimer, onExpire, onPauseChange].every((callback) => typeof callback === 'function')) {
    throw new TypeError('Invalid Admin notice timer dependency.');
  }

  const holds = new Set();
  let activeId = null;
  let deadline = 0;
  let remainingMs = 0;
  let timer;

  function publishPause() {
    onPauseChange(activeId !== null && holds.size > 0);
  }

  function clearScheduledTimer() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    deadline = 0;
  }

  function expire() {
    if (activeId === null) return;
    const expiredId = activeId;
    clearScheduledTimer();
    activeId = null;
    remainingMs = 0;
    holds.clear();
    publishPause();
    onExpire(expiredId);
  }

  function schedule() {
    if (activeId === null || holds.size > 0) return;
    if (remainingMs <= 0) {
      expire();
      return;
    }
    const scheduledId = activeId;
    deadline = now() + remainingMs;
    timer = setTimer(() => {
      timer = undefined;
      deadline = 0;
      remainingMs = 0;
      if (activeId === scheduledId) expire();
    }, remainingMs);
  }

  function stop() {
    clearScheduledTimer();
    activeId = null;
    remainingMs = 0;
    holds.clear();
    publishPause();
  }

  function start(id, durationMs, initiallyPaused = false) {
    if (!Number.isSafeInteger(id) || id < 1 || !validAdminNoticeDuration(durationMs)) {
      throw new TypeError('Invalid Admin notice timer start.');
    }
    stop();
    activeId = id;
    remainingMs = durationMs;
    if (initiallyPaused) holds.add('hidden');
    publishPause();
    schedule();
  }

  function hold(reason) {
    if (activeId === null || holds.has(reason)) return;
    holds.add(reason);
    if (timer !== undefined) {
      remainingMs = Math.max(0, deadline - now());
      clearScheduledTimer();
    }
    publishPause();
    if (remainingMs <= 0) expire();
  }

  function release(reason) {
    holds.delete(reason);
    publishPause();
    if (activeId !== null && holds.size === 0) schedule();
  }

  return Object.freeze({ hold, release, start, stop });
}
