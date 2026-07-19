import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearTeamContext,
  createTeam,
  deleteTeam,
  loadTeamContext,
  MAX_SELECTED_ASSISTANTS,
  refreshTeamInventory,
  selectAllTeamAssistants,
  selectOnlyTeamAssistant,
  selectTeam,
  teamContext,
  toggleTeamAssistant,
  toggleTeamFile,
  unselectAllTeamAssistants,
} from '../src/lib/teamContext.js';
import { LocalApiError } from '../src/lib/localApi.js';

const FILE_A = 'a'.repeat(32);
const FILE_B = 'b'.repeat(32);
const sidebarSource = readFileSync(
  new URL('../src/lib/TeamSidebar.svelte', import.meta.url),
  'utf8',
);
const contextControlsSource = readFileSync(
  new URL('../src/lib/ChatContextControls.svelte', import.meta.url),
  'utf8',
);

test('refreshes the selected Team inventory after an internal Assistant runtime update', () => {
  assert.match(sidebarSource, /import \{ ASSISTANT_RUNTIME_UPDATED_EVENT \} from '\$lib\/notifications\.js';/);
  assert.match(sidebarSource, /refreshTeamInventory\(fetch\)/);
  assert.match(
    sidebarSource,
    /window\.addEventListener\(ASSISTANT_RUNTIME_UPDATED_EVENT, refreshUpdatedAssistants\);/,
  );
  assert.match(
    sidebarSource,
    /window\.removeEventListener\(ASSISTANT_RUNTIME_UPDATED_EVENT, refreshUpdatedAssistants\);/,
  );
  assert.match(sidebarSource, /if \(runtimeRefresh \|\| !\$teamContext\.selectedTeamId\) return;/);
});

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
    if (url === '/api/teams') {
      return response(200, {
        teams: [
          { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
          { team_id: 'support', team_name: 'Support', status: 'running' },
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
    if (url === '/api/teams/marketing/assistants') {
      return response(200, { assistants: [{ assistant: 'salesnator', status: 'running' }] });
    }
    if (url === '/api/teams/support/assistants') {
      return response(200, { assistants: [{ assistant: 'hello-pulse', status: 'running' }] });
    }
    if (url === '/api/teams/marketing/files') {
      return response(200, { files: [{ id: FILE_A, name: 'brief.pdf', size: 42 }] });
    }
    if (url === '/api/teams/support/files') {
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
    selectedAssistantIds: ['hello-pulse'],
    files: [{ id: FILE_B, name: 'ticket.txt', size: 12 }],
    selectedFileIds: [],
    error: '',
  });
});

test('switching Teams immediately selects the URL authority and clears stale inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  assert.equal(toggleTeamFile(FILE_A), true);
  assert.deepEqual(get(teamContext).selectedFileIds, [FILE_A]);

  let releaseAssistants;
  const assistants = new Promise((resolve) => { releaseAssistants = resolve; });
  const fetcher = fixtureFetcher({
    '/api/teams/support/assistants': async () => assistants,
  });
  const pending = selectTeam(fetcher, 'support');

  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).selectedFileIds, []);
  assert.deepEqual(get(teamContext).installedAssistants, []);
  assert.deepEqual(get(teamContext).files, []);
  releaseAssistants(response(200, { assistants: [{ assistant: 'hello-pulse', status: 'running' }] }));
  await pending;
  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).files, [{ id: FILE_B, name: 'ticket.txt', size: 12 }]);
});

test('a failed Team switch keeps the last verified Team selected', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');

  await assert.rejects(
    selectTeam(fixtureFetcher({
      '/api/teams/support/assistants': async () => response(503, {}),
    }), 'support'),
    (error) => error instanceof LocalApiError,
  );

  assert.equal(get(teamContext).phase, 'error');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  assert.deepEqual(get(teamContext).files, []);
});

