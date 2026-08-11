import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_WS_PROTOCOL,
  authorizeAssistantIntegration,
  cancelAssistantIntegrationAuthorization,
  chatSocketUrl,
  completeAssistantIntegration,
  createChatFrame,
  createHumanResponseFrame,
  createStopFrame,
  createSyncFrame,
  disconnectAssistantIntegration,
  listAssistantIntegrations,
  listTeamFiles,
  oauthReturnFailure,
  parseChatEvent,
  restoreOAuthChatTurns,
  stashOAuthChatTurns,
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

test('restores one bounded OAuth conversation from session storage exactly once', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const turns = [
    { role: 'user', text: 'List my DNS zones.' },
    { role: 'assistant', text: 'Authorization is required.\nPlease continue.', author: 'Marketing' },
  ];

  assert.equal(stashOAuthChatTurns(storage, 'team_1', turns, 1_000), true);
  assert.deepEqual(restoreOAuthChatTurns(storage, 'team_2', 1_001), []);
  assert.deepEqual(restoreOAuthChatTurns(storage, 'team_1', 1_001), turns);
  assert.deepEqual(restoreOAuthChatTurns(storage, 'team_1', 1_002), []);
});

test('rejects expired, malformed, oversized and storage-failing OAuth conversation state', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(stashOAuthChatTurns(storage, 'team_1', [{ role: 'user', text: 'Hello' }], 1_000), true);
  assert.deepEqual(restoreOAuthChatTurns(storage, 'team_1', 601_001), []);
  assert.equal(
    stashOAuthChatTurns(storage, 'team_1', [{ role: 'user', text: 'x'.repeat(16_001) }], 1_000),
    false,
  );
  assert.equal(
    stashOAuthChatTurns({ setItem: () => { throw new Error('denied'); } }, 'team_1', [], 1_000),
    false,
  );
  values.set('shimpz:oauth-chat:v1', '{"version":1,"token":"must-not-cross"}');
  assert.deepEqual(restoreOAuthChatTurns(storage, 'team_1', 1_001), []);
  assert.equal(values.size, 0);
});

function integrationRequirement() {
  return {
    assistant_id: 'social-publisher',
    assistant_name: 'Social Publisher',
    integration_id: 'x-integration',
    provider: 'x',
    name: 'X integration',
    summary: 'Publishes approved posts through your X integration.',
    scopes: ['tweet.read', 'tweet.write', 'users.read'],
    actions: [
      { id: 'publish-post', name: 'Publish post', summary: 'Publishes one approved post on X.' },
    ],
  };
}

function integrationInventory(status = 'connected') {
  return {
    integrations: [
      {
        assistant_id: 'social-publisher',
        assistant_name: 'Social Publisher',
        id: 'x-integration',
        provider: 'x',
        name: 'X integration',
        summary: 'Publishes approved posts through your X integration.',
        scopes: ['tweet.read', 'tweet.write', 'users.read'],
        status,
        integration: status === 'missing' ? null : { id: '142', name: 'Shimpz', username: 'TheShimpz' },
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
    assistant_ids: ['shimpz-cloudflare'],
  });
  assert.deepEqual(frame, {
    type: 'chat',
    message: 'Hi',
    files: ['a'.repeat(32)],
    assistant_ids: ['shimpz-cloudflare'],
  });
  assert.doesNotMatch(JSON.stringify(frame), /action|provider|model|api_key|credential/);
  assert.deepEqual(createStopFrame('team_1'), { type: 'stop' });
  assert.deepEqual(createSyncFrame('team_1'), { type: 'sync' });
  assert.equal(CHAT_WS_PROTOCOL, 'shimpz.chat.v4');
  assert.equal(
    chatSocketUrl({ protocol: 'http:', host: '127.0.0.1:7777' }, 'team_1'),
    'ws://127.0.0.1:7777/api/teams/team_1/chat/ws',
  );
  assert.equal(
    chatSocketUrl({ protocol: 'https:', host: 'shimpz.com' }, 'team_1'),
    'wss://shimpz.com/api/teams/team_1/chat/ws',
  );
});

