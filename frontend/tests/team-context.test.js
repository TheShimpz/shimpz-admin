import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearTeamContext,
  createTeam,
  deleteTeam,
  loadTeamContext,
  MAX_CHAT_ASSISTANTS,
  refreshTeamInventory,
  renameTeam,
  selectTeam,
  teamContext,
} from '../src/lib/teamContext.js';
import { LocalApiError } from '../src/lib/localApi.js';

const LOCAL_TEAM_RESIDUES = [
  'action_checkpoints',
  'assistant_containers',
  'brain_checkpoints',
  'chat_continuations',
  'egress_policies',
  'inference_configuration',
  'integration_credentials',
  'publication_bindings',
  'runtime_state',
  'team_names',
  'team_networks',
  'team_storage',
];

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function installedAssistant(assistant, status = 'running') {
  return { assistant, assistant_version: '1.2.3', status, provenance: 'published' };
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
          { id: 'hello-pulse', title: 'Hello Pulse', summary: 'Says hello.' },
          { id: 'salesnator', title: 'Salesnator', summary: 'Runs sales work.' },
        ],
      });
    }
    if (url === '/api/teams/marketing/assistants') {
      return response(200, { assistants: [installedAssistant('salesnator')] });
    }
    if (url === '/api/teams/support/assistants') {
      return response(200, { assistants: [installedAssistant('hello-pulse')] });
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
      { id: 'hello-pulse', name: 'Hello Pulse', summary: 'Says hello.' },
      { id: 'salesnator', name: 'Salesnator', summary: 'Runs sales work.' },
    ],
    installedAssistants: [installedAssistant('hello-pulse')],
    activeAssistantIds: ['hello-pulse'],
    omittedAssistantIds: [],
    error: '',
  });
});

test('switching Teams immediately selects the URL authority and clears stale inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');

  let releaseAssistants;
  const assistants = new Promise((resolve) => { releaseAssistants = resolve; });
  const fetcher = fixtureFetcher({
    '/api/teams/support/assistants': async () => assistants,
  });
  const pending = selectTeam(fetcher, 'support');

  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  releaseAssistants(response(200, { assistants: [installedAssistant('hello-pulse')] }));
  await pending;
  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('hello-pulse')]);
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
});

test('Team and Assistant catalogs load in parallel and each context load refreshes the catalog', async () => {
  let releaseTeams;
  let releaseCatalog;
  let teamRequests = 0;
  let catalogRequests = 0;
  const teams = new Promise((resolve) => { releaseTeams = resolve; });
  const catalog = new Promise((resolve) => { releaseCatalog = resolve; });
  const fetcher = fixtureFetcher({
    '/api/teams': async () => {
      teamRequests += 1;
      return teams;
    },
    '/api/assistants': async () => {
      catalogRequests += 1;
      return catalog;
    },
  });

  const pending = loadTeamContext(fetcher, 'marketing');
  assert.equal(teamRequests, 1);
  assert.equal(catalogRequests, 1);
  releaseTeams(response(200, {
    teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
  }));
  releaseCatalog(response(200, {
    assistants: [
      { id: 'hello-pulse', title: 'Hello Pulse', summary: 'Says hello.' },
      { id: 'salesnator', title: 'Salesnator', summary: 'Runs sales work.' },
    ],
  }));
  await pending;

  await loadTeamContext(fixtureFetcher({
    '/api/assistants': async () => {
      catalogRequests += 1;
      return response(200, { assistants: [] });
    },
  }), 'support');
  assert.equal(catalogRequests, 2);
  assert.deepEqual(get(teamContext).catalog, []);
  assert.equal(get(teamContext).selectedTeamId, 'support');
});

test('a confirmed empty inventory retains the catalog while malformed Team data fails closed', async () => {
  let catalogRequests = 0;
  await loadTeamContext(fixtureFetcher({
    '/api/teams': async () => response(200, { teams: [] }),
    '/api/assistants': async () => {
      catalogRequests += 1;
      return response(200, {
        assistants: [
          { id: 'hello-pulse', title: 'Hello Pulse', summary: 'Says hello.' },
          { id: 'salesnator', title: 'Salesnator', summary: 'Runs sales work.' },
        ],
      });
    },
  }));
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: [
      { id: 'hello-pulse', name: 'Hello Pulse', summary: 'Says hello.' },
      { id: 'salesnator', name: 'Salesnator', summary: 'Runs sales work.' },
    ],
    installedAssistants: [],
    activeAssistantIds: [],
    omittedAssistantIds: [],
    error: '',
  });
  assert.equal(catalogRequests, 1);

  for (const teams of [
    [{ team_id: '../escape', team_name: 'Unsafe', status: 'running' }],
    [{ id: 'marketing', name: 'Unsupported alias', status: 'running' }],
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

test('refresh accepts authoritative installed inventory while display metadata catches up', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const refreshed = fixtureFetcher({
    '/api/assistants': async () => response(200, { assistants: [] }),
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [installedAssistant('not-in-catalog')],
    }),
  });

  await refreshTeamInventory(refreshed);

  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).catalog, []);
  assert.deepEqual(get(teamContext).installedAssistants, [
    installedAssistant('not-in-catalog'),
  ]);
});

