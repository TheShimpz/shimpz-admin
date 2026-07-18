import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearTeamContext,
  createTeam,
  loadTeamContext,
  refreshTeamInventory,
  selectTeam,
  teamContext,
  toggleTeamFile,
} from '../src/lib/teamContext.js';
import { LocalApiError } from '../src/lib/localApi.js';

const FILE_A = 'a'.repeat(32);
const FILE_B = 'b'.repeat(32);
const sidebarSource = readFileSync(
  new URL('../src/lib/TeamSidebar.svelte', import.meta.url),
  'utf8',
);

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function fixtureFetcher(overrides = {}) {
  return async (url, options = {}) => {
    if (overrides[url]) return overrides[url](options);
    if (url === '/api/capsules') {
      return response(200, {
        capsules: [
          { id: 'marketing', name: 'Marketing', status: 'running' },
          { id: 'support', name: 'Support', status: 'running' },
        ],
      });
    }
    if (url === '/api/assistants') {
      return response(200, {
        assistants: [
          { id: 'hello-pulse', title: 'Hello Pulse' },
          { id: 'salesnator', title: 'Salesnator' },
        ],
      });
    }
    if (url === '/api/capsules/marketing/assistants') {
      return response(200, { assistants: [{ assistant: 'salesnator', status: 'running' }] });
    }
    if (url === '/api/capsules/support/assistants') {
      return response(200, { assistants: [{ assistant: 'hello-pulse', status: 'running' }] });
    }
    if (url === '/api/capsules/marketing/files') {
      return response(200, { files: [{ id: FILE_A, name: 'brief.pdf', size: 42 }] });
    }
    if (url === '/api/capsules/support/files') {
      return response(200, { files: [{ id: FILE_B, name: 'ticket.txt', size: 12 }] });
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  };
}

test.beforeEach(() => clearTeamContext());

test('loads one authoritative Team context and honors a valid preferred Team', async () => {
  const result = await loadTeamContext(fixtureFetcher(), 'support');

  assert.equal(result.selectedTeamId, 'support');
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [
      { id: 'marketing', name: 'Marketing', status: 'running' },
      { id: 'support', name: 'Support', status: 'running' },
    ],
    selectedTeamId: 'support',
    catalog: [
      { id: 'hello-pulse', name: 'Hello Pulse' },
      { id: 'salesnator', name: 'Salesnator' },
    ],
    installedAssistants: [{ assistant: 'hello-pulse', status: 'running' }],
    files: [{ id: FILE_B, name: 'ticket.txt', size: 12 }],
    selectedFileIds: [],
    error: '',
  });
});

test('switching Teams clears file authority before loading the selected inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  assert.equal(toggleTeamFile(FILE_A), true);
  assert.deepEqual(get(teamContext).selectedFileIds, [FILE_A]);

  let releaseAssistants;
  const assistants = new Promise((resolve) => { releaseAssistants = resolve; });
  const fetcher = fixtureFetcher({
    '/api/capsules/support/assistants': async () => assistants,
  });
  const pending = selectTeam(fetcher, 'support');

  assert.deepEqual(get(teamContext).selectedFileIds, []);
  assert.deepEqual(get(teamContext).files, []);
  releaseAssistants(response(200, { assistants: [{ assistant: 'hello-pulse', status: 'running' }] }));
  await pending;
  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).files, [{ id: FILE_B, name: 'ticket.txt', size: 12 }]);
});

test('file selection accepts only current files and enforces the chat limit', async () => {
  const files = Array.from({ length: 9 }, (_value, index) => ({
    id: index.toString(16).repeat(32),
    name: `file-${index}.txt`,
    size: index + 1,
  }));
  await loadTeamContext(fixtureFetcher({
    '/api/capsules/marketing/files': async () => response(200, { files }),
  }), 'marketing');

  for (const file of files.slice(0, 8)) assert.equal(toggleTeamFile(file.id), true);
  assert.equal(toggleTeamFile(files[8].id), false);
  assert.equal(toggleTeamFile('f'.repeat(32)), false);
  assert.equal(get(teamContext).selectedFileIds.length, 8);
  assert.equal(toggleTeamFile(files[0].id), true);
  assert.equal(get(teamContext).selectedFileIds.length, 7);
});