function humanRequest(kind) {
  const base = {
    kind,
    ordinal: 0,
    title: 'Confirm this Action',
    description: 'The Action is waiting for your response.',
    fingerprint: 'c'.repeat(64),
  };
  if (['input:text', 'input:textarea', 'input:password', 'input:phone'].includes(kind)) {
    return {
      ...base,
      label: 'Response',
      required: true,
      placeholder: 'Enter a value',
      min_length: 1,
      max_length: kind === 'input:textarea' ? 16_000 : 64,
    };
  }
  if (['input:select', 'input:choice'].includes(kind)) {
    return {
      ...base,
      label: 'Mode',
      required: true,
      options: [
        { value: 'safe', label: 'Safe', description: 'Review every change.' },
        { value: 'fast', label: 'Fast', description: null },
      ],
    };
  }
  if (kind === 'input:choices') {
    return {
      ...base,
      label: 'Zones',
      required: true,
      options: [
        { value: 'one', label: 'One', description: null },
        { value: 'two', label: 'Two', description: null },
      ],
      min_selections: 1,
      max_selections: 2,
    };
  }
  return base;
}

function humanChallenge(kind) {
  return {
    type: 'human-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'list-zones', summary: 'List reviewed Cloudflare zones.' },
    request: humanRequest(kind),
  };
}

test('chat builds only exact bounded human response frames', () => {
  assert.deepEqual(
    createHumanResponseFrame('team_1', CHALLENGE_ID, 'submit', true),
    { type: 'human-response', challenge_id: CHALLENGE_ID, decision: 'submit', value: true },
  );
  assert.deepEqual(
    createHumanResponseFrame('team_1', CHALLENGE_ID, 'submit', ['one', 'two']),
    { type: 'human-response', challenge_id: CHALLENGE_ID, decision: 'submit', value: ['one', 'two'] },
  );
  assert.deepEqual(
    createHumanResponseFrame('team_1', CHALLENGE_ID, 'deny'),
    { type: 'human-response', challenge_id: CHALLENGE_ID, decision: 'deny' },
  );
  for (const args of [
    ['team_1', 'challenge', 'submit', true],
    ['team_1', CHALLENGE_ID, 'deny', true],
    ['team_1', CHALLENGE_ID, 'submit', false],
    ['team_1', CHALLENGE_ID, 'submit', ['one', 'one']],
    ['team_1', CHALLENGE_ID, 'submit', 'x'.repeat(16_001)],
  ]) assert.throws(() => createHumanResponseFrame(...args), /Invalid human response/);
});

test('chat accepts every exact bounded public human request presentation', () => {
  for (const kind of [
    'approval',
    'input:text',
    'input:textarea',
    'input:password',
    'input:phone',
    'input:select',
    'input:choice',
    'input:choices',
    'auth:reauth',
    'auth:second-factor',
    'auth:phishing-resistant',
  ]) {
    const challenge = humanChallenge(kind);
    const parsed = parseChatEvent(challenge, 'team_1', 'Marketing');
    assert.deepEqual(parsed, challenge);
    assert.notEqual(parsed.request, challenge.request);
  }
});

test('chat accepts only exact challenge-bound human authentication rejections', () => {
  const denied = {
    type: 'human-response-rejected',
    challenge_id: CHALLENGE_ID,
    reason: 'authentication-denied',
    attempts_remaining: 2,
    retry_after: 0,
  };
  const locked = {
    ...denied,
    reason: 'authentication-locked',
    attempts_remaining: 0,
    retry_after: 60,
  };
  assert.deepEqual(parseChatEvent(denied, 'team_1', 'Marketing'), denied);
  assert.deepEqual(parseChatEvent(locked, 'team_1', 'Marketing'), locked);

  for (const invalid of [
    { ...denied, challenge_id: 'challenge' },
    { ...denied, attempts_remaining: 0 },
    { ...denied, retry_after: 1 },
    { ...denied, password: 'must-not-cross' },
    { ...locked, attempts_remaining: 1 },
    { ...locked, retry_after: 0 },
    { ...locked, retry_after: 61 },
    { ...locked, reason: 'authentication-unavailable' },
  ]) assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'), /response is invalid/);
});

