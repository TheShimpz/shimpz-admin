import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

import {
  adminNotice,
  clearAdminNotice,
  createAdminNoticeTimer,
  dismissAdminNotice,
  showAdminNotice,
} from '../src/lib/shell/notice.js';

test.afterEach(clearAdminNotice);

test('replaces notices atomically and only lets their owner dismiss them', () => {
  const firstId = showAdminNotice({ tone: 'info', message: 'First notice' });
  const secondId = showAdminNotice({
    tone: 'success',
    label: 'Installed',
    message: 'Second notice',
  });

  assert.notEqual(firstId, secondId);
  assert.equal(dismissAdminNotice(firstId), false);
  assert.deepEqual(get(adminNotice), {
    id: secondId,
    tone: 'success',
    label: 'Installed',
    message: 'Second notice',
  });
  assert.equal(dismissAdminNotice(secondId), true);
  assert.equal(get(adminNotice), null);
});

test('refuses an unknown tone and untrimmed text', () => {
  assert.throws(() => showAdminNotice({ tone: 'unknown', message: 'Bad tone' }), /tone/);
  assert.throws(() => showAdminNotice({ message: ' padded ' }), /message/);
});

function fakeClock() {
  let currentTime = 0;
  let nextTimerId = 0;
  const timers = new Map();
  return {
    now: () => currentTime,
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, due: currentTime + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    elapseWithoutTimers(delay) { currentTime += delay; },
    advance(delay) {
      currentTime += delay;
      for (const [id, timer] of [...timers].sort((left, right) => left[1].due - right[1].due)) {
        if (timer.due > currentTime || !timers.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

test('a dismissed focused notice cannot freeze the next notice', () => {
  const clock = fakeClock();
  const expired = [];
  const pauses = [];
  const timer = createAdminNoticeTimer({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: (id) => expired.push(id),
    onPauseChange: (paused) => pauses.push(paused),
  });

  timer.start(1, 10_000);
  clock.advance(2_000);
  timer.hold('pointer');
  timer.hold('focus');
  timer.stop();
  timer.start(2, 10_000);
  clock.advance(9_999);
  assert.deepEqual(expired, []);
  clock.advance(1);
  assert.deepEqual(expired, [2]);
  assert.equal(pauses.at(-1), false);
});

test('expires at a pause race and resumes an initially hidden notice safely', () => {
  const clock = fakeClock();
  const expired = [];
  const timer = createAdminNoticeTimer({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: (id) => expired.push(id),
    onPauseChange: () => {},
  });

  timer.start(3, 1_000);
  clock.elapseWithoutTimers(1_000);
  timer.hold('focus');
  assert.deepEqual(expired, [3]);

  timer.start(4, 1_000, true);
  clock.advance(5_000);
  assert.deepEqual(expired, [3]);
  timer.release('hidden');
  clock.advance(999);
  assert.deepEqual(expired, [3]);
  clock.advance(1);
  assert.deepEqual(expired, [3, 4]);
});