test('refresh exposes a first install and its newly projected display metadata together', async () => {
  await loadTeamContext(fixtureFetcher({
    '/api/assistants': async () => response(200, { assistants: [] }),
    '/api/teams/marketing/assistants': async () => response(200, { assistants: [] }),
  }), 'marketing');

  await refreshTeamInventory(fixtureFetcher({
    '/api/assistants': async () => response(200, {
      assistants: [{
        id: 'shimpz-cloudflare',
        title: 'Shimpz Cloudflare',
        summary: 'Safely manage Cloudflare DNS records through OAuth.',
      }],
    }),
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [installedAssistant('shimpz-cloudflare')],
    }),
  }));

  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).catalog, [
    {
      id: 'shimpz-cloudflare',
      name: 'Shimpz Cloudflare',
      summary: 'Safely manage Cloudflare DNS records through OAuth.',
    },
  ]);
  assert.deepEqual(get(teamContext).installedAssistants, [
    installedAssistant('shimpz-cloudflare'),
  ]);
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

test('deletes a Team with exact credentials and selects a remaining Team', async () => {
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
        residue_absent: LOCAL_TEAM_RESIDUES,
        storage_removed: false,
        trace_id: 'c'.repeat(32),
      });
    },
  });

  try {
    await loadTeamContext(fetcher, 'marketing');
    const result = await deleteTeam(fetcher, 'marketing', 'Marketing', 'violet otter lantern quartz 92');

    assert.deepEqual(calls, [{
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_name: 'Marketing', password: 'violet otter lantern quartz 92' }),
    }]);
    assert.deepEqual(result, {
      teamId: 'marketing',
      destroyed: true,
      assistantsRemoved: 1,
      residueAbsent: LOCAL_TEAM_RESIDUES,
      storageRemoved: false,
    });
    assert.equal(get(teamContext).phase, 'ready');
    assert.equal(get(teamContext).selectedTeamId, 'support');
    assert.deepEqual(get(teamContext).teams, [
      { id: 'support', name: 'Support', status: 'running' },
    ]);
  } finally {
    clearTeamContext();
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
        residue_absent: LOCAL_TEAM_RESIDUES,
        storage_removed: true,
        redirect: 'https://example.test',
      }),
    }), 'marketing', 'Marketing', 'secret'),
    (error) => error instanceof LocalApiError && error.message === 'The Team deletion returned an invalid response.',
  );
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
});

test('Team deletion rejects missing, ambiguous, or malformed residue proofs', async () => {
  const invalidProofs = [
    undefined,
    [],
    [...LOCAL_TEAM_RESIDUES].reverse(),
    [...LOCAL_TEAM_RESIDUES, 'team_storage'],
    [...LOCAL_TEAM_RESIDUES.slice(0, -1), 'TeamStorage'],
  ];
  for (const residueAbsent of invalidProofs) {
    clearTeamContext();
    await loadTeamContext(fixtureFetcher(), 'marketing');
    const body = {
      team_id: 'marketing',
      destroyed: true,
      assistants_removed: 1,
      storage_removed: true,
    };
    if (residueAbsent !== undefined) body.residue_absent = residueAbsent;
    await assert.rejects(
      deleteTeam(fixtureFetcher({
        '/api/teams/marketing': async () => response(200, body),
      }), 'marketing', 'Marketing', 'secret'),
      (error) => (
        error instanceof LocalApiError &&
        error.message === 'The Team deletion returned an invalid response.'
      ),
    );
    assert.equal(get(teamContext).phase, 'ready');
    assert.equal(get(teamContext).selectedTeamId, 'marketing');
  }
});

