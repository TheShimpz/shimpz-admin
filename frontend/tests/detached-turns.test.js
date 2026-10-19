import assert from 'node:assert/strict';
import test from 'node:test';

import { socketReads } from '../src/lib/session/socket.js';
import { forgetChatLimit, loadChatLimit, saveChatLimit } from '../src/lib/chat/limit/store.js';
import { parseChatEvent } from '../src/lib/chat/protocol.js';
import { listChatHistory } from '../src/lib/chat/history.js';
import { historyTurn } from '../src/lib/chat/turns.js';
import { escapeMarkdownText } from '../src/lib/chat/markdown.js';
import { messages } from '../src/lib/i18n/catalogs.js';
import { recorder, response } from './socketStub.js';

const words = messages.en.chatPage;
const AT = '2026-10-01T12:00:00Z';
const TURN = 'a'.repeat(32);
const step = (seq) => ({ type: 'progress', seq, origin: 'team', phase: 'model', state: 'started' });

test('a running event is where the Team chat is: its time, queue place, and latest steps ending at its cursor', () => {
  const running = parseChatEvent(
    { type: 'running', elapsed_ms: 1500, position: null, cursor: 5, events: [step(4), step(5)] },
    'marketing',
    'Marketing',
  );
  assert.deepEqual(running, {
    type: 'running',
    elapsed_ms: 1500,
    position: null,
    cursor: 5,
    events: [
      { type: 'progress', seq: 4, origin: 'team', phase: 'model', state: 'started' },
      { type: 'progress', seq: 5, origin: 'team', phase: 'model', state: 'started' },
    ],
  });
  assert.equal(parseChatEvent({ type: 'running', elapsed_ms: 0, position: 3, cursor: 0, events: [] }).position, 3);
  for (const invalid of [
    { type: 'running', elapsed_ms: -1, position: null, cursor: 0, events: [] },
    { type: 'running', elapsed_ms: 0, position: 0, cursor: 0, events: [] },
    { type: 'running', elapsed_ms: 0, position: 33, cursor: 0, events: [] },
    { type: 'running', elapsed_ms: 0, position: null, cursor: -1, events: [] },
    { type: 'running', elapsed_ms: 0, position: null, cursor: 2, events: [step(1)] },
    { type: 'running', elapsed_ms: 0, position: null, cursor: 1, events: [{ ...step(1), type: 'done' }] },
    { type: 'running', elapsed_ms: 0, position: null, cursor: 0, events: {} },
    { type: 'running', elapsed_ms: 0, position: null, cursor: 0, events: [], extra: 1 },
  ]) {
    assert.throws(() => parseChatEvent(invalid, 'marketing', 'Marketing'), JSON.stringify(invalid));
  }
});

test('a turn that ended without a reply reads back as how it ended', async () => {
  const entries = [
    { id: `${TURN}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Book it' },
    { id: `${TURN}:status`, created_at: AT, kind: 'status', state: 'stopped' },
    {
      id: `${'b'.repeat(32)}:status`,
      created_at: AT,
      kind: 'status',
      state: 'failed',
      status: 503,
      detail: 'Brain runtime is unavailable',
    },
  ];
  const page = await listChatHistory(async () => response(200, { entries, before: null }), 'marketing');
  assert.deepEqual(page.entries.slice(1).map(({ kind, state, status }) => ({ kind, state, status })), [
    { kind: 'status', state: 'stopped', status: undefined },
    { kind: 'status', state: 'failed', status: 503 },
  ]);
  const stopped = historyTurn(page.entries[1], 'Marketing', 1, words);
  const failed = historyTurn(page.entries[2], 'Marketing', 2, words);
  assert.deepEqual([stopped.text, failed.text], [escapeMarkdownText(words.turnStopped), escapeMarkdownText(words.runtimeFailed)]);
  for (const invalid of [
    { id: `${TURN}:status`, created_at: AT, kind: 'status', state: 'paused' },
    { id: `${TURN}:status`, created_at: AT, kind: 'status', state: 'failed', status: 200, detail: 'x' },
    { id: `${TURN}:reply`, created_at: AT, kind: 'status', state: 'stopped' },
  ]) {
    await assert.rejects(
      listChatHistory(async () => response(200, { entries: [invalid], before: null }), 'marketing'),
      JSON.stringify(invalid),
    );
  }
});

test('the Space chat limit is Team answer, read and saved in its exact shape', async () => {
  const reader = recorder(200, { limit: 2 });
  assert.equal(await loadChatLimit(reader.call), 2);
  assert.deepEqual(reader.calls, [{ method: 'chat_limit.read', params: {} }]);
  for (const body of [{ limit: 3 }, { limit: 0 }, { limit: '2' }, { limit: 2, extra: 1 }, []]) {
    await assert.rejects(loadChatLimit(recorder(200, body).call), /invalid/, JSON.stringify(body));
  }
  await assert.rejects(loadChatLimit(recorder(503, { detail: 'down' }).call), (error) => error.status === 503);

  const calls = [];
  socketReads.watch = (topic, listener) => {
    queueMicrotask(() => listener(topic, 'open', { epoch: 'e'.repeat(32), revision: 0 }));
    return () => {};
  };
  socketReads.call = async (method, params) => {
    calls.push({ method, params });
    return response(200, { limit: method === 'chat_limit.save' ? params.body.limit : 1 });
  };
  await saveChatLimit(1);
  assert.deepEqual(calls[0], { method: 'chat_limit.save', params: { body: { limit: 1 } } });
  await assert.rejects(saveChatLimit(3), /invalid/);
  socketReads.call = async () => response(200, { limit: 2 });
  await assert.rejects(saveChatLimit(1), /invalid/);
  forgetChatLimit();
});
