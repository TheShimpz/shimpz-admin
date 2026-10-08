import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_BOUNDARY_ROWS,
  historyBoundary,
  historyMark,
  historySince,
  listChatHistory,
  MAX_ARRIVED_RUNS,
  MAX_REFRESH_PAGES,
  mergedRoutineRuns,
  routineRuns,
} from '../src/lib/chatHistory.js';
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

function runRow(noticeId, routineId) {
  return {
    id: `${noticeId}:routine`,
    kind: 'routine-run',
    notice_id: noticeId,
    routine_id: routineId,
    name: 'Daily zones',
    run_id: noticeId,
    outcome: 'done',
    created_at: AT,
    detail: {
      plan: { revision: 1, plan_digest: `sha256:${'d'.repeat(64)}`, steps: 1, actions: [['shimpz-cloudflare', 'list-zones', 1]], more: 0 },
      output: null,
    },
    version: 1,
    usage: { duration_ms: 812, models: [] },
    protection_lost: false,
  };
}

function chatRow(index) {
  return { id: `${index.toString(16).padStart(32, '0')}:user`, created_at: AT, kind: 'message', role: 'user', text: 'Hi' };
}

test("a Routine's history is read from its own view, newest first, a page at a time with the cursor to older runs", async () => {
  const routine = '9'.repeat(32);
  const run = (digit) => runRow(digit.repeat(32), routine);
  const pages = {
    null: { entries: [run('1'), run('2'), run('3')], before: 'AAAAAAAAAMg' },
    AAAAAAAAAMg: { entries: [run('0')], before: null },
  };
  const requested = [];
  const fetcher = async (url) => {
    const { searchParams } = new URL(url, 'http://admin');
    requested.push([searchParams.get('before'), searchParams.get('routine')]);
    return response(200, pages[searchParams.get('before')]);
  };
  const seen = new Set();
  const found = await routineRuns(fetcher, 'marketing', routine, { seen });
  assert.deepEqual(found.runs.map((entry) => entry.runId[0]), ['3', '2', '1']);
  assert.equal(found.before, 'AAAAAAAAAMg');
  // The newest page's marks, oldest first, are the boundary a refresh reads back to.
  assert.deepEqual([...seen], ['1', '2', '3'].map((digit) => `${digit.repeat(32)}:routine@1`));
  const older = await routineRuns(fetcher, 'marketing', routine, { before: found.before });
  assert.deepEqual(older.runs.map((entry) => entry.runId[0]), ['0']);
  assert.equal(older.before, null);
  assert.deepEqual(requested, [[null, routine], ['AAAAAAAAAMg', routine]]);
  // Another Routine's row in this Routine's view is refused.
  const foreign = async () => response(200, { entries: [runRow('4'.repeat(32), '8'.repeat(32))], before: null });
  await assert.rejects(routineRuns(foreign, 'marketing', routine), LocalApiError);
});

test('a continuous Routine\'s healthy rollups and its missed runs count as its runs, with no run of their own', async () => {
  const routine = '9'.repeat(32);
  const rollup = (digit, runs) => ({
    ...runRow(digit.repeat(32), routine),
    run_id: null,
    outcome: 'healthy',
    detail: { runs },
  });
  const missed = { ...runRow('c'.repeat(32), routine), run_id: null, usage: null, outcome: 'skipped', detail: { missed: 2 } };
  const page = { entries: [missed, rollup('1', 12), runRow('2'.repeat(32), routine), rollup('3', 4)], before: null };
  const found = await routineRuns(async () => response(200, page), 'marketing', routine);
  // The rollups, the run, and the runs it missed are its history, found newest first.
  assert.deepEqual(found.runs.map((entry) => [entry.outcome, entry.runId, entry.detail.runs ?? null]), [
    ['healthy', null, 4],
    ['done', '2'.repeat(32), null],
    ['healthy', null, 12],
    ['skipped', null, null],
  ]);
  assert.equal(found.before, null);
});