test('Team deletion preserves the bounded API reason and status for safe diagnostics', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');

  await assert.rejects(
    deleteTeam(fixtureFetcher({
      '/api/teams/marketing': async () => response(403, { detail: 'Supervisor password is incorrect' }),
    }), 'marketing', 'Marketing', 'wrong password'),
    (error) => (
      error instanceof LocalApiError &&
      error.status === 403 &&
      error.message === 'Supervisor password is incorrect'
    ),
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
        residue_absent: LOCAL_TEAM_RESIDUES,
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
    catalog: [
      { id: 'hello-pulse', name: 'Hello Pulse', summary: 'Says hello.' },
      { id: 'salesnator', name: 'Salesnator', summary: 'Runs sales work.' },
    ],
    installedAssistants: [],
    activeAssistantIds: [],
    omittedAssistantIds: [],
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
    activeAssistantIds: [],
    omittedAssistantIds: [],
    error: '',
  });
});

test('every running Assistant joins the chat scope and stopped ones stay out', async () => {
  const inventory = (status) => fixtureFetcher({
    '/api/teams/marketing/assistants': async () => response(200, {
      assistants: [
        installedAssistant('hello-pulse', status),
        installedAssistant('salesnator'),
      ],
    }),
  });
  await loadTeamContext(inventory('running'), 'marketing');
  assert.deepEqual(get(teamContext).activeAssistantIds, ['hello-pulse', 'salesnator']);
  assert.deepEqual(get(teamContext).omittedAssistantIds, []);

  await refreshTeamInventory(inventory('outdated'));
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator']);
  await refreshTeamInventory(inventory('running'));
  assert.deepEqual(get(teamContext).activeAssistantIds, ['hello-pulse', 'salesnator']);
});

