import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDecisionProvider, removeDecisionKey, saveDecisionKey } from '../src/lib/decisionProvider.js';

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
