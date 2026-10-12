import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forgetDecisionProvider,
  knownDecisionProvider,
  loadDecisionProvider,
  removeDecisionKey,
  saveDecisionKey,
} from '../src/lib/decisionProvider.js';
import { held, recorder, response, via } from './socketStub.js';

const KEY = 'tsk-browser-contract-0123456789';

test('loads only the closed masked TypeSafe state', async () => {
  const off = recorder(200, { provider: 'typesafe', configured: false, masked: null });
  assert.deepEqual(await via(off.call, loadDecisionProvider), { configured: false, masked: null });
  assert.deepEqual(off.calls, [{ method: 'decision.read', params: {} }]);

  const on = recorder(200, { provider: 'typesafe', configured: true, masked: '••••cdef' });
  assert.deepEqual(await via(on.call, loadDecisionProvider), { configured: true, masked: '••••cdef' });

  for (const body of [
    { provider: 'typesafe', configured: true, masked: '••••cdef', api_key: KEY },
    { provider: 'openai', configured: false, masked: null },
    { provider: 'typesafe', configured: true, masked: null },
    { provider: 'typesafe', configured: false, masked: '••••cdef' },
    { provider: 'typesafe', configured: true, masked: KEY },
    { provider: 'typesafe', configured: 'yes', masked: null },
    [],
  ]) {
    await assert.rejects(via(recorder(200, body).call, loadDecisionProvider), /invalid/, JSON.stringify(body));
  }
  await assert.rejects(
    via(recorder(503, { detail: 'down' }).call, loadDecisionProvider),
    (error) => error.status === 503,
  );
});

test('saves a trimmed key once and accepts only a configured masked answer', async () => {
  const saved = recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' });
  assert.deepEqual(await via(saved.call, () => saveDecisionKey(` ${KEY} `)), { configured: true, masked: '••••6789' });
  assert.deepEqual(saved.calls, [{ method: 'decision.save', params: { body: { api_key: KEY } } }]);

  for (const key of ['', 'short', 'x'.repeat(8193), null]) {
    const unused = recorder(200, {});
    await assert.rejects(via(unused.call, () => saveDecisionKey(key)), /valid TypeSafe/);
    assert.equal(unused.calls.length, 0);
  }
  await assert.rejects(
    via(recorder(200, { provider: 'typesafe', configured: false, masked: null }).call, () => saveDecisionKey(KEY)),
    /invalid/,
  );
  await assert.rejects(
    via(recorder(400, { detail: 'TypeSafe rejected API key' }).call, () => saveDecisionKey(KEY)),
    (error) => error.status === 400 && error.message === 'TypeSafe rejected API key',
  );
});

test('removal must answer an unconfigured state', async () => {
  const removed = recorder(200, { provider: 'typesafe', configured: false, masked: null });
  assert.deepEqual(await via(removed.call, removeDecisionKey), { configured: false, masked: null });
  assert.deepEqual(removed.calls, [{ method: 'decision.remove', params: {} }]);
  await assert.rejects(
    via(recorder(200, { provider: 'typesafe', configured: true, masked: '••••cdef' }).call, removeDecisionKey),
    /invalid/,
  );
});

test('the session remembers the state it last read or saved, and forgets it when the session ends', async () => {
  forgetDecisionProvider();
  assert.equal(knownDecisionProvider(), null);
  await via(recorder(200, { provider: 'typesafe', configured: false, masked: null }).call, loadDecisionProvider);
  assert.deepEqual(knownDecisionProvider(), { configured: false, masked: null });
  await via(recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' }).call, () => saveDecisionKey(KEY));
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });
  await assert.rejects(via(recorder(503, { detail: 'down' }).call, loadDecisionProvider));
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });

  const slow = held();
  const late = via(slow.call, loadDecisionProvider);
  forgetDecisionProvider();
  slow.answer(response(200, { provider: 'typesafe', configured: true, masked: '••••cdef' }));
  assert.deepEqual(await late, { configured: true, masked: '••••cdef' });
  assert.equal(knownDecisionProvider(), null);
});

test('a read that started before a save never overwrites the saved state', async () => {
  forgetDecisionProvider();
  const slow = held();
  const slowRead = via(slow.call, loadDecisionProvider);
  await via(recorder(200, { provider: 'typesafe', configured: true, masked: '••••6789' }).call, () => saveDecisionKey(KEY));
  slow.answer(response(200, { provider: 'typesafe', configured: false, masked: null }));
  assert.deepEqual(await slowRead, { configured: false, masked: null });
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });
});

test('a read that overlaps a save or removal never overwrites what it stored, whichever finishes first', async () => {
  const configured = { provider: 'typesafe', configured: true, masked: '••••6789' };
  const unconfigured = { provider: 'typesafe', configured: false, masked: null };
  for (const [change, stored, replaced] of [
    [() => saveDecisionKey(KEY), configured, unconfigured],
    [() => removeDecisionKey(), unconfigured, configured],
  ]) {
    forgetDecisionProvider();
    const slow = held();
    const pending = via(slow.call, change);
    // A read that starts after the change and answers first, with the state the change replaces.
    await via(recorder(200, replaced).call, loadDecisionProvider);
    slow.answer(response(200, stored));
    await pending;
    assert.deepEqual(knownDecisionProvider(), { configured: stored.configured, masked: stored.masked });
  }
});

test('a read that a change completed under never overwrites what the change stored', async () => {
  forgetDecisionProvider();
  const saving = held();
  const reading = held();
  const save = via(saving.call, () => saveDecisionKey(KEY));
  const read = via(reading.call, loadDecisionProvider);
  saving.answer(response(200, { provider: 'typesafe', configured: true, masked: '••••6789' }));
  await save;
  reading.answer(response(200, { provider: 'typesafe', configured: false, masked: null }));
  await read;
  assert.deepEqual(knownDecisionProvider(), { configured: true, masked: '••••6789' });
});
