import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAssistantHelp,
  installAssistant,
  LocalApiError,
  listAssistantCatalog,
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

  const result = await installAssistant(fetcher, 'team_1', 'hello-pulse');

  assert.deepEqual(result, { assistant: 'hello-pulse', installed: true });
  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [['POST', '/api/teams/team_1/assistants', { assistant: 'hello-pulse' }]],
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
    await installAssistant(fetcher, 'team_1', 'hello-pulse'),
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
    installAssistant(fetcher, 'team_1', 'hello-pulse'),
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
      }, 'team_1', 'hello-pulse'),
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

  assert.deepEqual(await listInstalledAssistants(fetcher, 'team_1'), [
    { assistant: 'hello-pulse', status: 'running' },
    { assistant: 'salesnator', status: 'created' },
  ]);
  assert.deepEqual(calls, [{
    url: '/api/teams/team_1/assistants',
    options: { cache: 'no-store', headers: { Accept: 'application/json' } },
  }]);
});

test('loads bounded Help lazily for one exact installed Assistant', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return response(200, {
      assistant: 'shimpz-cloudflare',
      markdown: '# Shimpz Cloudflare\n\nTry asking for the weather.',
      trace_id: 'safe-controller-audit-id',
    });
  };

  assert.deepEqual(await getAssistantHelp(fetcher, 'team_1', 'shimpz-cloudflare', 'pt'), {
    assistant: 'shimpz-cloudflare',
    markdown: '# Shimpz Cloudflare\n\nTry asking for the weather.',
  });
  assert.deepEqual(calls, [{
    url: '/api/teams/team_1/assistants/shimpz-cloudflare/help?locale=pt',
    options: { cache: 'no-store', headers: { Accept: 'application/json' } },
  }]);
});

test('rejects malformed, oversized and mismatched Assistant Help responses', async () => {
  const invalid = [
    { assistant: 'other-assistant', markdown: '# Help' },
    { assistant: 'shimpz-cloudflare', markdown: '' },
    { assistant: 'shimpz-cloudflare', markdown: 'bad\u0000help' },
    { assistant: 'shimpz-cloudflare', markdown: 'é'.repeat(16_385) },
  ];
  for (const body of invalid) {
    await assert.rejects(
      getAssistantHelp(async () => response(200, body), 'team_1', 'shimpz-cloudflare'),
      (error) => error instanceof LocalApiError && error.message === 'The installed Assistant Help is invalid.',
    );
  }

  await assert.rejects(
    getAssistantHelp(
      async () => response(404, { detail: 'Assistant is not installed' }),
      'team_1',
      'shimpz-cloudflare',
    ),
    (error) => error instanceof LocalApiError && error.status === 404 && error.message === 'Assistant is not installed',
  );
});

test('rejects Help path injection before making a request', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return response(200, {}); };
  for (const [team, assistant] of [
    ['../team', 'shimpz-cloudflare'],
    ['team_1', '../assistant'],
    ['team_1', 'Shimpz-Assistant'],
  ]) {
    await assert.rejects(
      getAssistantHelp(fetcher, team, assistant),
      (error) => error instanceof LocalApiError && error.message === 'Invalid local Assistant Help request.',
    );
  }
  await assert.rejects(
    getAssistantHelp(fetcher, 'team_1', 'shimpz-cloudflare', '../pt'),
    (error) => error instanceof LocalApiError && error.message === 'Invalid local Assistant Help request.',
  );
  assert.equal(calls, 0);
});

test('projects only bounded display identities from the local Assistant catalog', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, '/api/assistants');
    assert.deepEqual(options, { cache: 'no-store', headers: { Accept: 'application/json' } });
    return response(200, {
      assistants: [
        { id: 'hello-pulse', title: 'Hello Pulse', summary: 'First', powers: ['hello'] },
        { id: 'salesnator', title: 'Salesnator', summary: 'Second', powers: [] },
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
      listInstalledAssistants(async () => response(200, { assistants }), 'team_1'),
      (error) => error instanceof LocalApiError && error.message === 'The installed Assistant inventory is invalid.',
    );
  }
});

test('rejects consecutive and trailing hyphens in installed Assistant ids', async () => {
  for (const assistant of ['hello--pulse', 'hello-pulse-']) {
    await assert.rejects(
      listInstalledAssistants(
        async () => response(200, { assistants: [{ assistant, status: 'running' }] }),
        'team_1',
      ),
      (error) => (
        error instanceof LocalApiError &&
        error.message === 'The installed Assistant inventory is invalid.'
      ),
    );
  }
});
