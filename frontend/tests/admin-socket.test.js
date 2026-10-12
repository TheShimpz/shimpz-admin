import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { get } from 'svelte/store';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static opened = [];

  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;
    FakeSocket.opened.push(this);
  }

  send(text) {
    if (this.failSend) throw new Error('closed');
    this.sent.push(JSON.parse(text));
  }

  close(code = 1005) {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }

  open(protocol = this.protocol) {
    this.protocol = protocol;
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  frame(value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  drop(code) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  // Answer the newest call to `method` with `body`.
  answer(method, body, status = 200, extra = {}) {
    const call = this.sent.findLast((frame) => frame.type === 'call' && frame.method === method);
    assert.ok(call, `no ${method} call`);
    this.frame({ type: 'result', id: call.id, status, body, ...extra });
    return call;
  }
}

globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: 'http:', host: '127.0.0.1:7777' };
let sessionAnswer = { authenticated: true };
globalThis.fetch = async () => ({ ok: true, json: async () => sessionAnswer });

const socketModule = await import('../src/lib/adminSocket.js');
const {
  ACTIVITY_INTERVAL_MS,
  adminSocket,
  call,
  connectAdminSocket,
  disconnectAdminSocket,
  openChatChannel,
  sessionDeadlines,
  topicValue,
  trackActivity,
  watchTopic,
} = socketModule;

const EPOCH = 'a'.repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function connected(onSignedOut = () => {}) {
  FakeSocket.opened.length = 0;
  connectAdminSocket({ onSignedOut });
  const socket = FakeSocket.opened.at(-1);
  socket.open();
  return socket;
}

test.afterEach(() => {
  disconnectAdminSocket();
  sessionAnswer = { authenticated: true };
});

test('the shell opens one socket at the session path with the exact protocol', () => {
  const socket = connected();
  assert.equal(socket.url, 'ws://127.0.0.1:7777/api/session/ws');
  assert.equal(socket.protocol, 'shimpz.admin.v1');
  assert.equal(get(adminSocket).phase, 'open');
  disconnectAdminSocket();
  assert.equal(socket.closedWith, 1000);
  assert.equal(get(adminSocket).phase, 'idle');
});

test('a socket that does not speak the protocol is closed', () => {
  FakeSocket.opened.length = 0;
  connectAdminSocket({ onSignedOut() {} });
  FakeSocket.opened[0].open('shimpz.chat.v7');
  assert.equal(FakeSocket.opened[0].closedWith, 1002);
});

test('a call answers like a response, and fails at once while the socket is not open', async () => {
  await assert.rejects(call('teams.list'), (error) => error.code === 'socket-unavailable');
  const socket = connected();
  const pending = call('teams.list', {});
  const sent = socket.answer('teams.list', { teams: [] }, 200, { topic: 'teams', epoch: EPOCH, revision: 2 });
  assert.deepEqual(sent, { type: 'call', id: sent.id, method: 'teams.list', params: {} });
  const response = await pending;
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { teams: [] });
  assert.deepEqual(response.revision, { topic: 'teams', epoch: EPOCH, revision: 2 });
  const refused = call('history.page', { team_id: 'marketing' });
  socket.answer('history.page', { detail: 'Team not found' }, 404);
  assert.equal((await refused).status, 404);
});

test('a call made while the first open is under way waits for it, and fails if it never opens', async () => {
  FakeSocket.opened.length = 0;
  connectAdminSocket({ onSignedOut() {} });
  const waiting = call('teams.list');
  FakeSocket.opened[0].open();
  await flush();
  FakeSocket.opened[0].answer('teams.list', { teams: [] });
  assert.equal((await waiting).status, 200);

  disconnectAdminSocket();
  connectAdminSocket({ onSignedOut() {} });
  const abandoned = call('teams.list');
  disconnectAdminSocket();
  await assert.rejects(abandoned, (error) => error.code === 'socket-unavailable');
});

test('at most sixteen calls wait, and a close fails every pending call', async () => {
  const socket = connected();
  const calls = Array.from({ length: 16 }, () => call('teams.list'));
  await flush();
  await assert.rejects(call('teams.list'), (error) => error.status === 429);
  socket.drop(1006);
  for (const pending of calls) await assert.rejects(pending, (error) => error.code === 'socket-unavailable');
});

