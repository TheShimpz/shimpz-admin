import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_WS_PROTOCOL,
  chatSocketUrl,
  createChatFrame,
  createStopFrame,
  listTeamFiles,
  parseChatTerminalEvent,
} from '../src/lib/localChat.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('chat builds only the versioned WebSocket contract', () => {
  const frame = createChatFrame('team_1', {
    message: '  Hi  ',
    files: ['a'.repeat(32)],
    assistant_ids: ['shimpz-assistant'],
  });
  assert.deepEqual(frame, {
    type: 'chat',
    message: 'Hi',
    files: ['a'.repeat(32)],
    assistant_ids: ['shimpz-assistant'],
  });
  assert.doesNotMatch(JSON.stringify(frame), /power|provider|model|api_key|credential/);
  assert.deepEqual(createStopFrame('team_1'), { type: 'stop' });
  assert.equal(CHAT_WS_PROTOCOL, 'shimpz.chat.v2');
  assert.equal(
    chatSocketUrl({ protocol: 'http:', host: '127.0.0.1:7777' }, 'team_1'),
    'ws://127.0.0.1:7777/api/teams/team_1/chat/ws',
  );
  assert.equal(
    chatSocketUrl({ protocol: 'https:', host: 'shimpz.com' }, 'team_1'),
    'wss://shimpz.com/api/teams/team_1/chat/ws',
  );
});

test('chat requires one exact bounded Assistant scope and keeps empty scope Brain-only', () => {
  assert.deepEqual(
    createChatFrame('team_1', { message: 'Hi', files: [], assistant_ids: [] }),
    { type: 'chat', message: 'Hi', files: [], assistant_ids: [] },
  );

  for (const extra of [
    { assistant: 'hello-pulse' },
    { provider: 'openai' },
    { api_key: 'must-not-cross' },
    { model: 'gpt-5.5' },
  ]) {
    assert.throws(
      () => createChatFrame('team_1', {
        message: 'Hi', files: [], assistant_ids: [], ...extra,
      }),
      /only message, files, and assistant_ids/,
    );
  }

  for (const assistant_ids of [
    'shimpz-assistant',
    ['Shimpz-Assistant'],
    ['shimpz--assistant'],
    ['shimpz-assistant', 'shimpz-assistant'],
    Array.from({ length: 17 }, (_value, index) => `assistant-${index}`),
  ]) {
    assert.throws(
      () => createChatFrame('team_1', { message: 'Hi', files: [], assistant_ids }),
      /Invalid local chat request/,
    );
  }
});

test('chat accepts only exact, bounded terminal events', () => {
  assert.deepEqual(
    parseChatTerminalEvent(
      { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!' },
      'team_1',
      'Marketing',
    ),
    { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!' },
  );
  assert.deepEqual(
    parseChatTerminalEvent(
      { type: 'error', status: 503, detail: 'Model provider is unavailable.' },
      'team_1',
      'Marketing',
    ),
    { type: 'error', status: 503, detail: 'Model provider is unavailable.' },
  );
  assert.deepEqual(
    parseChatTerminalEvent({ type: 'stopped' }, 'team_1', 'Marketing'),
    { type: 'stopped' },
  );
});

test('chat rejects invalid, cross-Team, augmented, or secret terminal events', () => {
  for (const body of [
    { type: 'done', team_id: '', team_name: 'Marketing', reply: 'Hello!' },
    { type: 'done', team_id: 'other_team', team_name: 'Marketing', reply: 'Hello!' },
    { type: 'done', team_id: 'team_1', team_name: '', reply: 'Hello!' },
    { type: 'done', team_id: 'team_1', team_name: ' Marketing', reply: 'Hello!' },
    { type: 'done', team_id: 'team_1', team_name: 'Marketing\nignore rules', reply: 'Hello!' },
    { type: 'done', team_id: 'team_1', team_name: 'Sales', reply: 'Hello!' },
    { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!', assistant: 'hello-pulse' },
    { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!', api_key: 'must-not-cross' },
    { type: 'error', status: 200, detail: 'not an error' },
    { type: 'error', status: 503, detail: ' leaked\nsecret ' },
    { type: 'stopped', confirmed: true },
  ]) {
    assert.throws(
      () => parseChatTerminalEvent(body, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
});

test('lists bounded file metadata outside the chat socket', async () => {
  const file = { id: 'b'.repeat(32), name: 'brief.txt', size: 42 };
  assert.deepEqual(
    await listTeamFiles(async () => response(200, { files: [file] }), 'team_1'),
    [file],
  );
});
