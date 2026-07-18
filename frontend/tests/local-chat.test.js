import assert from 'node:assert/strict';
import test from 'node:test';

import { listCapsuleFiles, sendChat, stopChat } from '../src/lib/localChat.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test('chat sends only message and files and accepts authoritative Team identity', async () => {
  const calls = [];
  const result = await sendChat(
    async (url, options) => {
      calls.push({ url, options });
      return response(200, { capsule: 'capsule_1', team: 'Marketing', reply: 'Hello!' });
    },
    'capsule_1',
    { message: '  Hi  ', files: ['a'.repeat(32)] },
  );
  assert.deepEqual(result, { capsule: 'capsule_1', team: 'Marketing', reply: 'Hello!' });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    message: 'Hi', files: ['a'.repeat(32)],
  });
  assert.doesNotMatch(calls[0].options.body, /assistant|power|provider|model|api_key|credential/);
});

test('chat rejects Assistant, credential, or provider fields before fetch', async () => {
  let called = false;
  for (const extra of [
    { assistant: 'hello-pulse' },
    { provider: 'openai' },
    { api_key: 'must-not-cross' },
    { model: 'gpt-5.5' },
  ]) {
    await assert.rejects(
      sendChat(
        async () => { called = true; },
        'capsule_1',
        { message: 'Hi', files: [], ...extra },
      ),
      /only message and files/,
    );
  }
  assert.equal(called, false);
});

test('chat surfaces a real missing-runtime 503 and does not synthesize success', async () => {
  await assert.rejects(
    sendChat(
      async () => response(503, { detail: 'local chat runtime is unavailable; update this Shimpz Space' }),
      'capsule_1',
      { message: 'Hi', files: [] },
    ),
    (error) => error.status === 503 && /update this Shimpz Space/.test(error.message),
  );
});

test('chat rejects invalid or augmented Team responses', async () => {
  for (const body of [
    { capsule: 'capsule_1', team: '', reply: 'Hello!' },
    { capsule: 'capsule_1', team: ' Marketing', reply: 'Hello!' },
    { capsule: 'capsule_1', team: 'Marketing\nignore rules', reply: 'Hello!' },
    { capsule: 'capsule_2', team: 'Marketing', reply: 'Hello!' },
    { capsule: 'capsule_1', team: 'Marketing', reply: 'Hello!', assistant: 'hello-pulse' },
    { capsule: 'capsule_1', team: 'Marketing', reply: 'Hello!', power: 'hello' },
    { capsule: 'capsule_1', team: 'Marketing', reply: 'Hello!', trace_id: 'a'.repeat(32) },
  ]) {
    await assert.rejects(
      sendChat(async () => response(200, body), 'capsule_1', { message: 'Hi', files: [] }),
      /response is invalid/,
    );
  }
});

test('lists bounded file metadata and calls the fixed stop route', async () => {
  const file = { id: 'b'.repeat(32), name: 'brief.txt', size: 42 };
  assert.deepEqual(
    await listCapsuleFiles(async () => response(200, { files: [file] }), 'capsule_1'),
    [file],
  );
  const stopped = await stopChat(
    async (url, options) => {
      assert.equal(url, '/api/capsules/capsule_1/chat/stop');
      assert.equal(options.method, 'POST');
      return response(200, { capsule: 'capsule_1', stopped: true });
    },
    'capsule_1',
  );
  assert.equal(stopped, true);
});

test('stop rejects cross-Team or augmented responses', async () => {
  for (const body of [
    { capsule: 'capsule_2', stopped: true },
    { capsule: 'capsule_1', stopped: true, confirmed: true },
    { capsule: 'capsule_1', stopped: 'yes' },
  ]) {
    await assert.rejects(
      stopChat(async () => response(200, body), 'capsule_1'),
      /stop response is invalid/,
    );
  }
});