test('a malformed, unknown, or unexpected frame closes the socket', () => {
  for (const frame of [
    'not json',
    '[]',
    { type: 'result', id: 'x1', status: 200, body: {} },
    { type: 'result', id: 'bad id', status: 200, body: {} },
    { type: 'changed', topic: 'team/Marketing/history', epoch: EPOCH, revision: 1 },
    { type: 'changed', topic: 'teams', epoch: EPOCH, revision: 1, extra: true },
    { type: 'sync-empty' },
  ]) {
    const socket = connected();
    socket.frame(frame);
    assert.equal(socket.closedWith, 1002, JSON.stringify(frame));
    disconnectAdminSocket();
  }
});

test('a watched topic is subscribed, re-read on each newer change and after a reopen, and unsubscribed', async () => {
  const socket = connected();
  const heard = [];
  const stop = watchTopic('team/marketing/history', (topic, cause) => heard.push(cause === 'changed' ? topic : cause));
  // Topics watched in one turn share one subscription.
  const stopOther = watchTopic('teams', () => {});
  await flush();
  assert.deepEqual(socket.sent.filter((frame) => frame.method === 'subscribe').map((frame) => frame.params.topics), [
    ['team/marketing/history', 'teams'],
  ]);
  socket.answer('subscribe', { epoch: EPOCH, topics: { 'team/marketing/history': 3 } });
  await flush();
  // The listener reads once its subscription is in place, then only on a newer change.
  assert.deepEqual(heard.splice(0), ['subscribed']);
  socket.frame({ type: 'changed', topic: 'team/marketing/history', epoch: EPOCH, revision: 3 });
  assert.deepEqual(heard, []);
  socket.frame({ type: 'changed', topic: 'team/marketing/history', epoch: EPOCH, revision: 4 });
  socket.frame({ type: 'changed', topic: 'teams', epoch: EPOCH, revision: 9 });
  assert.deepEqual(heard, ['team/marketing/history']);
  // A new Admin process re-reads everything shown.
  socket.frame({ type: 'changed', topic: 'teams', epoch: 'b'.repeat(32), revision: 1 });
  assert.equal(heard.length, 2);
  assert.throws(() => watchTopic('team/marketing/inventory', () => {}), /Invalid Admin topic/);
  stop();
  stopOther();
  await flush();
  assert.deepEqual(socket.sent.at(-1).params, { topics: ['team/marketing/history', 'teams'] });
  assert.equal(socket.sent.at(-1).method, 'unsubscribe');
  // A topic watched and forgotten in the same turn changes no subscription.
  const sent = socket.sent.length;
  watchTopic('session', () => {})();
  await flush();
  assert.equal(socket.sent.length, sent);
  // One forgotten and watched again in the same turn keeps the subscription Admin holds, and reads at once.
  const kept = [];
  const stopKept = watchTopic('security/summary', () => {});
  await flush();
  socket.answer('subscribe', { epoch: EPOCH, topics: { 'security/summary': 0 } });
  await flush();
  stopKept();
  watchTopic('security/summary', (_topic, cause) => kept.push(cause));
  await flush();
  assert.deepEqual(kept, ['subscribed']);
  assert.equal(socket.sent.at(-1).method, 'subscribe');
});

test('a new Admin process starts every topic again: its revisions are never compared with the last one', async () => {
  const socket = connected();
  const heard = [];
  const stops = [
    watchTopic('teams', (_topic, cause) => heard.push(cause)),
    watchTopic('session', (_topic, cause) => heard.push(cause)),
  ];
  await flush();
  socket.answer('subscribe', { epoch: EPOCH, topics: { teams: 10, session: 4 } });
  await flush();
  heard.length = 0;
  const next = 'b'.repeat(32);
  // The first change of the new process re-reads everything shown, and each newer change of it is heard again.
  socket.frame({ type: 'changed', topic: 'teams', epoch: next, revision: 1 });
  assert.deepEqual(heard.splice(0), ['changed', 'changed']);
  socket.frame({ type: 'changed', topic: 'teams', epoch: next, revision: 1 });
  socket.frame({ type: 'changed', topic: 'teams', epoch: next, revision: 2 });
  socket.frame({ type: 'changed', topic: 'session', epoch: next, revision: 1 });
  assert.deepEqual(heard.splice(0), ['changed', 'changed']);
  // A reopened socket's subscription in a new process starts its revisions there too.
  socket.drop(1012);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 450));
  const reopened = FakeSocket.opened.at(-1);
  reopened.open();
  reopened.answer('subscribe', { epoch: 'c'.repeat(32), topics: { teams: 0, session: 0 } });
  await flush();
  heard.length = 0;
  reopened.frame({ type: 'changed', topic: 'teams', epoch: 'c'.repeat(32), revision: 1 });
  assert.deepEqual(heard, ['changed']);
  for (const stop of stops) stop();
});