test('a confirmed empty inventory is ready while malformed Team data fails closed', async () => {
  await loadTeamContext(fixtureFetcher({
    '/api/capsules': async () => response(200, { capsules: [] }),
  }));
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: [
      { id: 'hello-pulse', name: 'Hello Pulse' },
      { id: 'salesnator', name: 'Salesnator' },
    ],
    installedAssistants: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });

  await assert.rejects(
    loadTeamContext(fixtureFetcher({
      '/api/capsules': async () => response(200, {
        capsules: [{ id: '../escape', name: 'Unsafe', status: 'running' }],
      }),
    })),
    (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
  );
  assert.equal(get(teamContext).phase, 'error');
  assert.deepEqual(get(teamContext).teams, []);
  assert.equal(get(teamContext).selectedTeamId, '');
});

test('refresh clears an invalid installed Assistant instead of presenting it as trusted', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const invalidFetcher = fixtureFetcher({
    '/api/capsules/marketing/assistants': async () => response(200, {
      assistants: [{ assistant: 'not-in-catalog', status: 'running' }],
    }),
  });

  await assert.rejects(
    refreshTeamInventory(invalidFetcher),
    (error) => error instanceof LocalApiError && error.message === 'The installed Assistant inventory is invalid.',
  );
  assert.equal(get(teamContext).phase, 'error');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  assert.deepEqual(get(teamContext).files, []);
});

test('creates a Team with the exact payload, validates the response, and refreshes its inventory', async () => {
  const calls = [];
  const fetcher = fixtureFetcher({
    '/api/capsules': async (options) => {
      calls.push(options);
      if (options.method === 'POST') {
        return response(201, { created: true, id: 'growth', name: 'Growth', status: 'running' });
      }
      return response(200, { capsules: [{ id: 'growth', name: 'Growth', status: 'running' }] });
    },
    '/api/capsules/growth/assistants': async () => response(200, { assistants: [] }),
    '/api/capsules/growth/files': async () => response(200, { files: [] }),
  });

  const created = await createTeam(fetcher, '  Growth  ');

  assert.deepEqual(created, { created: true, id: 'growth', name: 'Growth', status: 'running' });
  assert.deepEqual(calls[0], {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Growth' }),
  });
  assert.deepEqual(calls[1], { cache: 'no-store', headers: { Accept: 'application/json' } });
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'growth');
});

test('rejects ambiguous Team creation responses without trusting their identity', async () => {
  for (const body of [
    {
      created: true,
      id: 'growth',
      name: 'Growth',
      status: 'running',
      redirect: 'https://example.test',
    },
    { created: true, id: 123, name: 'Growth', status: 'running' },
  ]) {
    clearTeamContext();
    await assert.rejects(
      createTeam(async () => response(201, body), 'Growth'),
      (error) => error instanceof LocalApiError && error.message === 'The Team creation returned an invalid response.',
    );
    assert.equal(get(teamContext).phase, 'error');
  }
});

test('clear invalidates a late context response', async () => {
  let releaseTeams;
  const teams = new Promise((resolve) => { releaseTeams = resolve; });
  const pending = loadTeamContext(fixtureFetcher({
    '/api/capsules': async () => teams,
  }));
  clearTeamContext();
  releaseTeams(response(200, { capsules: [] }));
  await pending;
  assert.deepEqual(get(teamContext), {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
});

test('Team sidebar reveals creation only after a confirmed empty inventory', () => {
  assert.match(
    sidebarSource,
    /\$teamContext\.phase === 'ready' && \$teamContext\.teams\.length === 0/,
  );
  assert.match(sidebarSource, /createDialog\?\.showModal\(\)/);
  assert.match(sidebarSource, /<dialog[^>]+oncancel=\{cancelCreateDialog\}/);
  assert.match(sidebarSource, /maxlength="80"/);
  assert.doesNotMatch(sidebarSource, /Local Space/);
});

test('Team sidebar keeps Store links canonical and file controls scoped to Chat', () => {
  assert.match(sidebarSource, /assistantStoreHref\(storeLocale, runtime\.assistant\)/);
  assert.match(sidebarSource, /target="_blank"/);
  assert.match(sidebarSource, /rel="noopener noreferrer"/);
  assert.match(sidebarSource, /\{#if active === 'chat'\}[\s\S]*?<input[\s\S]*?type="checkbox"/);
});

test('Team creation can navigate only to the fixed local Assistants route', () => {
  assert.match(
    sidebarSource,
    /window\.location\.assign\(`\/assistants\/\?capsule=\$\{encodeURIComponent\(created\.id\)\}`\)/,
  );
  assert.doesNotMatch(sidebarSource, /window\.location\.assign\([^`]/);
});
