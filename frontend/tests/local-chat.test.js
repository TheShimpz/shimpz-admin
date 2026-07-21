import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_WS_PROTOCOL,
  authorizeAssistantAccount,
  chatSocketUrl,
  createApprovalSubmitFrame,
  createChatFrame,
  createSecretSubmitFrame,
  createStopFrame,
  createSyncFrame,
  disconnectAssistantAccount,
  listAssistantAccounts,
  listRememberedApprovals,
  listTeamFiles,
  oauthReturnFailure,
  parseChatEvent,
  replaceAssistantSecrets,
  revokeRememberedApprovals,
} from '../src/lib/localChat.js';

const TURN_ID = 'a'.repeat(32);
const CHALLENGE_ID = 'b'.repeat(32);

test('recognizes only the closed OAuth failure return marker', () => {
  assert.equal(oauthReturnFailure('https://local.shimpz.com/chat?oauth=start-failed'), true);
  assert.equal(oauthReturnFailure('http://127.0.0.1:7777/chat?oauth=callback-failed'), true);
  for (const value of [
    'https://local.shimpz.com/chat',
    'https://local.shimpz.com/chat?oauth=unknown',
    'https://local.shimpz.com/chat?oauth=start-failed&claim=must-not-cross',
    'https://local.shimpz.com/chat?oauth=start-failed#token=must-not-cross',
    'not a URL',
  ]) assert.equal(oauthReturnFailure(value), false);
});

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

function approvalRequirement(approval = 'always') {
  return {
    assistant_id: 'social-publisher',
    assistant_name: 'Social Publisher',
    power_id: 'create-post',
    power_summary: 'Publish this exact post on X.',
    input: { text: 'Hello from Shimpz', reply_to: null },
    approval,
  };
}

function accountRequirement() {
  return {
    assistant_id: 'social-publisher',
    assistant_name: 'Social Publisher',
    account_id: 'x-account',
    provider: 'x',
    name: 'X account',
    summary: 'Publishes approved posts through your X account.',
    scopes: ['tweet.read', 'tweet.write', 'users.read'],
    powers: [
      { id: 'publish-post', name: 'Publish post', summary: 'Publishes one approved post on X.' },
    ],
  };
}