test('a refused subscription is not in place: nothing is announced, and it is asked for again later', async () => {
  const socket = connected();
  const heard = [];
  const stop = watchTopic('teams', (_topic, cause) => heard.push(cause));
  await flush();
  socket.answer('subscribe', { detail: 'session change budget reached' }, 429);
  await flush();
  assert.deepEqual(heard, []);
  // A second reader of a topic that is not subscribed waits for it too.
  const second = [];
  const stopSecond = watchTopic('teams', (_topic, cause) => second.push(cause));
  await flush();
  assert.deepEqual(second, []);
  const asked = socket.sent.filter((frame) => frame.method === 'subscribe').length;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const again = socket.sent.filter((frame) => frame.method === 'subscribe');
  assert.equal(again.length, asked + 1);
  assert.deepEqual(again.at(-1).params, { topics: ['teams'] });
  socket.answer('subscribe', { epoch: EPOCH, topics: { teams: 0 } });
  await flush();
  assert.deepEqual(heard, ['subscribed']);
  assert.deepEqual(second, ['subscribed']);
  stop();
  stopSecond();
});

test('a refused unsubscription is asked for again, so a forgotten topic never keeps its place', async () => {
  const socket = connected();
  const stop = watchTopic('team/research/history', () => {});
  await flush();
  socket.answer('subscribe', { epoch: EPOCH, topics: { 'team/research/history': 0 } });
  await flush();
  stop();
  await flush();
  socket.answer('unsubscribe', { detail: 'session call budget reached' }, 429);
  await flush();
  const asked = socket.sent.filter((frame) => frame.method === 'unsubscribe').length;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const again = socket.sent.filter((frame) => frame.method === 'unsubscribe');
  assert.equal(again.length, asked + 1);
  assert.deepEqual(again.at(-1).params, { topics: ['team/research/history'] });
  socket.answer('unsubscribe', { epoch: EPOCH, topics: {} });
  await flush();
});

test('a subscription change never names more topics than Admin admits in one call', async () => {
  const socket = connected();
  const topics = Array.from({ length: 65 }, (_, index) => `team/t${index}/routines`);
  // Two rounds of watched topics, each forgotten and refused by Admin before any retry.
  for (const round of [topics.slice(0, 40), topics.slice(40)]) {
    const stops = round.map((topic) => watchTopic(topic, () => {}));
    await flush();
    socket.answer('subscribe', { epoch: EPOCH, topics: {} });
    await flush();
    for (const stop of stops) stop();
    await flush();
    socket.answer('unsubscribe', { detail: 'session call budget reached' }, 429);
    await flush();
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const retried = socket.sent.filter((frame) => frame.method === 'unsubscribe').slice(2);
  assert.ok(retried.length >= 2);
  assert.ok(retried.every((frame) => frame.params.topics.length <= 64));
  assert.deepEqual(new Set(retried.flatMap((frame) => frame.params.topics)), new Set(topics));
});

test('a subscription refused after a reopen is asked for again, and its readers read once it is in place', async () => {
  const socket = connected();
  const heard = [];
  const stop = watchTopic('session', (_topic, cause) => heard.push(cause));
  await flush();
  socket.answer('subscribe', { epoch: EPOCH, topics: { session: 0 } });
  await flush();
  socket.drop(1012);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 450));
  const reopened = FakeSocket.opened.at(-1);
  reopened.open();
  reopened.answer('subscribe', { detail: 'session change budget reached' }, 429);
  await flush();
  assert.deepEqual(heard, ['subscribed', 'reopen']);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  reopened.answer('subscribe', { epoch: EPOCH, topics: { session: 0 } });
  await flush();
  assert.deepEqual(heard, ['subscribed', 'reopen', 'subscribed']);
  stop();
});