test('a refresh reads back only to the newest row it already read, and a newer version is a new row', async () => {
  const routine = '9'.repeat(32);
  const run = (digit) => runRow(digit.repeat(32), routine);
  const known = run('1');
  const pages = {
    null: { entries: [run('4'), { ...known, version: 2 }, run('5')], before: 'AAAAAAAAAMg' },
    AAAAAAAAAMg: { entries: [run('2'), known, run('3')], before: 'AAAAAAAAAGQ' },
  };
  const requested = [];
  const fetcher = async (url) => {
    const { searchParams } = new URL(url, 'http://admin');
    requested.push([searchParams.get('before'), searchParams.get('routine')]);
    return response(200, pages[searchParams.get('before')]);
  };
  const seen = new Set([run('2'), known, run('3')].map((entry) => historyMark(restored(entry))));
  const since = await historySince(fetcher, 'marketing', seen, { routine });
  // The rewritten Routine row is new; reading stops at the page holding the newest row already read.
  assert.deepEqual(since.entries.map((entry) => entry.id), [run('4').id, known.id, run('5').id]);
  assert.equal(since.entries[1].version, 2);
  assert.equal(since.before, null);
  assert.deepEqual(requested, [[null, routine], ['AAAAAAAAAMg', routine]]);
  // Nothing written since: one page, nothing new.
  for (const entry of since.entries) seen.add(historyMark(entry));
  requested.length = 0;
  assert.deepEqual(await historySince(fetcher, 'marketing', seen, { routine }), { entries: [], before: null });
  assert.deepEqual(requested, [[null, routine]]);
  // The chat's view reads the same way, without a Routine; a history that ends first yields all of it.
  const ended = await historySince(async () => response(200, { entries: [chatRow(4)], before: null }), 'marketing', seen);
  assert.deepEqual(ended.entries.map((entry) => entry.id), [chatRow(4).id]);
});

test('a refresh stops at its page bound with every row it read and the cursor to continue from', async () => {
  let reads = 0;
  const endless = async () => {
    reads += 1;
    return response(200, { entries: [chatRow(reads)], before: 'AAAAAAAAAMg' });
  };
  const since = await historySince(endless, 'marketing', new Set());
  assert.equal(reads, MAX_REFRESH_PAGES);
  assert.deepEqual(since.entries.map((entry) => entry.id), Array.from(
    { length: MAX_REFRESH_PAGES },
    (_, index) => chatRow(MAX_REFRESH_PAGES - index).id,
  ));
  assert.equal(since.before, 'AAAAAAAAAMg');
});

test('the history boundary keeps only the marks of the newest rows read', () => {
  const marks = new Set(Array.from({ length: HISTORY_BOUNDARY_ROWS }, (_, index) => chatRow(index).id));
  const arrived = [chatRow(HISTORY_BOUNDARY_ROWS), restored(chatRow(HISTORY_BOUNDARY_ROWS + 1))];
  const boundary = historyBoundary(marks, arrived);
  assert.equal(boundary.size, HISTORY_BOUNDARY_ROWS);
  assert.equal(boundary.has(chatRow(0).id), false);
  assert.equal(boundary.has(chatRow(1).id), false);
  assert.deepEqual([...boundary].slice(-3), [
    chatRow(HISTORY_BOUNDARY_ROWS - 1).id,
    chatRow(HISTORY_BOUNDARY_ROWS).id,
    chatRow(HISTORY_BOUNDARY_ROWS + 1).id,
  ]);
  // However many rows a long-open panel reads, the boundary never grows past one page of them.
  let growing = new Set();
  for (let index = 0; index < 10 * HISTORY_BOUNDARY_ROWS; index += 1) growing = historyBoundary(growing, [chatRow(index)]);
  assert.equal(growing.size, HISTORY_BOUNDARY_ROWS);
  assert.equal(growing.has(chatRow(10 * HISTORY_BOUNDARY_ROWS - 1).id), true);
});

test("rows written since join a Routine's runs at the top, a newer version moving its run there", () => {
  const routine = '9'.repeat(32);
  const run = (digit, version = 1) => ({ ...restoredRun(digit, routine), version });
  const listed = [run('2'), run('1')];
  const arrived = [
    { id: chatRow(5).id, kind: 'message' },
    run('1', 2),
    restoredRun('7', '8'.repeat(32)),
    run('3'),
    run('2'),
  ];
  // Run 2 arrives at the version already listed, so it stays where it is.
  assert.deepEqual(mergedRoutineRuns(listed, arrived, routine).map((entry) => [entry.id[0], entry.version]), [
    ['3', 1], ['1', 2], ['2', 1],
  ]);
  assert.equal(mergedRoutineRuns(listed, [arrived[0]], routine), listed);
});

test("a Routine's merged runs never drop a listed run, so its older runs stay reachable past them", () => {
  const routine = '9'.repeat(32);
  const digits = '0123456789abcdef';
  const run = (index) => restoredRun(digits[index], routine);
  // A Routine keeps adding runs while its panel stays open; every listed run stays, newest first.
  let listed = [4, 3, 2, 1, 0].map(run);
  for (let index = 5; index < 16; index += 1) listed = mergedRoutineRuns(listed, [run(index)], routine);
  assert.deepEqual(listed.map((entry) => entry.id[0]), [...'fedcba9876543210']);
  // How many the panel takes before it reads its newest page again is one history page.
  assert.equal(MAX_ARRIVED_RUNS, 64);
});

function restoredRun(digit, routineId) {
  return {
    id: `${digit.repeat(32)}:routine`,
    kind: 'routine-run',
    runId: digit.repeat(32),
    routineId,
    outcome: 'done',
    version: 1,
  };
}
