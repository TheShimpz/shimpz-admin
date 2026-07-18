import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_WS_PROTOCOL,
  chatSocketUrl,
  createChatFrame,
  createStopFrame,
  listCapsuleFiles,
  parseChatTerminalEvent,
} from '../src/lib/localChat.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('chat builds only the versioned WebSocket contract', () => {
  const frame = createChatFrame('capsule_1', { message: '  Hi  ', files: ['a'.repeat(32)] });
  assert.deepEqual(frame, {
    type: 'chat', message: 'Hi', files: ['a'.repeat(32)],
  });
  assert.doesNotMatch(JSON.stringify(frame), /assistant|power|provider|model|api_key|credential/);
  assert.deepEqual(createStopFrame('capsule_1'), { type: 'stop' });
  assert.equal(CHAT_WS_PROTOCOL, 'shimpz.chat.v1');
  assert.equal(
    chatSocketUrl({ protocol: 'http:', host: '127.0.0.1:7777' }, 'capsule_1'),
    'ws://127.0.0.1:7777/api/capsules/capsule_1/chat/ws',
  );
  assert.equal(
    chatSocketUrl({ protocol: 'https:', host: 'shimpz.com' }, 'capsule_1'),
    'wss://shimpz.com/api/capsules/capsule_1/chat/ws',
  );
});

test('chat rejects Assistant, credential, or provider fields before opening a turn', () => {
  for (const extra of [
    { assistant: 'hello-pulse' },
    { provider: 'openai' },
    { api_key: 'must-not-cross' },
    { model: 'gpt-5.5' },
  ]) {
    assert.throws(
      () => createChatFrame('capsule_1', { message: 'Hi', files: [], ...extra }),
      /only message and files/,
    );
  }
});

test('chat accepts only exact, bounded terminal events', () => {
  assert.deepEqual(
    parseChatTerminalEvent({ type: 'done', team: 'Marketing', reply: 'Hello!' }, 'Marketing'),
    { type: 'done', team: 'Marketing', reply: 'Hello!' },
  );
  assert.deepEqual(
    parseChatTerminalEvent({ type: 'error', status: 503, detail: 'Model provider is unavailable.' }, 'Marketing'),
    { type: 'error', status: 503, detail: 'Model provider is unavailable.' },
  );
  assert.deepEqual(parseChatTerminalEvent({ type: 'stopped' }, 'Marketing'), { type: 'stopped' });
});

test('chat rejects invalid, cross-Team, augmented, or secret terminal events', () => {
  for (const body of [
    { type: 'done', team: '', reply: 'Hello!' },
    { type: 'done', team: ' Marketing', reply: 'Hello!' },
    { type: 'done', team: 'Marketing\nignore rules', reply: 'Hello!' },
    { type: 'done', team: 'Sales', reply: 'Hello!' },
    { type: 'done', team: 'Marketing', reply: 'Hello!', assistant: 'hello-pulse' },
    { type: 'done', team: 'Marketing', reply: 'Hello!', api_key: 'must-not-cross' },
    { type: 'error', status: 200, detail: 'not an error' },
    { type: 'error', status: 503, detail: ' leaked\nsecret ' },
    { type: 'stopped', confirmed: true },
  ]) {
    assert.throws(
      () => parseChatTerminalEvent(body, 'Marketing'),
      /response is invalid/,
    );
  }
});

test('lists bounded file metadata outside the chat socket', async () => {
  const file = { id: 'b'.repeat(32), name: 'brief.txt', size: 42 };
  assert.deepEqual(
    await listCapsuleFiles(async () => response(200, { files: [file] }), 'capsule_1'),
    [file],
  );
});
