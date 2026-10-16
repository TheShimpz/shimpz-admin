import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/session/socket.js';
import { dataUnavailable, RETRY_FIRST_MS, synced, transientFailure } from '../src/lib/session/synced.js';
import { LocalApiError } from '../src/lib/api.js';
import { response } from './socketStub.js';

const EPOCH = 'a'.repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The socket as a synced value sees it: one watched topic whose subscription, changes, and reopens the test drives,
// and calls the test answers one by one, each with the revision of the topic its result reflects.
function harness() {
  const listeners = new Set();
  const calls = [];
  socketReads.watch = (topic, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  socketReads.call = (method, params) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }));
  // Whether Admin holds the subscription now: a test closes and reopens the socket by setting `open`.
  const socket = { open: true };
  socketReads.subscribed = () => socket.open;
  return {
    socket,
    calls,
    listeners,
    announce(cause, revision, epoch = EPOCH) {
      for (const listener of [...listeners]) listener('local-assistants', cause, { epoch, revision });
    },
    answer(index, body, revision, epoch = EPOCH) {
      const answered = response(200, body);
      answered.revision = revision === undefined ? null : { topic: 'local-assistants', epoch, revision };
      calls[index].resolve(answered);
    },
  };
}

// A read of the staged snapshots through the call the synced value hands it, failing as the screen's reader would.
async function snapshots(call) {
  const answered = await call('snapshots.list', {});
  const body = await answered.json();
  if (!answered.ok) throw new LocalApiError(body.detail ?? 'unavailable', answered.status);
  return body.assistants;
}

function shown(value) {
  const seen = [];
  const stop = value.subscribe((state) => seen.push(state));
  return { seen, stop };
}

test('nothing is read until the subscription is in place, then once, and the value is ready', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  assert.equal(socket.calls.length, 0);
  assert.equal(get(value).status, 'loading');
  socket.announce('open', 4);
  assert.equal(socket.calls.length, 1);
  socket.answer(0, { assistants: ['one'] }, 4);
  await flush();
  assert.deepEqual(get(value), { status: 'ready', value: ['one'], error: null, failing: null });
  // A subscription again at the revision the value reflects reads nothing more.
  socket.announce('reopen', 4);
  assert.equal(socket.calls.length, 1);
  stop();
});

test('one read runs at a time, so an older answer never overwrites a newer value', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  socket.announce('changed', 2);
  socket.announce('changed', 3);
  // The changes heard while the first read ran wait for it, and are read once, after it.
  assert.equal(socket.calls.length, 1);
  socket.answer(0, { assistants: ['old'] }, 1);
  await flush();
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['new'] }, 3);
  await flush();
  assert.deepEqual(get(value).value, ['new']);
  assert.equal(socket.calls.length, 2);
  stop();
});

test('a change announced during a read, or a read older than what Admin announced, is read again', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  // The read's own result reflects revision 1, yet the subscription said 1 and a change to 2 lands meanwhile.
  socket.announce('changed', 2);
  socket.answer(0, { assistants: ['old'] }, 1);
  await flush();
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['new'] }, 2);
  await flush();
  assert.deepEqual(get(value).value, ['new']);
  stop();
});

test('a subscription in place at a newer revision than the value reads again; an older one does not', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 2);
  socket.answer(0, { assistants: ['one'] }, 2);
  await flush();
  socket.announce('reopen', 2);
  assert.equal(socket.calls.length, 1);
  socket.announce('reopen', 5);
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['two'] }, 5);
  await flush();
  // A new Admin process numbers its revisions from the start: anything read from the last one is read again.
  socket.announce('reopen', 0, 'b'.repeat(32));
  assert.equal(socket.calls.length, 3);
  stop();
});

