import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/adminSocket.js';
import { historyHead, MAX_REFRESH_PAGES } from '../src/lib/chatHistory.js';
import { RETRY_FIRST_MS } from '../src/lib/synced.js';

const EPOCH = 'a'.repeat(32);
const AT = '2026-10-02T21:15:00Z';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function message(index) {
  return { id: `${String(index).padStart(32, '0')}:user`, created_at: AT, kind: 'message', role: 'user', text: `m${index}` };
}

function run(index, routine = 'c'.repeat(32)) {
  const notice = String(index).padStart(32, '0');
  return {
    id: `${notice}:routine`,
    kind: 'routine-run',
    notice_id: notice,
    routine_id: routine,
    name: 'Daily zones',
    run_id: notice,
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

// The session socket as a history head sees it: its topic's listeners, and each `history.page` read held until the test
// answers it with a page and the revision of the history topic it reflects.
function socket() {
  const listeners = new Set();
  const reads = [];
  socketReads.watch = (_topic, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  socketReads.call = (method, params) => new Promise((resolve) => {
    assert.equal(method, 'history.page');
    reads.push({
      params,
      answer(entries, { before = null, revision = 1, status = 200 } = {}) {
        const body = status === 200 ? { entries, before } : { detail: 'Admin chat history is unavailable' };
        resolve({
          ok: status === 200,
          status,
          async json() { return structuredClone(body); },
          revision: status === 200 ? { topic: 'team/marketing/history', epoch: EPOCH, revision } : null,
        });
      },
    });
  });
  return {
    reads,
    announce(cause, revision) {
      for (const listener of [...listeners]) listener('team/marketing/history', cause, { epoch: EPOCH, revision });
    },
  };
}

function follow(head) {
  const values = [];
  const stop = head.subscribe((state) => {
    if (state.status === 'ready' && values.at(-1) !== state.value) values.push(state.value);
  });
  return { values, stop };
}

const ids = (value) => value.entries.map((entry) => entry.id);

test('the head reads the newest page once subscribed, then only the rows written since, in order', async () => {
  const api = socket();
  const { values, stop } = follow(historyHead('marketing'));
  assert.equal(api.reads.length, 0);
  api.announce('open', 1);
  api.reads[0].answer([message(1), message(2)], { before: 'AAAAAAAAAMg' });
  await flush();
  assert.deepEqual([values[0].restart, ids(values[0]), values[0].before], [true, [message(1).id, message(2).id], 'AAAAAAAAAMg']);
  // Two changes while a read runs: the second waits, and nothing is merged twice.
  api.announce('changed', 2);
  api.announce('changed', 3);
  assert.equal(api.reads.length, 2);
  assert.deepEqual(api.reads[1].params, { team_id: 'marketing' });
  api.reads[1].answer([message(1), message(2), message(3)], { revision: 2 });
  await flush();
  assert.equal(api.reads.length, 3);
  api.reads[2].answer([message(2), message(3), message(4)], { revision: 3 });
  await flush();
  assert.deepEqual(values.slice(1).map((value) => [value.restart, ids(value)]), [
    [false, [message(3).id]],
    [false, [message(4).id]],
  ]);
  stop();
});

test('a reopen at a newer revision reads what was written meanwhile; one at the same revision reads nothing', async () => {
  const api = socket();
  const { values, stop } = follow(historyHead('marketing'));
  api.announce('open', 4);
  api.reads[0].answer([message(1)], { revision: 4 });
  await flush();
  api.announce('reopen', 4);
  assert.equal(api.reads.length, 1);
  api.announce('reopen', 6);
  api.reads[1].answer([message(1), message(2)], { revision: 6 });
  await flush();
  assert.deepEqual(ids(values.at(-1)), [message(2).id]);
  stop();
});

test('an unavailable history is read again on its own, and nothing it missed is lost', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const api = socket();
    const { values, stop } = follow(historyHead('marketing'));
    api.announce('open', 1);
    api.reads[0].answer([message(1)]);
    await flush();
    api.announce('changed', 2);
    api.reads[1].answer([], { status: 503 });
    await flush();
    assert.equal(values.length, 1);
    mock.timers.tick(RETRY_FIRST_MS);
    api.reads[2].answer([message(1), message(2)], { revision: 2 });
    await flush();
    assert.deepEqual(ids(values.at(-1)), [message(2).id]);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('more written than one refresh reads starts the chat again from what it read', async () => {
  const api = socket();
  const { values, stop } = follow(historyHead('marketing'));
  api.announce('open', 1);
  api.reads[0].answer([message(1)]);
  await flush();
  api.announce('changed', 2);
  for (let page = 0; page < MAX_REFRESH_PAGES; page += 1) {
    api.reads[1 + page].answer([message(100 + page)], { before: `AAAAAAAA${String(page + 1).padStart(2, '0')}A`, revision: 2 });
    await flush();
  }
  const value = values.at(-1);
  assert.equal(value.restart, true);
  assert.equal(value.entries.length, MAX_REFRESH_PAGES);
  assert.equal(value.before, `AAAAAAAA${String(MAX_REFRESH_PAGES).padStart(2, '0')}A`);
  stop();
});

test("a Routine's own head restarts from its newest page, and on request", async () => {
  const api = socket();
  const routine = 'c'.repeat(32);
  const head = historyHead('marketing', { routine });
  const { values, stop } = follow(head);
  api.announce('open', 1);
  assert.deepEqual(api.reads[0].params, { team_id: 'marketing', routine });
  api.reads[0].answer([run(1)]);
  await flush();
  api.announce('changed', 2);
  for (let page = 0; page < MAX_REFRESH_PAGES; page += 1) {
    api.reads[1 + page].answer([run(100 + page)], { before: `AAAAAAAA${String(page + 1).padStart(2, '0')}A`, revision: 2 });
    await flush();
  }
  // More ended than one refresh reads: the newest page is read again.
  assert.deepEqual(api.reads.at(-1).params, { team_id: 'marketing', routine });
  api.reads.at(-1).answer([run(200)], { before: 'AAAAAAAAAMg', revision: 2 });
  await flush();
  assert.deepEqual([values.at(-1).restart, values.at(-1).before], [true, 'AAAAAAAAAMg']);
  const restarted = head.restart();
  api.reads.at(-1).answer([run(201)], { revision: 2 });
  await restarted;
  assert.equal(values.at(-1).restart, true);
  assert.equal(get(head).status, 'ready');
  stop();
});