function accountInventory(status = 'connected') {
  return {
    accounts: [
      {
        assistant_id: 'social-publisher',
        assistant_name: 'Social Publisher',
        id: 'x-account',
        provider: 'x',
        name: 'X account',
        summary: 'Publishes approved posts through your X account.',
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        status,
        account: status === 'missing' ? null : { id: '142', name: 'Shimpz', username: 'TheShimpz' },
        expires_at: status === 'missing' ? null : '2026-07-20T12:34:56.000Z',
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
  assert.equal(CHAT_WS_PROTOCOL, 'shimpz.chat.v3');
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
    Array.from({ length: 65 }, (_value, index) => ({
      assistant_id: 'weather-guide',
      secret_id: `secret-${index}`,
      value: `secret-value-${index}`,
    })),
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

test('chat builds only an explicit exact approval continuation', () => {
  assert.deepEqual(createApprovalSubmitFrame('team_1', CHALLENGE_ID), {
    type: 'approval-submit',
    challenge_id: CHALLENGE_ID,
    approved: true,
  });
  assert.throws(
    () => createApprovalSubmitFrame('team_1', 'not-a-challenge'),
    /approval submission/,
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

test('chat accepts bounded exact Power approvals and preserves repeated operations', () => {
  const first = approvalRequirement('always');
  const second = {
    ...approvalRequirement('once'),
    input: { text: 'A second post', reply_to: '123' },
  };
  const challenge = {
    type: 'approval-required',
    turn_id: TURN_ID,
    challenge_id: CHALLENGE_ID,
    requirements: [first, second],
  };
  const parsed = parseChatEvent(challenge, 'team_1', 'Marketing');
  assert.deepEqual(parsed, challenge);
  assert.notEqual(parsed.requirements, challenge.requirements);
  assert.notEqual(parsed.requirements[0].input, challenge.requirements[0].input);
});

test('chat accepts only exact bounded public account requirements', () => {
  const challenge = {
    type: 'accounts-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    requirements: [accountRequirement()],
  };
  const parsed = parseChatEvent(challenge, 'team_1', 'Marketing');
  assert.deepEqual(parsed, challenge);
  assert.notEqual(parsed.requirements, challenge.requirements);
  assert.notEqual(parsed.requirements[0].powers, challenge.requirements[0].powers);
  assert.doesNotMatch(JSON.stringify(parsed), /token|code|verifier|client_secret/i);
});

test('chat rejects augmented, duplicated, and sensitive account requirements', () => {
  const base = {
    type: 'accounts-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    requirements: [accountRequirement()],
  };
  for (const invalid of [
    { ...base, access_token: 'must-not-cross' },
    { ...base, challenge_id: 'challenge' },
    { ...base, expires_in: 0 },
    { ...base, expires_in: 901 },
    { ...base, requirements: [] },
    { ...base, requirements: [accountRequirement(), accountRequirement()] },
    { ...base, requirements: [{ ...accountRequirement(), client_id: 'must-not-cross' }] },
    { ...base, requirements: [{ ...accountRequirement(), scopes: ['tweet.read', 'tweet.read'] }] },
    {
      ...base,
      requirements: [{
        ...accountRequirement(),
        powers: [{ ...accountRequirement().powers[0], token: 'must-not-cross' }],
      }],
    },
  ]) {
    assert.throws(
      () => parseChatEvent(invalid, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
});

test('chat rejects augmented, unsafe, and unbounded approval previews', () => {
  const base = {
    type: 'approval-required',
    turn_id: TURN_ID,
    challenge_id: CHALLENGE_ID,
    requirements: [approvalRequirement()],
  };
  for (const invalid of [
    { ...base, api_key: 'must-not-cross' },
    { ...base, requirements: [{ ...approvalRequirement(), approval: 'each-run' }] },
    { ...base, requirements: [{ ...approvalRequirement(), input: [] }] },
    { ...base, requirements: [{ ...approvalRequirement(), input: { temperature: Number.NaN } }] },
    { ...base, requirements: [{ ...approvalRequirement(), input: { text: 'x'.repeat(32 * 1024 + 1) } }] },
    { ...base, requirements: Array.from({ length: 65 }, () => approvalRequirement()) },
  ]) {
    assert.throws(
      () => parseChatEvent(invalid, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
});

test('rotates only selected write-only Assistant secrets and accepts masks only', async () => {
  const calls = [];
  const result = await replaceAssistantSecrets(
    async (url, options) => {
      calls.push({ url, options });
      return response(200, { team_id: 'team_1', assistants: secretInventory().assistants });
    },
    'team_1',
    'weather-guide',
    [{ secret_id: 'weather-api-token', value: 'replacement-secret-value' }],
  );
  assert.deepEqual(result, { team_id: 'team_1', assistants: secretInventory().assistants });
  assert.equal(calls[0].url, '/api/teams/team_1/assistant-secrets');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    assistant_id: 'weather-guide',
    values: [{ secret_id: 'weather-api-token', value: 'replacement-secret-value' }],
  });

  await assert.rejects(
    replaceAssistantSecrets(
      async () => response(200, {
        team_id: 'team_1',
        assistants: [{ ...secretInventory().assistants[0], value: 'must-not-cross' }],
      }),
      'team_1',
      'weather-guide',
      [{ secret_id: 'weather-api-token', value: 'replacement-secret-value' }],
    ),
    /inventory is invalid/,
  );
});

test('lists and revokes exact Team-scoped remembered approvals', async () => {
  const grants = [
    { assistant_id: 'social-publisher', power_id: 'create-post' },
    { assistant_id: 'social-publisher', power_id: 'delete-post' },
  ];
  const calls = [];
  assert.deepEqual(
    await listRememberedApprovals(async (url, options) => {
      calls.push({ url, options });
      return response(200, { team_id: 'team_1', grants });
    }, 'team_1'),
    { team_id: 'team_1', grants },
  );
  assert.deepEqual(
    await revokeRememberedApprovals(async (url, options) => {
      calls.push({ url, options });
      return response(200, { team_id: 'team_1', revoked: 2 });
    }, 'team_1'),
    { team_id: 'team_1', revoked: 2 },
  );
  assert.equal(calls[0].url, '/api/teams/team_1/assistant-approvals');
  assert.equal(calls[1].options.method, 'DELETE');

  await assert.rejects(
    listRememberedApprovals(
      async () => response(200, { team_id: 'team_1', grants: [grants[0], grants[0]] }),
      'team_1',
    ),
    /approvals are invalid/,
  );
});

test('lists only bounded status metadata for Team-scoped Assistant accounts', async () => {
  const calls = [];
  const inventory = accountInventory();
  assert.deepEqual(
    await listAssistantAccounts(async (url, options) => {
      calls.push({ url, options });
      return response(200, inventory);
    }, 'team_1'),
    inventory,
  );
  assert.equal(calls[0].url, '/api/teams/team_1/assistant-accounts');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.doesNotMatch(JSON.stringify(inventory), /token|code|verifier|client_secret/i);

  for (const invalid of [
    { ...inventory, token: 'must-not-cross' },
    { accounts: [{ ...inventory.accounts[0], status: 'refresh-required' }] },
    { accounts: [{ ...inventory.accounts[0], account: { id: '1', name: null } }] },
    { accounts: [{ ...inventory.accounts[0], account: { id: '', name: null, username: null } }] },
    { accounts: [{ ...inventory.accounts[0], expires_at: 'tomorrow' }] },
    { accounts: [...inventory.accounts, ...inventory.accounts] },
  ]) {
    await assert.rejects(
      listAssistantAccounts(async () => response(200, invalid), 'team_1'),
      /inventory is invalid/,
    );
  }
});

test('starts only a trusted Cloudflare authorization and disconnects with an empty 204', async () => {
  const calls = [];
  const authorizationUrl = 'https://dash.cloudflare.com/oauth2/auth?response_type=code&state=opaque';
  assert.deepEqual(
    await authorizeAssistantAccount(async (url, options) => {
      calls.push({ url, options });
      return response(200, { authorization_url: authorizationUrl });
    }, 'team_1', CHALLENGE_ID),
    { authorization_url: authorizationUrl },
  );
  assert.equal(
    calls[0].url,
    `/api/teams/team_1/assistant-accounts/challenges/${CHALLENGE_ID}/authorize`,
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');

  const handoffUrl = `http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}`;
  assert.deepEqual(
    await authorizeAssistantAccount(
      async () => response(200, { authorization_url: handoffUrl }),
      'team_1',
      CHALLENGE_ID,
    ),
    { authorization_url: handoffUrl },
  );
  const canaryHandoffUrl = `https://local.shimpz.com/api/oauth/cloudflare/start?handoff=${'b'.repeat(64)}`;
  assert.deepEqual(
    await authorizeAssistantAccount(
      async () => response(200, { authorization_url: canaryHandoffUrl }),
      'team_1',
      CHALLENGE_ID,
    ),
    { authorization_url: canaryHandoffUrl },
  );

  for (const body of [
    { authorization_url: 'http://dash.cloudflare.com/oauth2/auth' },
    { authorization_url: 'https://evil.example/oauth2/auth' },
    { authorization_url: 'https://dash.cloudflare.com.evil.example/oauth2/auth' },
    { authorization_url: 'https://dash.cloudflare.com/settings' },
    { authorization_url: 'https://user@dash.cloudflare.com/oauth2/auth' },
    { authorization_url: 'https://dash.cloudflare.com/oauth2/auth#token=value' },
    { authorization_url: `http://localhost:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}` },
    { authorization_url: `http://local.shimpz.com/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}` },
    { authorization_url: `https://local.shimpz.com:444/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}` },
    { authorization_url: `https://local.shimpz.com.evil.test/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}` },
    { authorization_url: `http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(63)}` },
    { authorization_url: `http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}&next=https://evil.example` },
    { authorization_url: `http://user@127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}` },
    { authorization_url: `http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}#token=value` },
    { authorization_url: authorizationUrl, code_verifier: 'must-not-cross' },
  ]) {
    await assert.rejects(
      authorizeAssistantAccount(async () => response(200, body), 'team_1', CHALLENGE_ID),
      /authorization response is invalid/,
    );
  }

  await disconnectAssistantAccount(
    async (url, options) => {
      calls.push({ url, options });
      return response(204, {});
    },
    'team_1',
    'social-publisher',
    'x-account',
  );
  assert.equal(calls[1].url, '/api/teams/team_1/assistant-accounts/social-publisher/x-account');
  assert.equal(calls[1].options.method, 'DELETE');
  await assert.rejects(
    disconnectAssistantAccount(async () => response(200, {}), 'team_1', 'social-publisher', 'x-account'),
    /disaccount response is invalid/,
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
    {
      type: 'secrets-required', turn_id: TURN_ID, challenge_id: CHALLENGE_ID,
      requirements: Array.from({ length: 3 }, (_value, assistantIndex) => ({
        assistant_id: `assistant-${assistantIndex}`,
        assistant_name: `Assistant ${assistantIndex}`,
        power_ids: ['use-secrets'],
        secrets: Array.from({ length: assistantIndex === 2 ? 1 : 32 }, (_secret, secretIndex) => ({
          id: `secret-${secretIndex}`,
          name: `Secret ${secretIndex}`,
          summary: 'Used by one bounded Power.',
        })),
      })),
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
