import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LocalApiError,
  evaluateHelloPulse,
  listInstalledAssistants,
  safeApiError,
} from '../src/lib/localApi.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('always posts idempotent install before hello without an inventory preflight', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? response(200, { installed: true }) : response(200, { message: 'Hello, Captain!' });
  };

  const result = await evaluateHelloPulse(fetcher, 'capsule_1');

  assert.deepEqual(result, { message: 'Hello, Captain!', installed: true });
  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [
      ['POST', '/api/capsules/capsule_1/assistants', { assistant: 'hello-pulse' }],
      ['POST', '/api/capsules/capsule_1/assistants/hello-pulse/operations/hello', { name: 'Captain' }],
    ],
  );
});

test('a concurrent install conflict still proceeds to the declared hello proof', async () => {
  let call = 0;
  const fetcher = async () => {
    call += 1;
    return call === 1 ? response(409, { detail: 'already installed' }) : response(200, { message: 'Ready.' });
  };

  assert.deepEqual(
    await evaluateHelloPulse(fetcher, 'capsule_1'),
    { message: 'Ready.', installed: false },
  );
  assert.equal(call, 2);
});

test('safe driver errors stop before invoke and prefer error over detail', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response(503, { error: 'runtime recovery failed', detail: 'generic failure' });
  };

  await assert.rejects(
    evaluateHelloPulse(fetcher, 'capsule_1'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'runtime recovery failed',
  );
  assert.equal(calls.length, 1);
  assert.equal(safeApiError({ error: 'specific', detail: 'generic' }, 'fallback'), 'specific');
});

test('loads the controller-owned installed Assistant inventory without weakening its shape', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      assistants: [
        { assistant: 'hello-pulse', status: 'running' },
        { assistant: 'salesnator', status: 'created' },
      ],
    });
  };

  assert.deepEqual(await listInstalledAssistants(fetcher, 'capsule_1'), [
    { assistant: 'hello-pulse', status: 'running' },
    { assistant: 'salesnator', status: 'created' },
  ]);
  assert.deepEqual(calls, [{
    url: '/api/capsules/capsule_1/assistants',
    options: { cache: 'no-store', headers: { Accept: 'application/json' } },
  }]);
});

test('installed inventory errors and malformed records fail honestly instead of looking empty', async () => {
  await assert.rejects(
    listInstalledAssistants(async () => response(503, { detail: 'controller unavailable' }), 'capsule_1'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'controller unavailable',
  );

  for (const assistants of [
    null,
    [{ assistant: '../escape', status: 'running' }],
    [{ assistant: 'hello-pulse', status: 'RUNNING' }],
    [
      { assistant: 'hello-pulse', status: 'running' },
      { assistant: 'hello-pulse', status: 'running' },
    ],
    Array.from({ length: 129 }, (_value, index) => ({
      assistant: `assistant-${index}`,
      status: 'running',
    })),
  ]) {
    await assert.rejects(
      listInstalledAssistants(async () => response(200, { assistants }), 'capsule_1'),
      (error) => error instanceof LocalApiError && error.message === 'The installed Assistant inventory is invalid.',
    );
  }
});