test('file selection accepts only current files and enforces the chat limit', async () => {
  const files = Array.from({ length: 9 }, (_value, index) => ({
    id: index.toString(16).repeat(32),
    name: `file-${index}.txt`,
    size: index + 1,
  }));
  await loadTeamContext(fixtureFetcher({
    '/api/teams/marketing/files': async () => response(200, { files }),
  }), 'marketing');

  for (const file of files.slice(0, 8)) assert.equal(toggleTeamFile(file.id), true);
  assert.equal(toggleTeamFile(files[8].id), false);
  assert.equal(toggleTeamFile('f'.repeat(32)), false);
  assert.equal(get(teamContext).selectedFileIds.length, 8);
  assert.equal(toggleTeamFile(files[0].id), true);
  assert.equal(get(teamContext).selectedFileIds.length, 7);
});

test('a confirmed empty inventory is ready while malformed Team data fails closed', async () => {
  let catalogRequests = 0;
  await loadTeamContext(fixtureFetcher({
    '/api/teams': async () => response(200, { teams: [] }),
    '/api/assistants': async () => {
      catalogRequests += 1;
      return response(503, { error: 'catalog unavailable' });
    },
  }));
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
  assert.equal(catalogRequests, 0);

  for (const teams of [
    [{ team_id: '../escape', team_name: 'Unsafe', status: 'running' }],
    [{ id: 'marketing', name: 'Legacy alias', status: 'running' }],
  ]) {
    clearTeamContext();
    await assert.rejects(
      loadTeamContext(fixtureFetcher({
        '/api/teams': async () => response(200, { teams }),
      })),
      (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
    );
  }
  assert.equal(get(teamContext).phase, 'error');
  assert.deepEqual(get(teamContext).teams, []);
  assert.equal(get(teamContext).selectedTeamId, '');
});

test('accepts only the backend trace identifier as optional Team envelope metadata', async () => {
  await loadTeamContext(fixtureFetcher({
    '/api/teams': async () => response(200, {
      teams: [],
      trace_id: 'a'.repeat(32),
    }),
  }));
  assert.equal(get(teamContext).phase, 'ready');

  for (const document of [
    { teams: [], trace_id: '../invalid' },
    { teams: [], debug: true },
  ]) {
    clearTeamContext();
    await assert.rejects(
      loadTeamContext(fixtureFetcher({
        '/api/teams': async () => response(200, document),
      })),
      (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
    );
  }
});

test('refresh clears an invalid installed Assistant instead of presenting it as trusted', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const invalidFetcher = fixtureFetcher({
    '/api/teams/marketing/assistants': async () => response(200, {
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
    '/api/teams': async (options) => {
      calls.push(options);
      if (options.method === 'POST') {
        return response(201, {
          created: true,
          team_id: 'growth',
          team_name: 'Growth',
          status: 'running',
          trace_id: 'b'.repeat(32),
        });
      }
      return response(200, { teams: [{ team_id: 'growth', team_name: 'Growth', status: 'running' }] });
    },
    '/api/teams/growth/assistants': async () => response(200, { assistants: [] }),
    '/api/teams/growth/files': async () => response(200, { files: [] }),
  });

  const created = await createTeam(fetcher, '  Growth  ');

  assert.deepEqual(created, { created: true, id: 'growth', name: 'Growth', status: 'running' });
  assert.deepEqual(calls[0], {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_name: 'Growth' }),
  });
  assert.deepEqual(calls[1], { cache: 'no-store', headers: { Accept: 'application/json' } });
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'growth');
});

test('keeps a confirmed Team creation successful when its follow-up context refresh fails', async () => {
  let postRequests = 0;
  const fetcher = fixtureFetcher({
    '/api/teams': async (options) => {
      if (options.method === 'POST') {
        postRequests += 1;
        return response(201, {
          created: true,
          team_id: 'growth',
          team_name: 'Growth',
          status: 'running',
        });
      }
      return response(200, { teams: [{ team_id: 'growth', team_name: 'Growth', status: 'running' }] });
    },
    '/api/assistants': async () => response(503, {}),
  });

  const created = await createTeam(fetcher, 'Growth');

  assert.deepEqual(created, { created: true, id: 'growth', name: 'Growth', status: 'running' });
  assert.equal(postRequests, 1);
  assert.equal(get(teamContext).phase, 'error');
  assert.equal(
    get(teamContext).error,
    'The local Assistant catalog is unavailable.',
  );
});