test('chat rejects augmented, sensitive, and out-of-bounds human requests', () => {
  const base = humanChallenge('input:choices');
  for (const invalid of [
    { ...base, access_token: 'must-not-cross' },
    { ...base, challenge_id: 'challenge' },
    { ...base, expires_in: 301 },
    { ...base, assistant: { ...base.assistant, token: 'must-not-cross' } },
    { ...base, action: { ...base.action, input: 'must-not-cross' } },
    { ...base, request: { ...base.request, ordinal: 8 } },
    { ...base, request: { ...base.request, fingerprint: 'not-a-fingerprint' } },
    { ...base, request: { ...base.request, min_selections: 3 } },
    { ...base, request: { ...base.request, options: [...base.request.options, base.request.options[0]] } },
    { ...humanChallenge('approval'), request: { ...humanRequest('approval'), secret: 'must-not-cross' } },
  ]) assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'), /response is invalid/);
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
    'shimpz-cloudflare',
    ['Shimpz-Assistant'],
    ['shimpz--assistant'],
    ['shimpz-cloudflare', 'shimpz-cloudflare'],
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
  assert.deepEqual(
    parseChatEvent({ type: 'sync-empty' }, 'team_1', 'Marketing'),
    { type: 'sync-empty' },
  );
const progressEvents = [
  { type: 'progress', seq: 1, origin: 'admin', phase: 'admin-preparation', state: 'started' },
  {
    type: 'progress', seq: 2, origin: 'admin', phase: 'admin-preparation',
    state: 'finished', elapsed_ms: 4,
  },
  { type: 'progress', seq: 3, origin: 'team', phase: 'model', state: 'started' },
  { type: 'progress', seq: 2052, origin: 'admin', phase: 'reply-validation', state: 'started' },
  {
    type: 'progress', seq: 4, origin: 'team', phase: 'action', state: 'finished',
    elapsed_ms: 19, assistant_id: 'shimpz-cloudflare', index: 1, action: 'list-zones', total: 2,
  },
];
for (const event of progressEvents) {
  assert.deepEqual(parseChatEvent(event, 'team_1', 'Marketing'), event);
}
for (const invalid of [
  { type: 'progress', seq: 1, origin: 'team', phase: 'admin-preparation', state: 'started' },
  { type: 'progress', seq: 1, origin: 'admin', phase: 'model', state: 'started' },
  { type: 'progress', seq: 1, origin: 'team', phase: 'reply-validation', state: 'started' },
  { type: 'progress', seq: 2053, origin: 'admin', phase: 'reply-validation', state: 'started' },
  { type: 'progress', seq: 0, origin: 'team', phase: 'model', state: 'started' },
  { type: 'progress', seq: 1, origin: 'team', phase: 'model', state: 'finished' },
  {
    type: 'progress', seq: 1, origin: 'team', phase: 'model', state: 'started',
    detail: 'must-not-cross',
  },
  {
    type: 'progress', seq: 1, origin: 'team', phase: 'action', state: 'started',
    index: 2, total: 1,
  },
  {
    type: 'progress', seq: 1, origin: 'team', phase: 'action', state: 'started',
    assistant_id: 'Shimpz-cloudflare', index: 1, action: 'list-zones', total: 1,
  },
  {
    type: 'progress', seq: 1, origin: 'team', phase: 'action', state: 'started',
    assistant_id: 'shimpz-cloudflare', index: 1, action: 'x'.repeat(81), total: 1,
  },
]) {
    assert.throws(
      () => parseChatEvent(invalid, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
  assert.throws(
    () => parseChatEvent({ type: 'sync-empty', pending: false }, 'team_1', 'Marketing'),
    /response is invalid/,
  );
});



test('chat accepts only exact bounded public integration requirements', () => {
  const challenge = {
    type: 'integrations-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    requirements: [integrationRequirement()],
  };
  const parsed = parseChatEvent(challenge, 'team_1', 'Marketing');
  assert.deepEqual(parsed, challenge);
  assert.notEqual(parsed.requirements, challenge.requirements);
  assert.notEqual(parsed.requirements[0].actions, challenge.requirements[0].actions);
  assert.doesNotMatch(JSON.stringify(parsed), /token|code|verifier|client_secret/i);
});

test('chat rejects augmented, duplicated, and sensitive integration requirements', () => {
  const base = {
    type: 'integrations-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    requirements: [integrationRequirement()],
  };
  for (const invalid of [
    { ...base, access_token: 'must-not-cross' },
    { ...base, challenge_id: 'challenge' },
    { ...base, expires_in: 0 },
    { ...base, expires_in: 901 },
    { ...base, requirements: [] },
    { ...base, requirements: [integrationRequirement(), integrationRequirement()] },
    { ...base, requirements: [{ ...integrationRequirement(), client_id: 'must-not-cross' }] },
    { ...base, requirements: [{ ...integrationRequirement(), scopes: ['tweet.read', 'tweet.read'] }] },
    {
      ...base,
      requirements: [{
        ...integrationRequirement(),
        actions: [{ ...integrationRequirement().actions[0], token: 'must-not-cross' }],
      }],
    },
  ]) {
    assert.throws(
      () => parseChatEvent(invalid, 'team_1', 'Marketing'),
      /response is invalid/,
    );
  }
});




test('lists only bounded status metadata for Team-scoped Assistant integrations', async () => {
  const calls = [];
  const inventory = integrationInventory();
  assert.deepEqual(
    await listAssistantIntegrations(async (url, options) => {
      calls.push({ url, options });
      return response(200, inventory);
    }, 'team_1'),
    inventory,
  );
  assert.equal(calls[0].url, '/api/teams/team_1/assistant-integrations');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.doesNotMatch(JSON.stringify(inventory), /token|code|verifier|client_secret/i);

  for (const invalid of [
    { ...inventory, token: 'must-not-cross' },
    { integrations: [{ ...inventory.integrations[0], status: 'refresh-required' }] },
    { integrations: [{ ...inventory.integrations[0], integration: { id: '1', name: null } }] },
    { integrations: [{ ...inventory.integrations[0], integration: { id: '', name: null, username: null } }] },
    { integrations: [{ ...inventory.integrations[0], expires_at: 'tomorrow' }] },
    { integrations: [...inventory.integrations, ...inventory.integrations] },
  ]) {
    await assert.rejects(
      listAssistantIntegrations(async () => response(200, invalid), 'team_1'),
      /inventory is invalid/,
    );
  }
});

test('starts only a trusted Cloudflare authorization and disconnects with an empty 204', async () => {
  const calls = [];
  const authorizationUrl = 'https://shimpz.com/api/oauth/cloudflare/start?'
    + `state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`
    + '&scope=dns.read+dns.write+offline_access+zone.read&callback=out-of-band';
  const previousLocation = globalThis.location;
  globalThis.location = {
    origin: 'https://developer.example', protocol: 'https:', hostname: 'developer.example', port: '',
  };
  try {
    assert.deepEqual(
      await authorizeAssistantIntegration(async (url, options) => {
        calls.push({ url, options });
        return response(200, { authorization_url: authorizationUrl, completion_mode: 'code' });
      }, 'team_1', CHALLENGE_ID),
      { authorization_url: authorizationUrl, completion_mode: 'code' },
    );
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
  assert.equal(
    calls[0].url,
    `/api/teams/team_1/assistant-integrations/challenges/${CHALLENGE_ID}/authorize`,
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');

  const readOnlyUrl = authorizationUrl.replace('dns.read+dns.write', 'dns.read');
  assert.deepEqual(
    await authorizeAssistantIntegration(
      async () => response(200, { authorization_url: readOnlyUrl, completion_mode: 'code' }),
      'team_1',
      CHALLENGE_ID,
    ),
    { authorization_url: readOnlyUrl, completion_mode: 'code' },
  );

  for (const body of [
    { authorization_url: 'https://evil.example/oauth2/auth', completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('shimpz.com', 'shimpz.com.evil.example'), completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('https://', 'https://user@'), completion_mode: 'code' },
    { authorization_url: `${authorizationUrl}&next=https://evil.example`, completion_mode: 'code' },
    { authorization_url: `${authorizationUrl}#claim=must-not-cross`, completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('callback=out-of-band', 'callback=https://evil.example'), completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('dns.read+dns.write', 'dns.write+dns.read'), completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('dns.read+dns.write', 'dns.read+dns.read'), completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('dns.read+dns.write', 'account.write'), completion_mode: 'code' },
    { authorization_url: authorizationUrl.replace('dns.read+dns.write+offline_access+zone.read', ''), completion_mode: 'code' },
    { authorization_url: authorizationUrl, completion_mode: 'automatic' },
    { authorization_url: authorizationUrl, completion_mode: 'redirect' },
    { authorization_url: authorizationUrl },
    { authorization_url: authorizationUrl, completion_mode: 'code', code_verifier: 'must-not-cross' },
  ]) {
    await assert.rejects(
      authorizeAssistantIntegration(async () => response(200, body), 'team_1', CHALLENGE_ID),
      /authorization response is invalid/,
    );
  }

  await disconnectAssistantIntegration(
    async (url, options) => {
      calls.push({ url, options });
      return response(204, {});
    },
    'team_1',
    'social-publisher',
    'x-integration',
  );
  assert.equal(calls[1].url, '/api/teams/team_1/assistant-integrations/social-publisher/x-integration');
  assert.equal(calls[1].options.method, 'DELETE');
  await assert.rejects(
    disconnectAssistantIntegration(async () => response(200, {}), 'team_1', 'social-publisher', 'x-integration'),
    /disintegration response is invalid/,
  );
});

test('trusts an OAuth handoff only when it matches the exact Local page mode', async () => {
  const previousLocation = globalThis.location;
  try {
    const handoff = 'a'.repeat(64);
    const loopbackUrl = `http://127.0.0.1:7777/api/oauth/cloudflare/start?handoff=${handoff}`;
    const hostedUrl = `https://local.shimpz.com/api/oauth/cloudflare/start?handoff=${handoff}`;
    globalThis.location = {
      origin: 'http://127.0.0.1:7777', protocol: 'http:', hostname: '127.0.0.1', port: '7777',
    };
    assert.deepEqual(
      await authorizeAssistantIntegration(
        async () => response(200, { authorization_url: loopbackUrl, completion_mode: 'automatic' }),
        'team_1',
        CHALLENGE_ID,
      ),
      { authorization_url: loopbackUrl, completion_mode: 'automatic' },
    );
    await assert.rejects(
      authorizeAssistantIntegration(
        async () => response(200, { authorization_url: hostedUrl, completion_mode: 'automatic' }),
        'team_1',
        CHALLENGE_ID,
      ),
      /authorization response is invalid/,
    );

    globalThis.location = {
      origin: 'https://local.shimpz.com', protocol: 'https:', hostname: 'local.shimpz.com', port: '',
    };
    assert.deepEqual(
      await authorizeAssistantIntegration(
        async () => response(200, { authorization_url: hostedUrl, completion_mode: 'automatic' }),
        'team_1',
        CHALLENGE_ID,
      ),
      { authorization_url: hostedUrl, completion_mode: 'automatic' },
    );
    for (const authorizationUrl of [loopbackUrl, `http://127.0.0.1:49123/api/oauth/cloudflare/start?handoff=${handoff}`]) {
      await assert.rejects(
        authorizeAssistantIntegration(
          async () => response(200, { authorization_url: authorizationUrl, completion_mode: 'automatic' }),
          'team_1',
          CHALLENGE_ID,
        ),
        /authorization response is invalid/,
      );
    }
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('completes and cancels only the exact out-of-band challenge contract', async () => {
  const calls = [];
  const completionCode = `c1.${'s'.repeat(43)}.${'a'.repeat(64)}`;
  const completed = await completeAssistantIntegration(
    async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        connected: true,
        team_id: 'team_1',
        assistant_id: 'shimpz-cloudflare',
        integration_id: 'cloudflare',
      });
    },
    'team_1',
    CHALLENGE_ID,
    completionCode,
  );
  assert.equal(completed.connected, true);
  assert.equal(
    calls[0].url,
    `/api/teams/team_1/assistant-integrations/challenges/${CHALLENGE_ID}/complete`,
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { completion_code: completionCode });

  await cancelAssistantIntegrationAuthorization(
    async (url, options) => {
      calls.push({ url, options });
      return response(204, {});
    },
    'team_1',
    CHALLENGE_ID,
  );
  assert.equal(
    calls[1].url,
    `/api/teams/team_1/assistant-integrations/challenges/${CHALLENGE_ID}/authorize`,
  );
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].options.body, '{}');

  for (const invalid of [
    `c0.${'s'.repeat(43)}.${'a'.repeat(64)}`,
    `c1.${'s'.repeat(42)}.${'a'.repeat(64)}`,
    `c1.${'s'.repeat(43)}.${'A'.repeat(64)}`,
  ]) {
    await assert.rejects(
      completeAssistantIntegration(async () => response(200, {}), 'team_1', CHALLENGE_ID, invalid),
      /completion code/i,
    );
  }
  await assert.rejects(
    cancelAssistantIntegrationAuthorization(async () => response(200, {}), 'team_1', CHALLENGE_ID),
    /cancellation response is invalid/,
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


test('lists bounded file metadata outside the chat socket', async () => {
  const file = { id: 'b'.repeat(32), name: 'brief.txt', size: 42 };
  assert.deepEqual(
    await listTeamFiles(async () => response(200, { files: [file] }), 'team_1'),
    [file],
  );
});
