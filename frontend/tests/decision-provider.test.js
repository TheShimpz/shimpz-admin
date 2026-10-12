import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forgetDecisionProvider,
  knownDecisionProvider,
  loadDecisionProvider,
  removeDecisionKey,
  saveDecisionKey,
} from '../src/lib/decisionProvider.js';

const KEY = 'tsk-browser-contract-0123456789';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function recorder(status, body) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return response(status, body);
  };
  return { calls, fetcher };
}

test('loads only the closed masked TypeSafe state', async () => {
  const off = recorder(200, { provider: 'typesafe', configured: false, masked: null });
  assert.deepEqual(await loadDecisionProvider(off.fetcher), { configured: false, masked: null });
  assert.equal(off.calls[0].url, '/api/decision-provider');
  assert.equal(off.calls[0].init.cache, 'no-store');

  const on = recorder(200, { provider: 'typesafe', configured: true, masked: '••••cdef' });
  assert.deepEqual(await loadDecisionProvider(on.fetcher), { configured: true, masked: '••••cdef' });

  for (const body of [
    { provider: 'typesafe', configured: true, masked: '••••cdef', api_key: KEY },
    { provider: 'openai', configured: false, masked: null },
    { provider: 'typesafe', configured: true, masked: null },
    { provider: 'typesafe', configured: false, masked: '••••cdef' },
    { provider: 'typesafe', configured: true, masked: KEY },
    { provider: 'typesafe', configured: 'yes', masked: null },
    [],
  ]) {
    await assert.rejects(loadDecisionProvider(recorder(200, body).fetcher), /invalid/, JSON.stringify(body));
  }
  await assert.rejects(loadDecisionProvider(recorder(503, { detail: 'down' }).fetcher), (error) => error.status === 503);
  await assert.rejects(loadDecisionProvider(null), /Invalid/);
});

test('saves a trimmed key once and accepts only a configured masked answer', async () => {
  const saved = recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' });
  assert.deepEqual(await saveDecisionKey(saved.fetcher, ` ${KEY} `), { configured: true, masked: '••••6789' });
  assert.equal(saved.calls.length, 1);
  assert.equal(saved.calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), { api_key: KEY });

  for (const key of ['', 'short', 'x'.repeat(8193), null]) {
    const unused = recorder(200, {});
    await assert.rejects(saveDecisionKey(unused.fetcher, key), /valid TypeSafe/);
    assert.equal(unused.calls.length, 0);
  }
  await assert.rejects(
    saveDecisionKey(recorder(200, { provider: 'typesafe', configured: false, masked: null }).fetcher, KEY),
    /invalid/,
  );
  await assert.rejects(
    saveDecisionKey(recorder(400, { detail: 'TypeSafe rejected API key' }).fetcher, KEY),
    (error) => error.status === 400 && error.message === 'TypeSafe rejected API key',
  );
});

test('removal must answer an unconfigured state', async () => {
  const removed = recorder(200, { provider: 'typesafe', configured: false, masked: null });
  assert.deepEqual(await removeDecisionKey(removed.fetcher), { configured: false, masked: null });
  assert.equal(removed.calls[0].init.method, 'DELETE');
  assert.equal(removed.calls[0].init.body, undefined);
  await assert.rejects(
    removeDecisionKey(recorder(200, { provider: 'typesafe', configured: true, masked: '••••cdef' }).fetcher),
    /invalid/,
  );
});

test('the session remembers the state it last read or saved, and forgets it when the session ends', async () => {
  forgetDecisionProvider();
  assert.equal(knownDecisionProvider(), null);
  await loadDecisionProvider(recorder(200, { provider: 'typesafe', configured: false, masked: null }).fetcher);
  assert.deepEqual(knownDecisionProvider(), { configured: false, masked: null });
  await saveDecisionKey(recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' }).fetcher, KEY);
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });
  await assert.rejects(loadDecisionProvider(recorder(503, { detail: 'down' }).fetcher));
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });

  let answer;
  const late = loadDecisionProvider(async () => new Promise((resolve) => { answer = resolve; }));
  forgetDecisionProvider();
  answer(response(200, { provider: 'typesafe', configured: true, masked: '••••cdef' }));
  assert.deepEqual(await late, { configured: true, masked: '••••cdef' });
  assert.equal(knownDecisionProvider(), null);
});

test('a read that started before a save never overwrites the saved state', async () => {
  forgetDecisionProvider();
  let answer;
  const slowRead = loadDecisionProvider(async () => new Promise((resolve) => { answer = resolve; }));
  await saveDecisionKey(recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' }).fetcher, KEY);
  answer(response(200, { provider: 'typesafe', configured: false, masked: null }));
  assert.deepEqual(await slowRead, { configured: false, masked: null });
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });
});

test('a read that overlaps a save or removal never overwrites what it stored, whichever finishes first', async () => {
  const configured = { provider: 'typesafe', configured: true, masked: '••••6789' };
  const unconfigured = { provider: 'typesafe', configured: false, masked: null };
  for (const [change, stored, replaced] of [
    [(fetcher) => saveDecisionKey(fetcher, KEY), configured, unconfigured],
    [(fetcher) => removeDecisionKey(fetcher), unconfigured, configured],
  ]) {
    forgetDecisionProvider();
    let finish;
    const pending = change(async () => new Promise((resolve) => { finish = resolve; }));
    // A read that starts after the change and answers first, with the state the change replaces.
    await loadDecisionProvider(recorder(200, replaced).fetcher);
    finish(response(200, stored));
    await pending;
    assert.deepEqual(knownDecisionProvider(), { configured: stored.configured, masked: stored.masked });
  }
});