test('deletes a Team with exact credentials, clears its stored scope, and selects a remaining Team', async () => {
  const previousStorage = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const calls = [];
  let deleted = false;
  const fetcher = fixtureFetcher({
    '/api/teams': async () => response(200, {
      teams: deleted
        ? [{ team_id: 'support', team_name: 'Support', status: 'running' }]
        : [
            { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
            { team_id: 'support', team_name: 'Support', status: 'running' },
          ],
    }),
    '/api/teams/marketing': async (options) => {
      calls.push(options);
      deleted = true;
      return response(200, {
        team_id: 'marketing',
        destroyed: true,
        assistants_removed: 1,
        storage_removed: false,
        trace_id: 'c'.repeat(32),
      });
    },
  });

  try {
    await loadTeamContext(fetcher, 'marketing');
    const key = 'shimpz.admin.chat.assistants.v1:marketing';
    assert.equal(values.get(key), JSON.stringify(['salesnator']));

    const result = await deleteTeam(fetcher, 'marketing', 'Marketing', 'correct horse battery staple');

    assert.deepEqual(calls, [{
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: 'Marketing', password: 'correct horse battery staple' }),
    }]);
    assert.deepEqual(result, {
      teamId: 'marketing',
      destroyed: true,
      assistantsRemoved: 1,
      storageRemoved: false,
    });
    assert.equal(values.has(key), false);
    assert.equal(get(teamContext).phase, 'ready');
    assert.equal(get(teamContext).selectedTeamId, 'support');
    assert.deepEqual(get(teamContext).teams, [
      { id: 'support', name: 'Support', status: 'running' },
    ]);
  } finally {
    clearTeamContext();
    if (previousStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousStorage;
  }
});

test('Team deletion fails closed on an inexact name or malformed success envelope', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  let requests = 0;
  await assert.rejects(
    deleteTeam(async () => { requests += 1; }, 'marketing', 'marketing', 'secret'),
    (error) => error instanceof LocalApiError && error.message === 'Enter the exact Team name.',
  );
  assert.equal(requests, 0);
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');

  await assert.rejects(
    deleteTeam(fixtureFetcher({
      '/api/teams/marketing': async () => response(200, {
        team_id: 'marketing',
        destroyed: true,
        assistants_removed: 1,
        storage_removed: true,
        redirect: 'https://example.test',
      }),
    }), 'marketing', 'Marketing', 'secret'),
    (error) => error instanceof LocalApiError && error.message === 'The Team deletion returned an invalid response.',
  );
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
});

test('deleting the last Team rehydrates an authoritative empty context', async () => {
  let deleted = false;
  const fetcher = fixtureFetcher({
    '/api/teams': async () => response(200, {
      teams: deleted
        ? []
        : [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    }),
    '/api/teams/marketing': async () => {
      deleted = true;
      return response(200, {
        team_id: 'marketing',
        destroyed: true,
        assistants_removed: 1,
        storage_removed: true,
      });
    },
  });

  await loadTeamContext(fetcher, 'marketing');
  await deleteTeam(fetcher, 'marketing', 'Marketing', 'secret');

  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
});

test('rejects ambiguous Team creation responses without trusting their identity', async () => {
  for (const body of [
    {
      created: true,
      team_id: 'growth',
      team_name: 'Growth',
      status: 'running',
      redirect: 'https://example.test',
    },
    { created: true, team_id: 123, team_name: 'Growth', status: 'running' },
    { created: true, id: 'growth', name: 'Growth', status: 'running' },
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
    '/api/teams': async () => teams,
  }));
  clearTeamContext();
  releaseTeams(response(200, { teams: [] }));
  await pending;
  assert.deepEqual(get(teamContext), {
    phase: 'idle',
    teams: [],
    selectedTeamId: '',
    catalog: [],
    installedAssistants: [],
    selectedAssistantIds: [],
    files: [],
    selectedFileIds: [],
    error: '',
  });
});