test('each synced value knows only the revision its own reads reflected', async () => {
  const socket = harness();
  const list = synced('local-assistants', snapshots);
  const summary = synced('local-assistants', async (call) => {
    const answered = await call('snapshots.summary', { image_id: 'x', locale: 'en' });
    return (await answered.json()).summary;
  });
  const stops = [shown(list).stop, shown(summary).stop];
  socket.announce('open', 2);
  assert.deepEqual(socket.calls.map((item) => item.method), ['snapshots.list', 'snapshots.summary']);
  // The list's read reflects revision 2, the summary's a newer 3: the list is still older than Admin's 3.
  socket.answer(0, { assistants: ['stale'] }, 2);
  socket.answer(1, { summary: 'fresh' }, 3);
  await flush();
  socket.announce('reopen', 3);
  assert.deepEqual(socket.calls.map((item) => item.method), ['snapshots.list', 'snapshots.summary', 'snapshots.list']);
  for (const stop of stops) stop();
});

test('a transient failure keeps the last value and reads again after a capped backoff; a refusal is shown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = harness();
    const value = synced('local-assistants', snapshots);
    const { stop } = shown(value);
    socket.announce('open', 1);
    socket.answer(0, { assistants: ['kept'] }, 1);
    await flush();
    socket.announce('changed', 2);
    socket.calls[1].resolve(response(503, { detail: 'Team is unavailable' }));
    await flush();
    // The last value stays, and the failure is named while the value is read again on its own.
    assert.equal(get(value).status, 'ready');
    assert.deepEqual(get(value).value, ['kept']);
    assert.equal(get(value).failing.status, 503);
    mock.timers.tick(RETRY_FIRST_MS);
    assert.equal(socket.calls.length, 3);
    socket.calls[2].resolve(response(503, { detail: 'Team is unavailable' }));
    await flush();
    // The second wait doubles.
    mock.timers.tick(RETRY_FIRST_MS);
    assert.equal(socket.calls.length, 3);
    mock.timers.tick(RETRY_FIRST_MS);
    assert.equal(socket.calls.length, 4);
    socket.answer(3, { assistants: ['back'] }, 2);
    await flush();
    assert.deepEqual(get(value).value, ['back']);
    assert.equal(get(value).failing, null);
    // A refusal is no outage: it is shown, with the last value kept, until a change reads again.
    socket.announce('changed', 3);
    socket.calls[4].resolve(response(404, { detail: 'Team not found' }));
    await flush();
    assert.equal(get(value).status, 'error');
    assert.equal(get(value).error.status, 404);
    assert.deepEqual(get(value).value, ['back']);
    mock.timers.tick(60_000);
    assert.equal(socket.calls.length, 5);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('refresh settles only once a read started after it has ended', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  let settled = false;
  const refreshed = value.refresh().then(() => { settled = true; });
  socket.answer(0, { assistants: ['before'] }, 1);
  await flush();
  assert.equal(settled, false);
  socket.answer(1, { assistants: ['after'] }, 1);
  await refreshed;
  assert.deepEqual(get(value).value, ['after']);
  stop();
});

test('the last screen leaving forgets the value and drops an answer still on its way', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  let { stop } = shown(value);
  socket.announce('open', 1);
  socket.answer(0, { assistants: ['shown'] }, 1);
  await flush();
  socket.announce('changed', 2);
  stop();
  // Protected data never outlives the screens that show it.
  assert.deepEqual(get(value), { status: 'loading', value: null, error: null, failing: null });
  socket.answer(1, { assistants: ['late'] }, 2);
  await flush();
  assert.equal(get(value).value, null);
  ({ stop } = shown(value));
  assert.equal(get(value).value, null);
  socket.announce('subscribed', 2);
  assert.equal(socket.calls.length, 3);
  socket.answer(2, { assistants: ['again'] }, 2);
  await flush();
  assert.deepEqual(get(value).value, ['again']);
  stop();
});

