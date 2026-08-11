import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installAssistant,
  LocalApiError,
  listAssistantCatalog,
  listInstalledAssistants,
  safeApiError,
} from '../src/lib/localApi.js';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('install is passive and never invokes an Assistant Action', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, { assistant: 'hello-pulse', installed: true });
  };

  const result = await installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST);

  assert.deepEqual(result, { assistant: 'hello-pulse', installed: true });
  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [[
      'POST',
      '/api/teams/team_1/assistants',
      { assistant_id: 'hello-pulse', source_digest: SOURCE_DIGEST },
    ]],
  );
  assert.equal(calls.some(({ url }) => url.includes('/actions/')), false);
});

test('idempotent install reports an existing Assistant without executing it', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return response(200, { assistant: 'hello-pulse', installed: false });
  };

  assert.deepEqual(
    await installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST),
    { assistant: 'hello-pulse', installed: false },
  );
  assert.equal(calls, 1);
});

test('safe install errors stop after one request and prefer error over detail', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return response(503, { error: 'runtime recovery failed', detail: 'generic failure' });
  };

  await assert.rejects(
    installAssistant(fetcher, 'team_1', 'hello-pulse', SOURCE_DIGEST),
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
      }, 'team_1', 'hello-pulse', SOURCE_DIGEST),
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
        { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running' },
        { assistant: 'salesnator', assistant_version: '2.0.0', status: 'created' },
        { assistant: 'retired-assistant', assistant_version: '0.1.0', status: 'invalid' },
      ],
    });
  };

  assert.deepEqual(await listInstalledAssistants(fetcher, 'team_1'), [
    { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running' },
    { assistant: 'salesnator', assistant_version: '2.0.0', status: 'created' },
    { assistant: 'retired-assistant', assistant_version: '0.1.0', status: 'invalid' },
  ]);
  assert.deepEqual(calls, [{
    url: '/api/teams/team_1/assistants',
    options: { cache: 'no-store', headers: { Accept: 'application/json' } },
  }]);
});

test('projects only bounded display identities from the local Assistant catalog', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, '/api/assistants');
    assert.deepEqual(options, { cache: 'no-store', headers: { Accept: 'application/json' } });
    return response(200, {
      assistants: [
        { id: 'hello-pulse', title: 'Hello Pulse', summary: 'First', actions: ['hello'] },
        { id: 'salesnator', title: 'Salesnator', summary: 'Second', actions: [] },
      ],
    });
  };

  assert.deepEqual(await listAssistantCatalog(fetcher), [
    { id: 'hello-pulse', name: 'Hello Pulse' },
    { id: 'salesnator', name: 'Salesnator' },
  ]);
});

test('rejects malformed or ambiguous Assistant catalog identities', async () => {
  for (const assistants of [
    null,
    [{ id: '../escape', title: 'Escape' }],
    [{ id: 'hello-pulse', title: ' Hello Pulse' }],
    [{ id: 'hello-pulse', title: 'Hello\nPulse' }],
    [{ id: 'hello-pulse', title: 'Hello Pulse' }, { id: 'hello-pulse', title: 'Duplicate' }],
  ]) {
    await assert.rejects(
      listAssistantCatalog(async () => response(200, { assistants })),
      (error) => error instanceof LocalApiError && error.message === 'The local Assistant catalog is invalid.',
    );
  }
});

test('installed inventory errors and malformed records fail honestly instead of looking empty', async () => {
  await assert.rejects(
    listInstalledAssistants(async () => response(503, { detail: 'controller unavailable' }), 'team_1'),
    (error) => error instanceof LocalApiError && error.status === 503 && error.message === 'controller unavailable',
  );

  for (const assistants of [
    null,
    [{ assistant: '../escape', assistant_version: '1.2.3', status: 'running' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'RUNNING' }],
    [{ assistant: 'hello-pulse', status: 'running' }],
    [{ assistant: 'hello-pulse', assistant_version: '01.2.3', status: 'running' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3-beta', status: 'running' }],
    [{ assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running', debug: true }],
    [
      { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running' },
      { assistant: 'hello-pulse', assistant_version: '1.2.3', status: 'running' },
    ],
    Array.from({ length: 129 }, (_value, index) => ({
      assistant: `assistant-${index}`,
      assistant_version: '1.2.3',
      status: 'running',
    })),
  ]) {
    await assert.rejects(
      listInstalledAssistants(async () => response(200, { assistants }), 'team_1'),
      (error) => error instanceof LocalApiError && error.message === 'The installed Assistant inventory is invalid.',
    );
  }
});

test('rejects consecutive and trailing hyphens in installed Assistant ids', async () => {
  for (const assistant of ['hello--pulse', 'hello-pulse-']) {
    await assert.rejects(
      listInstalledAssistants(
        async () => response(200, {
          assistants: [{ assistant, assistant_version: '1.2.3', status: 'running' }],
        }),
        'team_1',
      ),
      (error) => (
        error instanceof LocalApiError &&
        error.message === 'The installed Assistant inventory is invalid.'
      ),
    );
  }
});