test('Assistant selection is Team-scoped, bounded to running inventory, and empty is valid', async () => {
  await loadTeamContext(fixtureFetcher({
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [
        { assistant: 'hello-pulse', status: 'running' },
        { assistant: 'salesnator', status: 'running' },
      ],
    }),
  }), 'marketing');

  assert.deepEqual(get(teamContext).selectedAssistantIds, ['hello-pulse', 'salesnator']);
  assert.equal(unselectAllTeamAssistants(), true);
  assert.deepEqual(get(teamContext).selectedAssistantIds, []);
  assert.equal(toggleTeamAssistant('salesnator'), true);
  assert.deepEqual(get(teamContext).selectedAssistantIds, ['salesnator']);
  assert.equal(selectOnlyTeamAssistant('hello-pulse'), true);
  assert.deepEqual(get(teamContext).selectedAssistantIds, ['hello-pulse']);
  assert.equal(selectAllTeamAssistants(), true);
  assert.deepEqual(get(teamContext).selectedAssistantIds, ['hello-pulse', 'salesnator']);
  assert.equal(toggleTeamAssistant('not-installed'), false);
});

test('Assistant inventory refresh intersects a deliberate selection without enabling new items', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  assert.deepEqual(get(teamContext).selectedAssistantIds, ['salesnator']);
  assert.equal(unselectAllTeamAssistants(), true);

  await refreshTeamInventory(fixtureFetcher({
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [
        { assistant: 'hello-pulse', status: 'running' },
        { assistant: 'salesnator', status: 'running' },
      ],
    }),
  }));
  assert.deepEqual(get(teamContext).selectedAssistantIds, []);
});

test('Assistant scope survives reload in session storage but is reconciled to verified running inventory', async () => {
  const previousStorage = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const key = 'shimpz.admin.chat.assistants.v1:marketing';
  const twoAssistants = fixtureFetcher({
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [
        { assistant: 'hello-pulse', status: 'running' },
        { assistant: 'salesnator', status: 'running' },
      ],
    }),
  });

  try {
    clearTeamContext();
    await loadTeamContext(twoAssistants, 'marketing');
    assert.equal(selectOnlyTeamAssistant('salesnator'), true);
    assert.equal(values.get(key), JSON.stringify(['salesnator']));

    clearTeamContext();
    await loadTeamContext(twoAssistants, 'marketing');
    assert.deepEqual(get(teamContext).selectedAssistantIds, ['salesnator']);

    clearTeamContext();
    await loadTeamContext(fixtureFetcher(), 'marketing');
    assert.deepEqual(get(teamContext).selectedAssistantIds, ['salesnator']);

    values.set(key, JSON.stringify(['not-installed']));
    clearTeamContext();
    await loadTeamContext(fixtureFetcher(), 'marketing');
    assert.deepEqual(get(teamContext).selectedAssistantIds, []);
    assert.equal(values.get(key), '[]');

    values.set(key, JSON.stringify(['../escape']));
    clearTeamContext();
    await loadTeamContext(fixtureFetcher(), 'marketing');
    assert.deepEqual(get(teamContext).selectedAssistantIds, ['salesnator']);
  } finally {
    clearTeamContext();
    if (previousStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousStorage;
  }
});

test('Assistant scope enforces and exposes the exact protocol limit', async () => {
  const catalog = Array.from({ length: MAX_SELECTED_ASSISTANTS + 1 }, (_value, index) => ({
    id: `assistant-${index}`,
    title: `Assistant ${index}`,
  }));
  const installed = catalog.map((entry) => ({ assistant: entry.id, status: 'running' }));
  await loadTeamContext(fixtureFetcher({
    '/api/assistants': async () => response(200, { assistants: catalog }),
    '/api/teams/marketing/assistants': async () => response(200, { assistants: installed }),
  }), 'marketing');

  assert.equal(get(teamContext).selectedAssistantIds.length, MAX_SELECTED_ASSISTANTS);
  assert.equal(toggleTeamAssistant(`assistant-${MAX_SELECTED_ASSISTANTS}`), false);
  assert.equal(unselectAllTeamAssistants(), true);
  assert.equal(selectAllTeamAssistants(), true);
  assert.deepEqual(
    get(teamContext).selectedAssistantIds,
    installed.slice(0, MAX_SELECTED_ASSISTANTS).map((entry) => entry.assistant),
  );
});