test('Assistant scope keeps the exact protocol limit and reports every omitted Assistant', async () => {
  const catalog = Array.from({ length: MAX_CHAT_ASSISTANTS + 2 }, (_value, index) => ({
    id: `assistant-${index}`,
    title: `Assistant ${index}`,
    summary: `Runs reviewed work ${index}.`,
  }));
  const installed = catalog.map((entry) => installedAssistant(entry.id));
  await loadTeamContext(fixtureFetcher({
    '/api/assistants': async () => response(200, { assistants: catalog }),
    '/api/teams/marketing/assistants': async () => response(200, { assistants: installed }),
  }), 'marketing');

  const ids = installed.map((entry) => entry.assistant);
  assert.deepEqual(get(teamContext).activeAssistantIds, ids.slice(0, MAX_CHAT_ASSISTANTS));
  assert.deepEqual(get(teamContext).omittedAssistantIds, ids.slice(MAX_CHAT_ASSISTANTS));
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a Team rename is sent by id and applied to the current context, and bad input or answers fail closed', async () => {
  clearTeamContext();
  const patches = [];
  const fetcher = fixtureFetcher({
    '/api/teams/marketing': async (options) => {
      patches.push(JSON.parse(options.body));
      return response(200, { team_id: 'marketing', team_name: 'Growth' });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  await assert.rejects(renameTeam(fetcher, 'marketing', '   '), /valid Team name/);
  assert.equal((await renameTeam(fetcher, 'marketing', 'Marketing')).name, 'Marketing');
  assert.deepEqual(patches, []);
  await renameTeam(fetcher, 'marketing', ' Growth ');
  assert.deepEqual(patches, [{ team_name: 'Growth' }]);
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Growth');
  await assert.rejects(renameTeam(fetcher, 'unknown', 'Other'), /Invalid local Team request/);

  const refused = fixtureFetcher({ '/api/teams/marketing': async () => response(409, { detail: 'Another Team already has this name.' }) });
  await assert.rejects(renameTeam(refused, 'marketing', 'Support'), /Another Team already has this name/);
  const forged = fixtureFetcher({ '/api/teams/marketing': async () => response(200, { team_id: 'marketing', team_name: 'Other' }) });
  await assert.rejects(renameTeam(forged, 'marketing', 'Sales'), /invalid response/);
});

test('a rename confirmed while a selection or a Team list read is pending keeps its new name', async () => {
  clearTeamContext();
  const inventory = deferred();
  const listRead = deferred();
  let holdInventory = false;
  let holdList = false;
  const base = fixtureFetcher({
    '/api/teams/marketing': async () => response(200, { team_id: 'marketing', team_name: 'Growth' }),
  });
  const fetcher = async (url, options = {}) => {
    if (holdInventory && url === '/api/teams/support/assistants') await inventory.promise;
    if (url === '/api/teams' && options.method === 'POST') {
      return response(200, { created: true, status: 'running', team_id: 'research', team_name: 'Research' });
    }
    if (holdList && url === '/api/teams') {
      const answer = await base(url, options);
      await listRead.promise;
      return answer;
    }
    return base(url, options);
  };
  await loadTeamContext(fetcher, 'marketing');

  holdInventory = true;
  const selection = selectTeam(fetcher, 'support');
  // A selection is loading; the rename still reaches Team and its confirmed name survives the selection's answer.
  teamContext.update((state) => ({ ...state, phase: 'ready' }));
  await renameTeam(fetcher, 'marketing', 'Growth');
  inventory.resolve();
  await selection;
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Growth');

  holdInventory = false;
  // A rename is pending when a Team is created; the creation's list read and then its inventory load complete around
  // the rename's confirmation, and the confirmed name must survive both.
  const patch = deferred();
  const researchInventory = deferred();
  const inventoryRequested = deferred();
  const racing = async (url, options = {}) => {
    if (url === '/api/teams/marketing' && options.method === 'PATCH') {
      await patch.promise;
      return response(200, { team_id: 'marketing', team_name: 'Growth 2' });
    }
    if (url === '/api/teams/research/assistants') {
      inventoryRequested.resolve();
      await researchInventory.promise;
      return response(200, { assistants: [] });
    }
    if (url === '/api/teams' && options.method !== 'POST') {
      await listRead.promise;
      return response(200, {
        teams: [
          { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
          { team_id: 'research', team_name: 'Research', status: 'running' },
        ],
      });
    }
    return fetcher(url, options);
  };
  const renaming = renameTeam(racing, 'marketing', 'Growth 2');
  const creating = createTeam(racing, 'Research');
  listRead.resolve();
  await inventoryRequested.promise;
  patch.resolve();
  await renaming;
  researchInventory.resolve();
  await creating;
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'research');
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Growth 2');
});

test('Team names are sent and compared in NFC, as Team admits them', async () => {
  clearTeamContext();
  const posted = [];
  const fetcher = fixtureFetcher({
    '/api/teams': async (options) => {
      if (options.method !== 'POST') return response(200, { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] });
      posted.push(JSON.parse(options.body));
      return response(200, { created: true, status: 'running', team_id: 'cafe', team_name: 'Café' });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  const created = await createTeam(fetcher, ' Café ');
  assert.deepEqual(posted, [{ team_name: 'Café' }]);
  assert.equal(created.name, 'Café');
});

test('Team names are bounded by Unicode code points, as Team counts them', async () => {
  for (const character of ['界', '😀']) {
    clearTeamContext();
    const longest = character.repeat(80);
    const patches = [];
    const fetcher = fixtureFetcher({
      '/api/teams': async () => response(200, {
        teams: [{ team_id: 'marketing', team_name: longest, status: 'running' }],
      }),
      '/api/teams/marketing': async (options) => {
        patches.push(JSON.parse(options.body));
        return response(200, { team_id: 'marketing', team_name: JSON.parse(options.body).team_name });
      },
    });
    await loadTeamContext(fetcher, 'marketing');
    assert.equal(get(teamContext).phase, 'ready');
    assert.equal(get(teamContext).teams[0].name, longest);

    const renamed = `${character.repeat(79)}X`;
    assert.equal((await renameTeam(fetcher, 'marketing', renamed)).name, renamed);
    await assert.rejects(renameTeam(fetcher, 'marketing', character.repeat(81)), /valid Team name/);
    assert.deepEqual(patches, [{ team_name: renamed }]);

    clearTeamContext();
    await assert.rejects(
      loadTeamContext(fixtureFetcher({
        '/api/teams': async () => response(200, {
          teams: [{ team_id: 'marketing', team_name: character.repeat(81), status: 'running' }],
        }),
      }), 'marketing'),
      (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
    );
  }
});

test('a rename answered after the context cleared never publishes over the next context', async () => {
  clearTeamContext();
  const patch = deferred();
  const fetcher = fixtureFetcher({
    '/api/teams/marketing': async () => {
      await patch.promise;
      return response(200, { team_id: 'marketing', team_name: 'Growth' });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  const renaming = renameTeam(fetcher, 'marketing', 'Growth');
  clearTeamContext();
  await loadTeamContext(fetcher, 'marketing');
  patch.resolve();
  await renaming;
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Marketing');

  // A later list read in the new context is not overlaid with the stale rename either.
  await createTeam(fixtureFetcher({
    '/api/teams': async (options) => (options.method === 'POST'
      ? response(200, { created: true, status: 'running', team_id: 'research', team_name: 'Research' })
      : response(200, {
        teams: [
          { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
          { team_id: 'research', team_name: 'Research', status: 'running' },
        ],
      })),
    '/api/teams/research/assistants': async () => response(200, { assistants: [] }),
  }), 'Research');
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Marketing');
});
