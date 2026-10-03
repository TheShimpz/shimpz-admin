import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import { LocalApiError } from '../src/lib/localApi.js';

const TURN_A = 'a'.repeat(32);
const TURN_B = 'b'.repeat(32);
const CURSOR = 'AAAAAAAAAAI';
const AT = '2026-10-02T21:15:00Z';

// The parsed entry carries the row's time as createdAt, the same name a Routine notice's time has.
function restored({ created_at: createdAt, ...entry }) {
  return { ...entry, createdAt };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function installedEntry() {
  return {
    id: `${TURN_A}:install`,
    created_at: AT,
    kind: 'assistant-install',
    state: 'installed',
    assistants: [{
      id: 'shimpz-cloudflare',
      name: 'Shimpz Cloudflare',
      summary: 'Safely manage Cloudflare DNS records through OAuth.',
      providers: ['cloudflare'],
      provenance: 'local',
      status: 'installed',
    }],
  };
}

test('loads one exact bounded Team chat history page', async () => {
  const calls = [];
  const body = {
    entries: [
      { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Install Cloudflare' },
      installedEntry(),
      {
        id: `${TURN_B}:reply`,
        created_at: AT,
        kind: 'message',
        role: 'assistant',
        text: 'Cloudflare is ready.',
        author: 'Marketing',
      },
      {
        id: `${TURN_B}:guidance`,
        created_at: AT,
        kind: 'guidance',
        code: 'assistant-install-target-required',
        reply: 'Which Assistant do you want to install?',
      },
    ],
    before: CURSOR,
  };
  const result = await listChatHistory(async (url, options) => {
    calls.push({ url, options });
    return response(200, body);
  }, 'marketing');

  assert.deepEqual(result, { entries: body.entries.map(restored), before: CURSOR });
  assert.deepEqual(calls, [{
    url: '/api/teams/marketing/chat/history',
    options: { cache: 'no-store', headers: { Accept: 'application/json' } },
  }]);
  assert.notEqual(result.entries, body.entries);
  assert.notEqual(result.entries[1].assistants, body.entries[1].assistants);
});

test('loads older Team chat history with only an opaque cursor', async () => {
  const calls = [];
  await listChatHistory(async (url, options) => {
    calls.push({ url, options });
    return response(200, { entries: [], before: null });
  }, 'marketing', CURSOR);

  assert.equal(calls[0].url, `/api/teams/marketing/chat/history?before=${CURSOR}`);
  for (const cursor of ['', '1', 'AAAAAAAAAAA=', '../other-team', 'x'.repeat(17)]) {
    await assert.rejects(
      listChatHistory(async () => response(200, {}), 'marketing', cursor),
      (error) => error instanceof LocalApiError,
    );
  }
});

test('bounds history text by Unicode code points, as the Admin history counts it', async () => {
  const reply = (author, text = 'Done.') => (
    { id: `${TURN_B}:reply`, created_at: AT, kind: 'message', role: 'assistant', text, author }
  );
  const load = (entry) => listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing');
  for (const character of ['界', '😀']) {
    const entry = reply(character.repeat(80), character.repeat(60_000));
    assert.deepEqual((await load(entry)).entries, [restored(entry)]);
    for (const invalid of [reply(character.repeat(81)), reply('Marketing', character.repeat(60_001))]) {
      await assert.rejects(load(invalid), (error) => error instanceof LocalApiError);
    }
  }
});

test('loads the exact already-installed terminal outcome', async () => {
  const entry = { ...installedEntry(), outcome: 'already-installed' };
  const result = await listChatHistory(
    async () => response(200, { entries: [entry], before: null }),
    'marketing',
  );

  assert.deepEqual(result.entries, [restored(entry)]);
});

test('fails closed on malformed or secret-bearing chat history', async () => {
  const invalidEntries = [
    { ...installedEntry(), access_token: 'must-not-cross' },
    { ...installedEntry(), outcome: 'unknown' },
    { ...installedEntry(), state: 'stopped', outcome: 'already-installed' },
    { ...installedEntry(), assistants: [{ ...installedEntry().assistants[0], providers: ['dns', 'dns'] }] },
    { ...installedEntry(), assistants: [{ ...installedEntry().assistants[0], status: 'pending' }] },
    { ...installedEntry(), assistants: [{ ...installedEntry().assistants[0], name: 'Cloud\u202eFlare' }] },
    { ...installedEntry(), assistants: [{ ...installedEntry().assistants[0], summary: 'Line one\nLine two' }] },
    { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'hello', author: 'Marketing' },
    { id: `${TURN_A}:guidance`, created_at: AT, kind: 'guidance', code: 'unknown', reply: 'Question?' },
    {
      id: `${TURN_A}:uninstall`,
      created_at: AT,
      kind: 'assistant-uninstall',
      state: 'failed',
      status: 200,
      assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.5' },
    },
    // Team's English registry summary is never stored or shown with an uninstall.
    {
      id: `${TURN_A}:uninstall`,
      created_at: AT,
      kind: 'assistant-uninstall',
      state: 'cancelled',
      assistant: {
        id: 'shimpz-cloudflare',
        name: 'Shimpz Cloudflare',
        summary: 'Safely manage Cloudflare DNS records through OAuth.',
        version: '0.4.5',
      },
    },
  ];
  for (const entry of invalidEntries) {
    await assert.rejects(
      listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing'),
      (error) => error instanceof LocalApiError && error.message.includes('history is invalid'),
    );
  }
  await assert.rejects(
    listChatHistory(async () => response(200, {
      entries: [
        { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'hello' },
        { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'again' },
      ],
      before: null,
    }), 'marketing'),
    (error) => error instanceof LocalApiError,
  );
});

test('every history row carries its exact UTC time, and a missing or malformed time fails closed', async () => {
  const user = { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'hello' };
  const load = (entry) => listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing');
  assert.equal((await load(user)).entries[0].createdAt, AT);
  assert.equal(Object.hasOwn((await load(user)).entries[0], 'created_at'), false);
  const { created_at: _, ...undated } = user;
  for (const entry of [
    undated,
    { ...user, created_at: null },
    { ...user, created_at: 1_759_441_200 },
    { ...user, created_at: '2026-10-02' },
    { ...user, created_at: '2026-10-02T21:15:00.000Z' },
    { ...user, created_at: '2026-10-02T21:15:00+00:00' },
    { ...user, created_at: '2026-02-30T21:15:00Z' },
    { ...user, created_at: ' 2026-10-02T21:15:00Z' },
    { ...installedEntry(), created_at: '2026-10-02 21:15:00' },
    { ...replyEntry(), created_at: undefined },
  ]) {
    await assert.rejects(
      load(entry),
      (error) => error instanceof LocalApiError && error.message.includes('history is invalid'),
      JSON.stringify(entry),
    );
  }
});

test('projects safe history service failures and rejects invalid requests', async () => {
  await assert.rejects(
    listChatHistory(async () => response(503, { detail: 'history unavailable' }), 'marketing'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'history unavailable',
  );
  for (const teamId of ['', 'Marketing', '../marketing']) {
    await assert.rejects(
      listChatHistory(async () => response(200, {}), teamId),
      (error) => error instanceof LocalApiError,
    );
  }
});

const USAGE = {
  duration_ms: 6240,
  models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 11_900, output_tokens: 580 }],
};

function replyEntry(extra = {}) {
  return {
    id: `${TURN_A}:reply`,
    created_at: AT,
    kind: 'message',
    role: 'assistant',
    text: 'Done.',
    author: 'Marketing',
    ...extra,
  };
}

async function historyOf(entry) {
  return listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing');
}

test('a restored reply keeps its exact turn usage, and one stored without usage has none', async () => {
  const [used] = (await historyOf(replyEntry({ usage: USAGE }))).entries;
  assert.deepEqual(used.usage, USAGE);
  const [plain] = (await historyOf(replyEntry())).entries;
  assert.equal(Object.hasOwn(plain, 'usage'), false);
});

test('a restored reply whose usage breaks the closed shape, or a user message with usage, fails closed', async () => {
  const model = USAGE.models[0];
  for (const entry of [
    replyEntry({ usage: null }),
    replyEntry({ usage: {} }),
    replyEntry({ usage: { ...USAGE, extra: true } }),
    replyEntry({ usage: { ...USAGE, models: [] } }),
    replyEntry({ usage: { ...USAGE, duration_ms: 86_400_001 } }),
    replyEntry({ usage: { ...USAGE, models: [{ ...model, provider: ['openai'] }] } }),
    replyEntry({ usage: { ...USAGE, models: [model, model] } }),
    { id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'hello', usage: USAGE },
  ]) {
    await assert.rejects(
      historyOf(entry),
      (error) => error instanceof LocalApiError && error.message.includes('history is invalid'),
      JSON.stringify(entry),
    );
  }
});

const FILE = { id: 'f'.repeat(32), name: 'contract.pdf', media_type: 'application/pdf', size: 2048 };

test('a reloaded user message keeps the references of the files it carried, and nothing more', async () => {
  const second = { id: 'e'.repeat(32), name: 'photo.png', media_type: 'image/png', size: 4096 };
  const entry = {
    id: `${TURN_A}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Compare them.', files: [second, FILE],
  };
  const result = await listChatHistory(async () => response(200, { entries: [entry], before: null }), 'marketing');
  assert.deepEqual(result.entries, [restored(entry)]);
  assert.notEqual(result.entries[0].files, entry.files);

  const invalid = [
    [],
    [FILE, FILE],
    Array.from({ length: 9 }, (_, index) => ({ ...FILE, id: index.toString(16).repeat(32) })),
    [{ ...FILE, sha256: 'ab'.repeat(32) }],
    [{ ...FILE, id: 'not-an-id' }],
    [{ ...FILE, name: '../contract.pdf' }],
    [{ ...FILE, media_type: 'application/pdf; charset=binary' }],
    [{ ...FILE, size: 0 }],
    [{ ...FILE, size: 25 * 1024 * 1024 + 1 }],
    'contract.pdf',
  ];
  for (const files of invalid) {
    await assert.rejects(
      listChatHistory(async () => response(200, { entries: [{ ...entry, files }], before: null }), 'marketing'),
      LocalApiError,
    );
  }
  // Only a user message carries files.
  const reply = {
    id: `${TURN_A}:reply`, created_at: AT, kind: 'message', role: 'assistant', text: 'Done.', author: 'Marketing',
  };
  await assert.rejects(
    listChatHistory(async () => response(200, { entries: [{ ...reply, files: [FILE] }], before: null }), 'marketing'),
    LocalApiError,
  );
});