test('data no topic announces is read when shown and retried until it is read', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = harness();
    const value = synced(null, snapshots);
    const { stop } = shown(value);
    assert.equal(socket.calls.length, 1);
    assert.equal(socket.listeners.size, 0);
    socket.calls[0].reject(new LocalApiError('Admin is reconnecting.', 0, 'socket-unavailable'));
    await flush();
    // The connection is the shell's to speak of: it is no failure of this value.
    assert.equal(get(value).failing, null);
    mock.timers.tick(RETRY_FIRST_MS);
    socket.calls[1].resolve(response(200, { assistants: ['catalog'] }));
    await flush();
    assert.deepEqual(get(value).value, ['catalog']);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('only an outage, an overload, or a server failure is transient', () => {
  assert.equal(transientFailure(new LocalApiError('x', 0)), true);
  assert.equal(transientFailure(new LocalApiError('x', 429)), true);
  assert.equal(transientFailure(new LocalApiError('x', 503)), true);
  assert.equal(transientFailure(new LocalApiError('x', 409)), false);
  // A broken stored key record never heals by itself, whatever its status.
  assert.equal(transientFailure(new LocalApiError('x', 503, 'credential-record-invalid')), false);
  assert.equal(transientFailure(new TypeError('x')), true);
});

test('a reset forgets the value, and a read under way when it came never shows', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  socket.answer(0, { assistants: ['first'] }, 1);
  await flush();
  socket.announce('changed', 2);
  value.reset();
  assert.deepEqual(get(value), { status: 'loading', value: null, error: null, failing: null });
  socket.answer(1, { assistants: ['previous session'] }, 2);
  await flush();
  assert.equal(get(value).value, null);
  // The screen still showing it reads it again for the new session.
  assert.equal(socket.calls.length, 3);
  stop();
});

test('a read of an earlier era never ends the current one, so two reads never overlap', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  // The session ends while the first read is on its way; the screen still shows the value, so it reads again at once.
  value.reset();
  assert.equal(socket.calls.length, 2);
  socket.announce('changed', 2);
  // The earlier era's answer arrives last-but-one: it publishes nothing and leaves the current read in charge.
  socket.answer(0, { assistants: ['previous session'] }, 1);
  await flush();
  assert.equal(get(value).value, null);
  socket.announce('changed', 3);
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['current'] }, 2);
  await flush();
  // One more read for the changes heard meanwhile, and only one.
  assert.equal(socket.calls.length, 3);
  socket.answer(2, { assistants: ['newest'] }, 3);
  await flush();
  assert.deepEqual(get(value).value, ['newest']);
  assert.equal(socket.calls.length, 3);
  stop();
});

test('a refresh asked for before the subscription is in place reads only once it is', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  let settled = false;
  const refreshed = value.refresh().then(() => { settled = true; });
  await flush();
  assert.equal(socket.calls.length, 0);
  socket.announce('open', 1);
  assert.equal(socket.calls.length, 1);
  socket.answer(0, { assistants: ['first'] }, 1);
  await refreshed;
  assert.equal(settled, true);
  assert.deepEqual(get(value).value, ['first']);
  stop();
});

test('a reset while a screen still shows the value reads it again under the subscription it holds', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  const { stop } = shown(value);
  socket.announce('open', 1);
  socket.answer(0, { assistants: ['first'] }, 1);
  await flush();
  value.reset();
  assert.equal(get(value).status, 'loading');
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['again'] }, 1);
  await flush();
  assert.deepEqual(get(value).value, ['again']);
  stop();
});

test('the shell hears that some shown data keeps failing, and that it no longer does once it reads or is not shown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = harness();
    const first = synced('local-assistants', snapshots);
    const second = synced('local-assistants', snapshots);
    const shownFirst = shown(first);
    const shownSecond = shown(second);
    socket.announce('open', 1);
    socket.calls[0].resolve(response(503, { detail: 'Team is unavailable' }));
    socket.calls[1].resolve(response(503, { detail: 'Team is unavailable' }));
    await flush();
    assert.equal(get(dataUnavailable), true);
    mock.timers.tick(RETRY_FIRST_MS);
    socket.answer(2, { assistants: ['one'] }, 1);
    await flush();
    // One value still fails: the shell still says so.
    assert.equal(get(dataUnavailable), true);
    // A failing value no screen shows any more is no longer the shell's to speak of.
    shownSecond.stop();
    assert.equal(get(dataUnavailable), false);
    // An outage of Admin's own connection is the shell's other message, never this one.
    socket.announce('changed', 2);
    socket.calls[4]?.reject(new LocalApiError('Admin is reconnecting.', 0, 'socket-unavailable'));
    await flush();
    assert.equal(get(dataUnavailable), false);
    shownFirst.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a refusal stays shown through later transient failures, until a read succeeds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = harness();
    const value = synced('local-assistants', snapshots);
    const { stop } = shown(value);
    socket.announce('open', 1);
    socket.answer(0, { assistants: ['cached'] }, 1);
    await flush();
    socket.announce('changed', 2);
    socket.calls[1].resolve(response(403, { detail: 'refused' }));
    await flush();
    assert.equal(get(value).status, 'error');
    socket.announce('changed', 3);
    socket.calls[2].resolve(response(503, { detail: 'Team is unavailable' }));
    await flush();
    // The outage says nothing about whether the refusal still holds: it stays shown, beside the failure.
    assert.equal(get(value).status, 'error');
    assert.equal(get(value).error.status, 403);
    assert.equal(get(value).failing.status, 503);
    mock.timers.tick(RETRY_FIRST_MS);
    socket.answer(3, { assistants: ['back'] }, 3);
    await flush();
    assert.deepEqual(get(value), { status: 'ready', value: ['back'], error: null, failing: null });
    stop();
  } finally {
    mock.timers.reset();
  }
});

