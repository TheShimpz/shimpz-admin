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
    if (url === '/api/teams') {
      return response(200, {
        teams: [
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
    files: [],
    selectedFileIds: [],
    error: '',
  });
  assert.equal(catalogRequests, 0);

  await assert.rejects(
    loadTeamContext(fixtureFetcher({
      '/api/teams': async () => response(200, {
        teams: [{ id: '../escape', name: 'Unsafe', status: 'running' }],
      }),
    })),
    (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
  );
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
          id: 'growth',
          name: 'Growth',
          status: 'running',
          trace_id: 'b'.repeat(32),
        });
      }
      return response(200, { teams: [{ id: 'growth', name: 'Growth', status: 'running' }] });
    },
    '/api/teams/growth/assistants': async () => response(200, { assistants: [] }),
    '/api/teams/growth/files': async () => response(200, { files: [] }),
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

test('keeps a confirmed Team creation successful when its follow-up context refresh fails', async () => {
  let postRequests = 0;
  const fetcher = fixtureFetcher({
    '/api/teams': async (options) => {
      if (options.method === 'POST') {
        postRequests += 1;
        return response(201, { created: true, id: 'growth', name: 'Growth', status: 'running' });
      }
      return response(200, { teams: [{ id: 'growth', name: 'Growth', status: 'running' }] });
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
  assert.match(
    sidebarSource,
    /<span class="create-team-label">\{copy\.create\}<\/span>\s*<span class="create-team-symbol" aria-hidden="true">＋<\/span>/,
  );
  assert.match(sidebarSource, /\.create-team-label \{\s*grid-column: 2;/);
  assert.match(sidebarSource, /\.create-team-symbol \{\s*grid-column: 3;\s*justify-self: end;/);
  assert.doesNotMatch(sidebarSource, /Local Space/);
});

test('Team sidebar keeps Team creation beside the selector after the first Team exists', () => {
  assert.match(
    sidebarSource,
    /<div class="team-controls">[\s\S]*<select[\s\S]*<button\s+class="create-team-icon"[\s\S]*aria-label=\{copy\.create\}[\s\S]*title=\{copy\.create\}/,
  );
  assert.match(sidebarSource, /grid-template-columns: minmax\(0, 1fr\) 2\.65rem;/);
});

test('Team sidebar hides Assistant and file inventory until a Team is selected', () => {
  assert.match(
    sidebarSource,
    /\{#if \$teamContext\.selectedTeamId\}[\s\S]*aria-labelledby="sidebar-assistants-title"[\s\S]*aria-labelledby="sidebar-files-title"[\s\S]*\{\/if\}\s*<\/div>/,
  );
});

test('Team sidebar owns one combined Brain selection below the Team picker', () => {
  assert.match(sidebarSource, /import \{[\s\S]*modelContext[\s\S]*selectTeamBrain[\s\S]*\} from '\$lib\/modelContext\.js';/);
  const picker = sidebarSource.indexOf('class="team-section team-picker"');
  const brain = sidebarSource.indexOf('id="sidebar-brain-select"');
  const assistants = sidebarSource.indexOf('id="sidebar-assistants-title"');
  assert.ok(picker !== -1 && picker < brain && brain < assistants);
  const brainSection = sidebarSource.slice(sidebarSource.lastIndexOf('<section', brain), assistants);
  assert.equal(brainSection.match(/<select/g)?.length, 1);
  assert.match(brainSection, /<label for="sidebar-brain-select"[^>]*>\{copy\.brain\}<\/label>/);
  assert.match(brainSection, /\{#each brainOptions as brain \(brain\.value\)\}\s*<option value=\{brain\.value\}>\{brain\.title\}<\/option>/);
  assert.match(sidebarSource, /providers\.flatMap\(\(provider\) => provider\.models\.map/);
  assert.match(sidebarSource, /selectTeamBrain\(fetch, teamId, brain\.provider, brain\.model\)/);
  assert.doesNotMatch(sidebarSource, /sidebar-provider-select|sidebar-model-select|modelLabel|input_usd_per_million_cents|output_usd_per_million_cents/);
  assert.doesNotMatch(sidebarSource, /API key required|Chave da API necessária|modelRequired/);
  assert.match(brainSection, /\$modelContext\.phase === 'error' && \$modelContext\.error[\s\S]*role="alert"/);
  assert.match(brainSection, /\{:else if \$modelContext\.ready\}[\s\S]*\{copy\.modelReady\}/);
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
    /function changeTeam\(event\) \{[\s\S]*updateLocationTeam\(id\)\.catch\(\(\) => \{\}\);/,
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

test('Team sidebar keeps Store links canonical and file controls scoped to Chat', () => {
  assert.match(sidebarSource, /assistantStoreHref\(storeLocale, runtime\.assistant\)/);
  assert.match(sidebarSource, /target="_blank"/);
  assert.match(sidebarSource, /rel="noopener noreferrer"/);
  assert.doesNotMatch(sidebarSource, /<i aria-hidden="true">↗<\/i>/);
  assert.match(sidebarSource, /\.assistant-list \{[\s\S]*?margin-inline: -1\.15rem;/);
  assert.match(
    sidebarSource,
    /\.assistant-list a \{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\);[\s\S]*?padding: 0\.65rem 1\.15rem;/,
  );
  assert.match(sidebarSource, /\.assistant-list a:hover,[\s\S]*?background: rgba\(0, 240, 255, 0\.065\);/);
  assert.match(sidebarSource, /\.assistant-list a:active \{\s*background: rgba\(0, 240, 255, 0\.11\);/);
  assert.doesNotMatch(sidebarSource, /\.assistant-list a:hover \{[^}]*border/s);
  assert.match(sidebarSource, /\{#if active === 'chat'\}[\s\S]*?<input[\s\S]*?type="checkbox"/);
});

test('Team creation can navigate only to the fixed local Assistants route', () => {
  assert.match(
    sidebarSource,
    /window\.location\.assign\(`\/assistants\/\?team=\$\{encodeURIComponent\(created\.id\)\}`\)/,
  );
  assert.doesNotMatch(sidebarSource, /window\.location\.assign\([^`]/);
});
