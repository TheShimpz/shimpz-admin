import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_WS_PROTOCOL,
  chatSocketUrl,
  createChatFrame,
  createSecretSubmitFrame,
  createStopFrame,
  createSyncFrame,
  listTeamFiles,
  parseChatEvent,
} from '../src/lib/localChat.js';

const TURN_ID = 'a'.repeat(32);
const CHALLENGE_ID = 'b'.repeat(32);

function secretRequirement() {
  return {
    assistant_id: 'weather-guide',
    assistant_name: 'Weather Guide',
    power_ids: ['current-weather', 'daily-forecast'],
    secrets: [
      {
        id: 'weather-api-token',
        name: 'Weather API token',
        summary: 'Authenticates requests to the configured weather provider.',
      },
    ],
  };
}

function secretInventory() {
  return {
    type: 'secret-inventory',
    team_id: 'team_1',
    assistants: [
      {
        id: 'weather-guide',
        name: 'Weather Guide',
        secrets: [
          {
            id: 'weather-api-token',
            name: 'Weather API token',
            summary: 'Authenticates requests to the configured weather provider.',
            configured: true,
            mask: 'sk…89',
          },
          {
            id: 'maps-token',
            name: 'Maps token',
            summary: 'Finds a location before the weather lookup.',
            configured: false,
            mask: null,
          },
        ],
      },
    ],
  };
}

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
  assert.deepEqual(createSyncFrame('team_1'), { type: 'sync' });
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

test('chat builds one exact bounded secret submission without retaining caller objects', () => {
  const values = [
    { assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'sk-secret-value' },
  ];
  const frame = createSecretSubmitFrame('team_1', CHALLENGE_ID, values);
  assert.deepEqual(frame, {
    type: 'secret-submit',
    challenge_id: CHALLENGE_ID,
    values,
  });
  assert.notEqual(frame.values, values);
  assert.notEqual(frame.values[0], values[0]);

  for (const invalid of [
    [],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: '' }],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: ' padded' }],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'line\nbreak' }],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: `safe\u202e${'x'.repeat(8)}` }],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'x'.repeat(16_385) }],
    [
      { assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'first-value' },
      { assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'second-value' },
    ],
    [{ assistant_id: 'weather-guide', secret_id: 'weather-api-token', value: 'secret', extra: true }],
  ]) {
    assert.throws(
      () => createSecretSubmitFrame('team_1', CHALLENGE_ID, invalid),
      /secret submission/,
    );
  }
  assert.throws(
    () => createSecretSubmitFrame('team_1', 'not-a-challenge', values),
    /secret submission/,
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
    parseChatEvent(
      { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!' },
      'team_1',
      'Marketing',
    ),
    { type: 'done', team_id: 'team_1', team_name: 'Marketing', reply: 'Hello!' },
  );
  assert.deepEqual(
    parseChatEvent(
      { type: 'error', status: 503, detail: 'Model provider is unavailable.' },
      'team_1',
      'Marketing',
    ),
    { type: 'error', status: 503, detail: 'Model provider is unavailable.' },
  );
  assert.deepEqual(
    parseChatEvent({ type: 'stopped' }, 'team_1', 'Marketing'),
    { type: 'stopped' },
  );
});

test('chat accepts exact secret challenges and Team-bound inventory snapshots', () => {
  const challenge = {
    type: 'secrets-required',
    turn_id: TURN_ID,
    challenge_id: CHALLENGE_ID,
    requirements: [secretRequirement()],
  };
  assert.deepEqual(parseChatEvent(challenge, 'team_1', 'Marketing'), challenge);
  assert.notEqual(
    parseChatEvent(challenge, 'team_1', 'Marketing').requirements,
    challenge.requirements,
  );

  const inventory = secretInventory();
  assert.deepEqual(parseChatEvent(inventory, 'team_1', 'Marketing'), inventory);
  assert.notEqual(
    parseChatEvent(inventory, 'team_1', 'Marketing').assistants,
    inventory.assistants,
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
      () => parseChatEvent(body, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
});

test('chat rejects augmented, duplicate, malformed, or cross-Team secret events', () => {
  const requirement = secretRequirement();
  const inventory = secretInventory();
  for (const body of [
    { type: 'secrets-required', turn_id: TURN_ID, challenge_id: CHALLENGE_ID, requirements: [] },
    { type: 'secrets-required', turn_id: 'turn', challenge_id: CHALLENGE_ID, requirements: [requirement] },
    { type: 'secrets-required', turn_id: TURN_ID, challenge_id: 'challenge', requirements: [requirement] },
    {
      type: 'secrets-required', turn_id: TURN_ID, challenge_id: CHALLENGE_ID,
      requirements: [requirement, requirement],
    },
    {
      type: 'secrets-required', turn_id: TURN_ID, challenge_id: CHALLENGE_ID,
      requirements: [{ ...requirement, power_ids: ['current-weather', 'current-weather'] }],
    },
    {
      type: 'secrets-required', turn_id: TURN_ID, challenge_id: CHALLENGE_ID,
      requirements: [{ ...requirement, secrets: [...requirement.secrets, ...requirement.secrets] }],
    },
    { ...inventory, team_id: 'other_team' },
    { ...inventory, extra: true },
    { ...inventory, assistants: [...inventory.assistants, ...inventory.assistants] },
    {
      ...inventory,
      assistants: [{
        ...inventory.assistants[0],
        secrets: [{ ...inventory.assistants[0].secrets[0], configured: false, mask: 'sk…89' }],
      }],
    },
    {
      ...inventory,
      assistants: [{
        ...inventory.assistants[0],
        secrets: [{ ...inventory.assistants[0].secrets[0], mask: 'secret-value' }],
      }],
    },
  ]) {
    assert.throws(
      () => parseChatEvent(body, 'team_1', 'Marketing'),
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
