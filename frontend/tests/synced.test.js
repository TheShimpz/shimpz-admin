import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/adminSocket.js';
import { RETRY_FIRST_MS, synced, transientFailure } from '../src/lib/synced.js';
import { LocalApiError } from '../src/lib/validate.js';
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
  return {
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
  assert.deepEqual(get(value), { status: 'ready', value: ['one'], error: null });
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
    assert.deepEqual(get(value), { status: 'ready', value: ['kept'], error: null });
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

test('a value no screen shows reads again when one shows it, and an answer after it stopped is dropped', async () => {
  const socket = harness();
  const value = synced('local-assistants', snapshots);
  let { stop } = shown(value);
  socket.announce('open', 1);
  stop();
  socket.answer(0, { assistants: ['late'] }, 1);
  await flush();
  assert.equal(get(value).value, null);
  ({ stop } = shown(value));
  socket.announce('subscribed', 1);
  assert.equal(socket.calls.length, 2);
  socket.answer(1, { assistants: ['shown'] }, 1);
  await flush();
  assert.deepEqual(get(value).value, ['shown']);
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
  assert.deepEqual(get(value), { status: 'loading', value: null, error: null });
  socket.answer(1, { assistants: ['previous session'] }, 2);
  await flush();
  assert.equal(get(value).value, null);
  stop();
});