test('a topic value reads once its subscription is in place, at a change, and once more after a change mid-read', async () => {
  const socket = connected();
  let reads = 0;
  let release;
  const value = topicValue('space/resources', () => {
    reads += 1;
    return new Promise((resolve) => { release = () => resolve(reads); });
  }, 'none');
  const seen = [];
  const stop = value.subscribe((current) => seen.push(current));
  await flush();
  // Nothing is read before the subscription answers, so no change can fall between a read and the subscription.
  assert.equal(reads, 0);
  socket.answer('subscribe', { epoch: EPOCH, topics: { 'space/resources': 4 } });
  await flush();
  assert.equal(reads, 1);
  socket.frame({ type: 'changed', topic: 'space/resources', epoch: EPOCH, revision: 5 });
  release();
  await flush();
  assert.equal(reads, 2);
  release();
  await flush();
  assert.deepEqual(seen, ['none', 1, 2]);
  // A second reader of a subscribed topic reads at once, after what is already on its way.
  const heard = [];
  const stopSecond = watchTopic('space/resources', (_topic, cause) => heard.push(cause));
  await flush();
  assert.deepEqual(heard, ['subscribed']);
  stopSecond();
  stop();
});

test('a close asks Admin about the session: signed out ends it, signed in reconnects and re-reads', async () => {
  const ended = mock.fn();
  const heard = [];
  FakeSocket.opened.length = 0;
  connectAdminSocket({ onSignedOut: ended });
  watchTopic('teams', (_topic, cause) => heard.push(cause));
  let socket = FakeSocket.opened.at(-1);
  socket.open();
  // The first open reads what is shown; a reopen reads it again.
  assert.deepEqual(heard, ['open']);
  sessionAnswer = { authenticated: true };
  socket.drop(1006);
  await flush();
  assert.equal(get(adminSocket).phase, 'reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 450));
  socket = FakeSocket.opened.at(-1);
  socket.open();
  await flush();
  assert.equal(get(adminSocket).phase, 'open');
  assert.deepEqual(heard, ['open', 'reopen']);
  assert.equal(socket.sent[0].method, 'subscribe');

  sessionAnswer = { authenticated: false };
  socket.drop(1006);
  await flush();
  assert.equal(ended.mock.callCount(), 1);
  assert.equal(get(adminSocket).phase, 'idle');
});

test('Admin closing the socket as signed out ends the session at once', async () => {
  const ended = mock.fn();
  const socket = connected(ended);
  socket.drop(4401);
  await flush();
  assert.equal(ended.mock.callCount(), 1);
});

test('a chat channel attaches, carries its Team on every frame, reattaches after a reopen, and detaches', async () => {
  const socket = connected();
  const channel = openChatChannel('marketing', 'en');
  await flush();
  const opened = mock.fn();
  const received = [];
  const closed = mock.fn();
  channel.onopen = opened;
  channel.onmessage = (event) => received.push(JSON.parse(event.data));
  channel.onclose = closed;
  assert.deepEqual(socket.answer('chat.attach', { team_id: 'marketing' }).params, { team_id: 'marketing', locale: 'en' });
  await flush();
  assert.equal(opened.mock.callCount(), 1);
  socket.frame({ type: 'sync-empty', team_id: 'marketing' });
  socket.frame({ type: 'done', team_id: 'marketing', team_name: 'Marketing', reply: 'Hi', clarification: null });
  // A frame for a Team this page no longer has a channel for is Admin's late frame after a detach: it is dropped.
  socket.frame({ type: 'stopped', team_id: 'sales' });
  assert.deepEqual(received, [
    { type: 'sync-empty' },
    { type: 'done', team_id: 'marketing', team_name: 'Marketing', reply: 'Hi', clarification: null },
  ]);
  channel.send(JSON.stringify({ type: 'stop' }));
  assert.deepEqual(socket.sent.at(-1), { type: 'stop', team_id: 'marketing' });
  assert.throws(() => channel.send(JSON.stringify({ type: 'call' })), /Invalid local chat request/);
  assert.throws(() => openChatChannel('marketing', 'en'), /Invalid local chat request/);
  assert.throws(() => openChatChannel('Bad Team', 'en'), /Invalid local chat request/);

  socket.drop(1006);
  await flush();
  assert.equal(closed.mock.callCount(), 1);
  assert.throws(() => channel.send(JSON.stringify({ type: 'stop' })), /reconnecting/);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const reopened = FakeSocket.opened.at(-1);
  reopened.open();
  await flush();
  reopened.answer('chat.attach', { team_id: 'marketing' });
  await flush();
  assert.equal(opened.mock.callCount(), 2);
  channel.close();
  assert.deepEqual(reopened.sent.at(-1).params, { team_id: 'marketing' });
  assert.equal(reopened.sent.at(-1).method, 'chat.detach');
});

test('a channel closed while it attached is detached again, and a refused attach closes it', async () => {
  const socket = connected();
  const early = openChatChannel('marketing', 'en');
  await flush();
  early.close();
  socket.answer('chat.attach', { team_id: 'marketing' });
  await flush();
  assert.equal(socket.sent.at(-1).method, 'chat.detach');

  const refused = openChatChannel('sales', 'en');
  const closed = mock.fn();
  refused.onclose = closed;
  await flush();
  socket.answer('chat.attach', { detail: 'full' }, 409);
  await flush();
  assert.equal(closed.mock.callCount(), 1);
});

test('the person\'s trusted input is reported at most once a minute, and only while the socket is open', async () => {
  const target = new EventTarget();
  const stop = trackActivity(target);
  const input = (type, isTrusted = true) => {
    const event = new Event(type);
    Object.defineProperty(event, 'isTrusted', { value: isTrusted });
    target.dispatchEvent(event);
  };
  const clock = mock.method(performance, 'now', () => 1_000_000);
  try {
    // Nothing is reported while no socket is open, and nothing is kept to replay once one opens.
    input('keydown');
    const socket = connected();
    assert.deepEqual(socket.sent.filter((frame) => frame.type === 'activity'), []);
    // An event the page dispatched itself is never the person's.
    for (const type of ['keydown', 'pointerdown', 'click', 'touchstart', 'wheel', 'input', 'compositionend']) input(type, false);
    assert.deepEqual(socket.sent.filter((frame) => frame.type === 'activity'), []);
    input('pointerdown');
    input('keydown');
    assert.deepEqual(socket.sent.filter((frame) => frame.type === 'activity'), [{ type: 'activity' }]);
    clock.mock.mockImplementation(() => 1_000_000 + ACTIVITY_INTERVAL_MS);
    input('compositionend');
    assert.equal(socket.sent.filter((frame) => frame.type === 'activity').length, 2);
    // A socket that fails to send reports nothing and loses nothing.
    clock.mock.mockImplementation(() => 1_000_000 + 2 * ACTIVITY_INTERVAL_MS);
    socket.failSend = true;
    input('wheel');
    socket.failSend = false;
    input('wheel');
    assert.equal(socket.sent.filter((frame) => frame.type === 'activity').length, 3);
    stop();
    clock.mock.mockImplementation(() => 1_000_000 + 3 * ACTIVITY_INTERVAL_MS);
    input('keydown');
    assert.equal(socket.sent.filter((frame) => frame.type === 'activity').length, 3);
  } finally {
    clock.mock.restore();
    stop();
  }
});

test('the session\'s deadlines are read from Admin\'s clock, and a malformed one closes the socket', () => {
  const socket = connected();
  const clock = mock.method(performance, 'now', () => 5_000);
  try {
    socket.frame({ type: 'session', idle_seconds: 3480, absolute_seconds: 82800 });
    assert.deepEqual(get(sessionDeadlines), { idleAt: 5_000 + 3_480_000, absoluteAt: 5_000 + 82_800_000 });
    for (const frame of [
      { type: 'session', idle_seconds: -1, absolute_seconds: 1 },
      { type: 'session', idle_seconds: 1.5, absolute_seconds: 1 },
      { type: 'session', idle_seconds: 1, absolute_seconds: 1, extra: true },
    ]) {
      const next = connected();
      next.frame(frame);
      assert.equal(next.closedWith, 1002);
    }
    disconnectAdminSocket();
    assert.equal(get(sessionDeadlines), null);
  } finally {
    clock.mock.restore();
  }
});
