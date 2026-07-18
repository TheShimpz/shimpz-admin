import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installAssistant,
  invokeHelloPulse,
  LocalApiError,
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

test('install is passive and never invokes an Assistant Power', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, { assistant: 'hello-pulse', installed: true });
  };

  const result = await installAssistant(fetcher, 'capsule_1', 'hello-pulse');

  assert.deepEqual(result, { assistant: 'hello-pulse', installed: true });
  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [['POST', '/api/capsules/capsule_1/assistants', { assistant: 'hello-pulse' }]],
  );
  assert.equal(calls.some(({ url }) => url.includes('/powers/')), false);
});

test('idempotent install reports an existing Assistant without executing it', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return response(200, { assistant: 'hello-pulse', installed: false });
  };

  assert.deepEqual(
    await installAssistant(fetcher, 'capsule_1', 'hello-pulse'),
    { assistant: 'hello-pulse', installed: false },
  );
  assert.equal(calls, 1);
});

test('manual hello invocation is a separate explicit request', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, { message: 'Hello, Captain!' });
  };

  assert.deepEqual(await invokeHelloPulse(fetcher, 'capsule_1'), { message: 'Hello, Captain!' });
  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [['POST', '/api/capsules/capsule_1/assistants/hello-pulse/powers/hello', { name: 'Captain' }]],
  );
});

test('safe install errors stop after one request and prefer error over detail', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response(503, { error: 'runtime recovery failed', detail: 'generic failure' });
  };

  await assert.rejects(
    installAssistant(fetcher, 'capsule_1', 'hello-pulse'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'runtime recovery failed',
  );
  assert.equal(calls.length, 1);
  assert.equal(safeApiError({ error: 'specific', detail: 'generic' }, 'fallback'), 'specific');
});

test('invalid install responses fail closed without invoking anything else', async () => {
  for (const body of [
    { assistant: 'other', installed: true },
    { assistant: 'hello-pulse', installed: 'yes' },
  ]) {
    let calls = 0;
    await assert.rejects(
      installAssistant(async () => {
        calls += 1;
        return response(200, body);
      }, 'capsule_1', 'hello-pulse'),
      (error) => error instanceof LocalApiError && error.message.includes('invalid response'),
    );
    assert.equal(calls, 1);
  }
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

test('rejects consecutive and trailing hyphens in installed Assistant ids', async () => {
  for (const assistant of ['hello--pulse', 'hello-pulse-']) {
    await assert.rejects(
      listInstalledAssistants(
        async () => response(200, { assistants: [{ assistant, status: 'running' }] }),
        'capsule_1',
      ),
      (error) => (
        error instanceof LocalApiError &&
        error.message === 'The installed Assistant inventory is invalid.'
      ),
    );
  }
});