// A value read for the session (`retain`) outlives the screens that show it, until its revision moves or it ages.
test('a value kept for the session shows at once to the next screen and reads again only when stale or aged', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
  const first = shown(value);
  socket.announce('subscribed', 4);
  const answered = response(200, { assistants: ['one'] });
  answered.revision = { topic: 'local-assistants', epoch: EPOCH, revision: 4 };
  Object.defineProperty(answered, 'bytes', { value: 1234 });
  socket.calls[0].resolve(answered);
  await flush();
  assert.equal(value.size(), 1234);
  first.stop();
  // The next screen sees the value in its first state, and Admin still at that revision means no read.
  const second = shown(value);
  assert.deepEqual(second.seen[0], { status: 'ready', value: ['one'], error: null, failing: null });
  socket.announce('subscribed', 4);
  assert.equal(socket.calls.length, 1);
  second.stop();
  // A revision that moved while no screen watched it is read again, the kept value showing meanwhile.
  const third = shown(value);
  socket.announce('subscribed', 5);
  assert.equal(socket.calls.length, 2);
  assert.equal(get(value).status, 'ready');
  socket.answer(1, { assistants: ['two'] }, 5);
  await flush();
  assert.deepEqual(get(value).value, ['two']);
  third.stop();
  // The session ends: the value is forgotten, and the next screen reads it from the start.
  value.reset();
  assert.equal(get(value).status, 'loading');
  assert.equal(value.size(), 0);
});

test('a value kept for the session with no allowed age reads again whenever a screen shows it', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: 0 } });
  let screen = shown(value);
  socket.announce('subscribed', 1);
  socket.answer(0, { assistants: ['one'] }, 1);
  await flush();
  screen.stop();
  screen = shown(value);
  socket.announce('subscribed', 1);
  assert.equal(socket.calls.length, 2);
  assert.deepEqual(screen.seen[0].value, ['one']);
  screen.stop();
});

test('leaving drops a kept value\'s read under way and its retry, and a refusal is never kept', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
  let screen = shown(value);
  socket.announce('subscribed', 1);
  socket.answer(0, { assistants: ['one'] }, 1);
  await flush();
  socket.announce('changed', 2);
  assert.equal(socket.calls.length, 2);
  screen.stop();
  // The answer of the read the screen left is never shown, and a failure of it never retries.
  socket.answer(1, { assistants: ['late'] }, 2);
  await flush();
  assert.deepEqual(get(value).value, ['one']);
  // Shown again, the revision it missed is read.
  screen = shown(value);
  socket.announce('subscribed', 2);
  assert.equal(socket.calls.length, 3);
  socket.calls[2].resolve(response(403, { detail: 'refused' }));
  await flush();
  assert.equal(get(value).status, 'error');
  screen.stop();
  assert.equal(get(value).status, 'loading');
  assert.equal(get(value).value, null);
});

test('data no topic announces, kept for the session, is read again only once it is older than allowed', async () => {
  const socket = harness();
  let now = 1_000;
  const clock = mock.method(performance, 'now', () => now);
  try {
    const value = synced(null, snapshots, { retain: { maxAgeMs: 60_000 } });
    let screen = shown(value);
    socket.answer(0, { assistants: ['catalog'] });
    await flush();
    screen.stop();
    now += 59_000;
    screen = shown(value);
    assert.equal(socket.calls.length, 1);
    assert.deepEqual(screen.seen[0].value, ['catalog']);
    screen.stop();
    now += 2_000;
    screen = shown(value);
    assert.equal(socket.calls.length, 2);
    screen.stop();
  } finally {
    clock.mock.restore();
  }
});

