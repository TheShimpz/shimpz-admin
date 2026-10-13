import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import { socketReads } from '../src/lib/session/socket.js';
import {
  decisionProvider,
  forgetDecisionProvider,
  loadDecisionProvider,
  removeDecisionKey,
  saveDecisionKey,
} from '../src/lib/decisionProvider.js';
import { recorder, response, via } from './socketStub.js';

const KEY = 'test-typesafe-key-word';
const EPOCH = 'a'.repeat(32);
const flush = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('loads only the closed masked TypeSafe state', async () => {
  const off = recorder(200, { provider: 'typesafe', configured: false, masked: null });
  assert.deepEqual(await via(off.call, loadDecisionProvider), { configured: false, masked: null });
  assert.deepEqual(off.calls, [{ method: 'decision.read', params: {} }]);

  const on = recorder(200, { provider: 'typesafe', configured: true, masked: '••••cdef' });
  assert.deepEqual(await loadDecisionProvider(on.call), { configured: true, masked: '••••cdef' });

  for (const body of [
    { provider: 'typesafe', configured: true, masked: '••••cdef', api_key: KEY },
    { provider: 'openai', configured: false, masked: null },
    { provider: 'typesafe', configured: true, masked: null },
    { provider: 'typesafe', configured: false, masked: '••••cdef' },
    { provider: 'typesafe', configured: true, masked: KEY },
    { provider: 'typesafe', configured: 'yes', masked: null },
    [],
  ]) {
    await assert.rejects(loadDecisionProvider(recorder(200, body).call), /invalid/, JSON.stringify(body));
  }
  await assert.rejects(loadDecisionProvider(recorder(503, { detail: 'down' }).call), (error) => error.status === 503);
});

/**
 * Admin as the decision key's screens see it: the key's state, which a save or removal changes and announces on
 * `space/decision` as Admin does, and each change's answer the test may hold back.
 */
function admin() {
  const state = { configured: false };
  const listeners = new Set();
  let revision = 0;
  const calls = [];
  let gate = null;
  const announce = () => {
    revision += 1;
    for (const listener of [...listeners]) listener('space/decision', 'changed', { epoch: EPOCH, revision });
  };
  const body = () => ({ provider: 'typesafe', configured: state.configured, masked: state.configured ? '••••word' : null });
  socketReads.watch = (topic, listener) => {
    listeners.add(listener);
    queueMicrotask(() => listener(topic, 'open', { epoch: EPOCH, revision }));
    return () => listeners.delete(listener);
  };
  socketReads.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'decision.read') return response(200, body());
    state.configured = method === 'decision.save';
    announce();
    const answer = body();
    if (gate) await gate;
    return response(200, answer);
  };
  return {
    state,
    calls,
    announce,
    hold() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

test('the key shown is the one Admin holds, read again after a save and a removal', async () => {
  const server = admin();
  const stop = decisionProvider.subscribe(() => {});
  await flush();
  assert.deepEqual(get(decisionProvider).value, { configured: false, masked: null });
  await saveDecisionKey(` ${KEY} `);
  assert.deepEqual(server.calls.filter((entry) => entry.method === 'decision.save'), [
    { method: 'decision.save', params: { body: { api_key: KEY } } },
  ]);
  assert.deepEqual(get(decisionProvider).value, { configured: true, masked: '••••word' });
  await removeDecisionKey();
  assert.deepEqual(get(decisionProvider).value, { configured: false, masked: null });
  for (const key of ['', 'short', 'x'.repeat(8193), null]) {
    await assert.rejects(saveDecisionKey(key), /valid TypeSafe/);
  }
  stop();
  forgetDecisionProvider();
  assert.equal(get(decisionProvider).value, null);
});

test('a change announced while a save runs is read, and the save answered last never overwrites it', async () => {
  const server = admin();
  const stop = decisionProvider.subscribe(() => {});
  await flush();
  const release = server.hold();
  const saving = saveDecisionKey(KEY);
  await flush();
  // Admin stored the key and announced it before its answer: the key shows from the read.
  assert.deepEqual(get(decisionProvider).value, { configured: true, masked: '••••word' });
  // Another tab removes it before the save's answer arrives; the late answer still says configured.
  server.state.configured = false;
  server.announce();
  await flush();
  release();
  await saving;
  assert.deepEqual(get(decisionProvider).value, { configured: false, masked: null });
  stop();
  forgetDecisionProvider();
});

test('a change Admin refused, or answered with the wrong state, fails and stores nothing it shows', async () => {
  for (const [answer, check] of [
    [response(400, { detail: 'TypeSafe rejected API key' }), (error) => error.status === 400],
    [response(200, { provider: 'typesafe', configured: false, masked: null }), /invalid/],
  ]) {
    socketReads.call = async () => answer;
    await assert.rejects(saveDecisionKey(KEY), check);
  }
  socketReads.call = async () => response(200, { provider: 'typesafe', configured: true, masked: '••••cdef' });
  await assert.rejects(removeDecisionKey(), /invalid/);
});
