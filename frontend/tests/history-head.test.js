import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/session/socket.js';
import {
  chatHistory,
  clearChatHistories,
  forgetChatHistoriesExcept,
  historyHead,
  MAX_REFRESH_PAGES,
  MAX_VIEW_ROWS,
} from '../src/lib/chat/history.js';
import { RETRY_FIRST_MS } from '../src/lib/session/synced.js';

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
    usage: { duration_ms: 812 },
    protection_lost: false,
  };
}

// The session socket as a history head sees it: its topic's listeners, and each `history.page` read held until the test
// answers it with a page and the revision of the history topic it reflects.
function socket() {
  const listeners = new Set();
  const reads = [];
  socketReads.subscribed = () => true;
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

// The last value shown, which has no view, held only weakly from here on: the caller's own frame keeps no reference.
function viewless(values) {
  const value = values.pop();
  assert.equal(value.view, null);
  values.length = 0;
  return new WeakRef(value);
}

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

test("the chat's view is the whole conversation a reload would open, with each row written since", async () => {
  const api = socket();
  const { values, stop } = follow(historyHead('marketing'));
  api.announce('open', 1);
  api.reads[0].answer([message(1), message(2)], { before: 'AAAAAAAAAMg' });
  await flush();
  assert.deepEqual(values[0].view.entries.map((entry) => entry.id), [message(1).id, message(2).id]);
  assert.equal(values[0].view.before, 'AAAAAAAAAMg');
  // The rows written since join the view; the cursor stays the opening one.
  api.announce('changed', 2);
  api.reads[1].answer([message(1), message(2), message(3)], { revision: 2 });
  await flush();
  const { view } = values.at(-1);
  assert.deepEqual(view.entries.map((entry) => entry.id), [message(1).id, message(2).id, message(3).id]);
  assert.equal(view.before, 'AAAAAAAAAMg');
  assert.ok(view.bytes > 0);
  stop();
  // A Routine's own head keeps no view.
  const routineHead = follow(historyHead('marketing', { routine: 'c'.repeat(32) }));
  api.announce('open', 2);
  api.reads[2].answer([run(4)], { revision: 2 });
  await flush();
  assert.equal(routineHead.values[0].view, null);
  routineHead.stop();
});

test('a history that no longer holds any row read before replaces the conversation', async () => {
  const api = socket();
  const { values, stop } = follow(historyHead('marketing'));
  api.announce('open', 1);
  api.reads[0].answer([message(1), message(2)]);
  await flush();
  // The Team was deleted and one with the same id holds a new history: none of the rows read before is there.
  api.announce('changed', 2);
  api.reads[1].answer([message(7)], { revision: 2 });
  await flush();
  assert.deepEqual([values.at(-1).restart, ids(values.at(-1)), values.at(-1).before], [true, [message(7).id], null]);
  assert.deepEqual(values.at(-1).view.entries.map((entry) => entry.id), [message(7).id]);
  stop();
});

test('a view grown past its bound is dropped, and the head is then measured by the rows it holds', async () => {
  const api = socket();
  const head = historyHead('marketing');
  const { values, stop } = follow(head);
  api.announce('open', 1);
  api.reads[0].answer([message(0)]);
  await flush();
  assert.equal(head.size(), values[0].view.bytes);
  // More rows than a view keeps are written, over five pages read newest first back to the row read before.
  const written = Array.from({ length: MAX_VIEW_ROWS }, (_, index) => message(index + 1));
  const pages = [
    written.slice(255), written.slice(191, 255), written.slice(127, 191), written.slice(63, 127),
    [message(0), ...written.slice(0, 63)],
  ];
  api.announce('changed', 2);
  for (const [index, page] of pages.entries()) {
    api.reads[1 + index].answer(page, { before: `AAAAAAAA0${index + 1}A`, revision: 2 });
    await flush();
  }
  assert.equal(values.at(-1).restart, false);
  assert.equal(values.at(-1).entries.length, MAX_VIEW_ROWS);
  assert.equal(values.at(-1).view, null);
  assert.ok(head.size() > 0);
  // A restart reads the newest page again, whose view is whole again.
  const restarted = head.restart();
  api.reads.at(-1).answer([message(300)], { revision: 2 });
  await restarted;
  assert.deepEqual(values.at(-1).view.entries.map((entry) => entry.id), [message(300).id]);
  stop();
});

test("the session keeps each Team's chat, forgets a Team no longer listed, and forgets every one at its end", async () => {
  const api = socket();
  const head = chatHistory('marketing');
  assert.equal(chatHistory('marketing').subscribe, head.subscribe);
  let shown = follow(head);
  api.announce('open', 1);
  api.reads[0].answer([message(1)]);
  await flush();
  shown.stop();
  // Shown again at the same revision: the conversation shows at once, and nothing is read.
  shown = follow(head);
  assert.deepEqual(ids(shown.values[0]), [message(1).id]);
  api.announce('subscribed', 1);
  assert.equal(await head.current(), 'current');
  assert.equal(api.reads.length, 1);
  shown.stop();
  // A Team no longer listed is forgotten: shown again, it reads its history from the start.
  forgetChatHistoriesExcept(['finance']);
  shown = follow(head);
  assert.equal(shown.values.length, 0);
  api.announce('subscribed', 1);
  assert.deepEqual(api.reads[1].params, { team_id: 'marketing' });
  api.reads[1].answer([message(2)]);
  await flush();
  shown.stop();
  clearChatHistories();
  shown = follow(head);
  assert.equal(shown.values.length, 0);
  shown.stop();
});

test('a restart asked for after a screen left is answered by the newest page, never by a read of the earlier visit', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const api = socket();
    const head = historyHead('marketing', { retain: { maxAgeMs: Infinity } });
    let shown = follow(head);
    api.announce('open', 1);
    api.reads[0].answer([message(1)]);
    await flush();
    // A restart is under way when the screen leaves; the next screen asks for one again.
    void head.restart();
    shown.stop();
    shown = follow(head);
    api.announce('subscribed', 1);
    void head.restart();
    // The earlier visit's newest page arrives late, and the restart's own read fails for a moment.
    api.reads[1].answer([message(1), message(2)]);
    await flush();
    api.reads[2].answer([], { status: 503 });
    await flush();
    mock.timers.tick(RETRY_FIRST_MS);
    api.reads[3].answer([message(1), message(5)]);
    await flush();
    assert.equal(shown.values.at(-1).restart, true);
    assert.deepEqual(ids(shown.values.at(-1)), [message(1).id, message(5).id]);
    shown.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a kept chat whose view outgrew its bounds is not kept once it is left, so it holds no more than a view's rows", async () => {
  clearChatHistories();
  const api = socket();
  const head = chatHistory('marketing');
  let shown = follow(head);
  api.announce('open', 1);
  api.reads[0].answer([message(0)]);
  await flush();
  // Two pages more than a view keeps are written while the chat is shown: the head drops its view.
  const written = Array.from({ length: 2 * MAX_VIEW_ROWS }, (_, index) => message(index + 1));
  const pages = Array.from({ length: 8 }, (_, index) => written.slice(written.length - 64 * (index + 1), written.length - 64 * index));
  pages[7] = [message(0), ...pages[7].slice(1)];
  api.announce('changed', 2);
  for (const [index, page] of pages.entries()) {
    api.reads[1 + index].answer(page, { before: index < 7 ? `AAAAAAAA0${index + 1}A` : null, revision: 2 });
    await flush();
  }
  const oversized = viewless(shown.values);
  shown.stop();
  await flush();
  // Left, it keeps nothing: nothing holds its rows any more, and shown again, nothing shows before the newest page is
  // read again.
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc');
  // A WeakRef dereferenced keeps its target until the job ends, so it is read only once collection is done.
  for (let round = 0; round < 3; round += 1) {
    collect();
    await flush();
  }
  assert.equal(oversized.deref(), undefined);
  assert.equal(head.size(), 0);
  shown = follow(head);
  assert.equal(shown.values.length, 0);
  api.announce('subscribed', 2);
  assert.deepEqual(api.reads.at(-1).params, { team_id: 'marketing' });
  api.reads.at(-1).answer([message(600)], { revision: 2 });
  await flush();
  assert.deepEqual(ids(shown.values.at(-1)), [message(600).id]);
  assert.ok(shown.values.at(-1).view);
  shown.stop();
  clearChatHistories();
});