test('Team sidebar keeps context authority without rendering a Files area', () => {
  assert.match(sidebarSource, /loadTeamContext\(fetch, requestedTeamId\)/);
  assert.match(sidebarSource, /loadModelContext\(fetch, teamId\)/);
  assert.match(sidebarSource, /selectTeam\(fetch, preferredId\)/);
  assert.match(sidebarSource, /goto\(next, \{ replaceState: true, keepFocus: true, noScroll: true \}\)/);
  assert.doesNotMatch(sidebarSource, /sidebar-files-title|files-section|file-list|toggleTeamFile/);
  assert.doesNotMatch(sidebarSource, /<select|<dialog|AssistantIcon|selectTeamBrain|createTeam/);
  assert.doesNotMatch(sidebarSource, /sidebar-team|sidebar-brain|sidebar-assistants/);
});

test('Team sidebar has no horizontal section dividers at any viewport', () => {
  assert.doesNotMatch(sidebarSource, /border-(?:block-end|bottom|top):/);
});

test('Team sidebar follows client-side team deep links without owning another loader', () => {
  assert.match(sidebarSource, /import \{ goto \} from '\$app\/navigation';/);
  assert.match(sidebarSource, /import \{ page \} from '\$app\/state';/);
  assert.match(
    sidebarSource,
    /let requestedTeamId = \$derived\.by\(\(\) => \{\s*const candidate = page\.url\.searchParams\.get\('team'\) \?\? '';/,
  );
  assert.match(
    sidebarSource,
    /\$effect\(\(\) => \{\s*const preferredId = requestedTeamId;[\s\S]*\$teamContext\.phase === 'ready'[\s\S]*selectTeam\(fetch, preferredId\)\.catch/,
  );
  assert.match(
    sidebarSource,
    /goto\(next, \{ replaceState: true, keepFocus: true, noScroll: true \}\)/,
  );
  assert.match(
    sidebarSource,
    /const previousId = \$teamContext\.selectedTeamId;\s*selectTeam\(fetch, preferredId\)\.catch\(\(\) => \{\s*if \(previousId\) updateLocationTeam\(previousId\)\.catch/,
  );
  assert.match(
    sidebarSource,
    /onMount\(\(\) => \{\s*if \(\$teamContext\.phase === 'idle'\) \{\s*loadTeamContext\(fetch, requestedTeamId\)/,
  );
  assert.doesNotMatch(sidebarSource, /preferredTeamFromLocation|window\.history\.replaceState|replaceState\(next, page\.state\)/);
});

test('Team sidebar keeps only bounded context errors visible outside Chat', () => {
  assert.doesNotMatch(sidebarSource, /type="checkbox"|selectedFileIds/);
  assert.match(sidebarSource, /\{#if \$teamContext\.phase === 'error' && active !== 'chat'\}/);
});

test('composer context uses separate accessible dialogs instead of selects', () => {
  assert.match(contextControlsSource, /<dialog bind:this=\{teamDialog\} aria-labelledby="chat-team-dialog-title"/);
  assert.match(contextControlsSource, /<dialog bind:this=\{brainDialog\} aria-labelledby="chat-brain-dialog-title"/);
  assert.match(contextControlsSource, /<dialog bind:this=\{assistantDialog\} aria-labelledby="chat-assistant-dialog-title"/);
  assert.match(contextControlsSource, /<dialog bind:this=\{createDialog\} aria-labelledby="chat-create-team-title"/);
  assert.match(contextControlsSource, /bind:this=\{deleteDialog\}[\s\S]*aria-labelledby="chat-delete-team-title"[\s\S]*aria-describedby="chat-delete-team-lead"/);
  assert.equal(contextControlsSource.match(/<strong>\{team\.name\}<\/strong>/g)?.length, 1);
  assert.doesNotMatch(contextControlsSource, /<select/);
  assert.match(contextControlsSource, /next\.searchParams\.set\('team', id\)/);
  assert.match(contextControlsSource, /goto\(next, \{ replaceState: true, keepFocus: true, noScroll: true \}\)/);
  assert.match(contextControlsSource, /window\.location\.assign\(`\/assistants\/\?team=\$\{encodeURIComponent\(created\.id\)\}`\)/);
  assert.match(contextControlsSource, /deleteTeam\(fetch, target\.id, deleteName, adminPassword\)/);
  assert.match(contextControlsSource, /deleteName !== deletingTeam\.name \|\| !adminPassword/);
  assert.match(contextControlsSource, /autocomplete="current-password"/);
  assert.match(contextControlsSource, /next\.searchParams\.delete\('team'\)/);
  assert.match(contextControlsSource, /finally \{\s*deleting = false;\s*resetDeleteForm\(\);/);
  assert.doesNotMatch(contextControlsSource, /\bconfirm\s*\(/);
});

test('composer context provides model buttons and complete Assistant scope controls', () => {
  assert.match(contextControlsSource, /selectTeamBrain\(fetch, teamId, brain\.provider, brain\.model\)/);
  assert.match(contextControlsSource, /brain\.provider === \$modelContext\.provider && brain\.model === \$modelContext\.model/);
  assert.doesNotMatch(contextControlsSource, /role="radio(?:group)?"|aria-checked/);
  assert.match(contextControlsSource, /aria-pressed=/);
  assert.match(contextControlsSource, /entry\.status === 'running'/);
  assert.match(contextControlsSource, /type="checkbox"/);
  assert.match(contextControlsSource, /onclick=\{selectAllTeamAssistants\}/);
  assert.match(contextControlsSource, /onclick=\{unselectAllTeamAssistants\}/);
  assert.match(contextControlsSource, /selectOnlyTeamAssistant\(assistant\.id\)/);
  assert.match(contextControlsSource, /aria-label=\{format\(copy\.onlyThisNamed, \{ name: assistant\.name \}\)\}/);
  assert.match(contextControlsSource, /selectMaximum/);
  assert.match(contextControlsSource, /selectedLimited/);
  assert.match(contextControlsSource, /selectedCount >= MAX_SELECTED_ASSISTANTS/);
  assert.match(contextControlsSource, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(contextControlsSource, /overflow-x: auto|grid-auto-flow: column/);
});

test('Assistant context hides empty bulk actions and leaves Store navigation to the shell', () => {
  assert.match(
    contextControlsSource,
    /\{#if runningAssistants\.length > 0\}\s*<div class="bulk-actions">[\s\S]*onclick=\{selectAllTeamAssistants\}[\s\S]*onclick=\{unselectAllTeamAssistants\}/,
  );
  assert.doesNotMatch(contextControlsSource, /openAssistantStore|copy\.addAssistant/);
  assert.match(
    contextControlsSource,
    /onclick=\{\(\) => close\(assistantDialog, assistantTrigger\)\}>\{copy\.close\}<\/button>/,
  );
});

test('composer context localizes every supported Admin locale and removes hard-coded kickers', () => {
  for (const code of ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar']) {
    assert.match(contextControlsSource, new RegExp(`\\b${code}: \\{`));
  }
  assert.equal(contextControlsSource.match(/deleteKicker:/g)?.length, 8);
  assert.equal(contextControlsSource.match(/deleteFailed:/g)?.length, 8);
  assert.match(contextControlsSource, /aria-label=\{copy\.contextAria\}/);
  assert.match(contextControlsSource, /\{copy\.teamKicker\}/);
  assert.match(contextControlsSource, /\{copy\.brainKicker\}/);
  assert.match(contextControlsSource, /\{copy\.assistantKicker\}/);
  assert.match(contextControlsSource, /\{copy\.createKicker\}/);
  assert.match(contextControlsSource, /dialogError = copy\.createFailed/);
  assert.match(contextControlsSource, /\{copy\.modelFailed\}/);
  assert.doesNotMatch(contextControlsSource, />Team \/\/ context<|>Brain \/\/ context<|>Assistants \/\/ context<|>Team \/\/ initialize</);
});