// Whether `current()` has settled yet, and with what.
function outcome(promise) {
  const seen = { value: null };
  void promise.then((result) => { seen.value = result; });
  return seen;
}

test('each read is handed the value read before it, never one a read of an ended era would have made', async () => {
  const socket = harness();
  const lasts = [];
  const value = synced('local-assistants', async (call, last) => {
    lasts.push(last);
    return [...(last ?? []), ...await snapshots(call)];
  }, { retain: { maxAgeMs: Infinity } });
  let screen = shown(value);
  socket.announce('subscribed', 1);
  socket.answer(0, { assistants: ['one'] }, 1);
  await flush();
  socket.announce('changed', 2);
  screen.stop();
  // The read the screen left ends after it left: what it built is never the base of the next read.
  socket.answer(1, { assistants: ['late'] }, 2);
  await flush();
  screen = shown(value);
  socket.announce('subscribed', 2);
  socket.answer(2, { assistants: ['two'] }, 2);
  await flush();
  assert.deepEqual(lasts, [null, ['one'], ['one']]);
  assert.deepEqual(get(value).value, ['one', 'two']);
  screen.stop();
});

test('a kept value Admin still holds is current once subscribed, without a read', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
  let screen = shown(value);
  socket.announce('subscribed', 3);
  socket.answer(0, { assistants: ['one'] }, 3);
  await flush();
  screen.stop();
  screen = shown(value);
  const known = outcome(value.current());
  await flush();
  assert.equal(known.value, null);
  socket.announce('subscribed', 3);
  await flush();
  assert.equal(known.value, 'current');
  assert.equal(socket.calls.length, 1);
  screen.stop();
});

test('a stale kept value is current only after the read that succeeds, through failures and their retries', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const socket = harness();
    const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
    let screen = shown(value);
    socket.announce('subscribed', 1);
    socket.answer(0, { assistants: ['one'] }, 1);
    await flush();
    screen.stop();
    screen = shown(value);
    const known = outcome(value.current());
    socket.announce('subscribed', 2);
    socket.calls[1].resolve(response(503, { detail: 'busy' }));
    await flush();
    assert.equal(known.value, null);
    // A change heard before the retry is due reads at once; its success makes the value current and drops the retry.
    socket.announce('changed', 3);
    socket.answer(2, { assistants: ['three'] }, 3);
    await flush();
    assert.equal(known.value, 'current');
    mock.timers.tick(RETRY_FIRST_MS);
    assert.equal(socket.calls.length, 3);
    assert.equal((await value.current()), 'current');
    screen.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a refused read, a screen leaving, and a reset each settle what waits for a current value', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
  let screen = shown(value);
  const refused = outcome(value.current());
  socket.announce('subscribed', 1);
  socket.calls[0].resolve(response(403, { detail: 'refused' }));
  await flush();
  assert.equal(refused.value, 'refused');
  screen.stop();
  assert.equal(await value.current(), 'gone');
  screen = shown(value);
  const left = outcome(value.current());
  screen.stop();
  await flush();
  assert.equal(left.value, 'gone');
  screen = shown(value);
  const reset = outcome(value.current());
  value.reset();
  await flush();
  assert.equal(reset.value, 'gone');
  screen.stop();
});

test('a value read again while the socket reopened is current only once Admin acknowledges the new subscription', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots, { retain: { maxAgeMs: Infinity } });
  const screen = shown(value);
  socket.announce('subscribed', 1);
  const known = outcome(value.current());
  // The socket closes while the read runs; the read is answered on the reopened socket before its subscription is.
  socket.socket.open = false;
  socket.answer(0, { assistants: ['one'] }, 1);
  await flush();
  assert.equal(known.value, null);
  socket.socket.open = true;
  socket.announce('reopen', 1);
  await flush();
  assert.equal(known.value, 'current');
  screen.stop();
});
