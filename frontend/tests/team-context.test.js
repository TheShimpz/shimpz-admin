import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import {
  clearTeamContext,
  createTeam,
  deleteTeam,
  loadTeamContext,
  refreshTeamInventory,
  reloadTeamList,
  renameTeam,
  reorderTeams,
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
          { id: 'hello-pulse', title: 'Hello Pulse' },
          { id: 'salesnator', title: 'Salesnator' },
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
      { id: 'hello-pulse', name: 'Hello Pulse' },
      { id: 'salesnator', name: 'Salesnator' },
    ],
    installedAssistants: [installedAssistant('hello-pulse')],
    activeAssistantIds: ['hello-pulse'],
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
      { id: 'hello-pulse', title: 'Hello Pulse' },
      { id: 'salesnator', title: 'Salesnator' },
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
          { id: 'hello-pulse', title: 'Hello Pulse' },
          { id: 'salesnator', title: 'Salesnator' },
        ],
      });
    },
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
    activeAssistantIds: [],
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

test('Team deletion bounds the Supervisor password in code points, not UTF-16 units', async () => {
  // 1,600 astral characters and 1,001 BMP characters: 2,601 code points but 4,201 UTF-16 units.
  const password = '\u{1F512}'.repeat(1600) + 'a'.repeat(1001);
  assert.equal(password.length, 4201);
  let sent = '';
  const fetcher = fixtureFetcher({
    '/api/teams/marketing': async (init) => {
      sent = JSON.parse(init.body).password;
      return response(200, {
        team_id: 'marketing',
        destroyed: true,
        assistants_removed: 1,
        residue_absent: LOCAL_TEAM_RESIDUES,
        storage_removed: true,
      });
    },
  });
  try {
    await loadTeamContext(fetcher, 'marketing');
    await deleteTeam(fetcher, 'marketing', 'Marketing', password);
    assert.equal(sent, password);

    await loadTeamContext(fixtureFetcher(), 'marketing');
    let requests = 0;
    await assert.rejects(
      deleteTeam(async () => { requests += 1; }, 'marketing', 'Marketing', '\u{1F512}'.repeat(4097)),
      (error) => error instanceof LocalApiError && error.message === 'Enter the current Supervisor password.',
    );
    assert.equal(requests, 0);
  } finally {
    clearTeamContext();
  }
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
      { id: 'hello-pulse', name: 'Hello Pulse' },
      { id: 'salesnator', name: 'Salesnator' },
    ],
    installedAssistants: [],
    activeAssistantIds: [],
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

  await refreshTeamInventory(inventory('outdated'));
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator']);
  await refreshTeamInventory(inventory('running'));
  assert.deepEqual(get(teamContext).activeAssistantIds, ['hello-pulse', 'salesnator']);
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

const THREE_TEAMS = [
  { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
  { team_id: 'support', team_name: 'Support', status: 'running' },
  { team_id: 'sales', team_name: 'Sales', status: 'running' },
];

function listedTeams(ids, teams = THREE_TEAMS) {
  return ids.map((id) => teams.find((team) => team.team_id === id));
}

function orderIds() {
  return get(teamContext).teams.map((team) => team.id);
}

// A fetcher whose order saves wait for the test to answer them, so concurrency is deterministic.
function heldOrderFetcher({ list = () => THREE_TEAMS } = {}) {
  const saves = [];
  const base = fixtureFetcher({
    '/api/teams': () => response(200, { teams: list() }),
    '/api/teams/sales/assistants': () => response(200, { assistants: [] }),
  });
  const fetcher = async (url, options = {}) => {
    if (url !== '/api/teams/order') return base(url, options);
    assert.equal(options.method, 'PUT');
    assert.equal(options.cache, 'no-store');
    return new Promise((resolve) => saves.push({ body: JSON.parse(options.body), answer: resolve }));
  };
  return { fetcher, saves };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a reorder moves the list at once, sends the exact permutation, and keeps Admin\'s committed order', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  await loadTeamContext(fetcher, 'support');
  const saving = reorderTeams(fetcher, ['sales', 'marketing', 'support']);
  assert.deepEqual(orderIds(), ['sales', 'marketing', 'support']);
  await settle();
  assert.deepEqual(saves.map((save) => save.body), [{ team_ids: ['sales', 'marketing', 'support'] }]);
  saves[0].answer(response(200, { teams: listedTeams(['sales', 'marketing', 'support']) }));
  await saving;
  assert.deepEqual(orderIds(), ['sales', 'marketing', 'support']);
  assert.equal(get(teamContext).selectedTeamId, 'support');
});

test('moves made during a save are coalesced into one later save, never sent concurrently', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  await loadTeamContext(fetcher);
  const first = reorderTeams(fetcher, ['support', 'marketing', 'sales']);
  await settle();
  const second = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
  const third = reorderTeams(fetcher, ['sales', 'marketing', 'support']);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(saves.length, 1);
  saves[0].answer(response(200, { teams: listedTeams(['support', 'marketing', 'sales']) }));
  await settle();
  // The committed first order never overwrites the newer move on screen while it waits for its own save.
  assert.deepEqual(orderIds(), ['sales', 'marketing', 'support']);
  assert.deepEqual(saves.map((save) => save.body.team_ids), [
    ['support', 'marketing', 'sales'],
    ['sales', 'marketing', 'support'],
  ]);
  saves[1].answer(response(200, { teams: listedTeams(['sales', 'marketing', 'support']) }));
  await third;
  assert.deepEqual(orderIds(), ['sales', 'marketing', 'support']);
});

test('a failed save restores only the order, keeping the selection and a rename made meanwhile', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  const renaming = fixtureFetcher({
    '/api/teams/sales': () => response(200, { team_id: 'sales', team_name: 'Revenue' }),
  });
  await loadTeamContext(fetcher, 'support');
  const saving = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
  await renameTeam(renaming, 'sales', 'Revenue');
  await settle();
  saves[0].answer(response(503, { detail: 'The Team order is unavailable.' }));
  await assert.rejects(saving, (error) => error instanceof LocalApiError && error.status === 503);
  assert.deepEqual(orderIds(), ['marketing', 'support', 'sales']);
  assert.equal(get(teamContext).teams[2].name, 'Revenue');
  assert.equal(get(teamContext).selectedTeamId, 'support');
});

test('a failed save never rolls back over a Team list read after it began', async () => {
  let teams = THREE_TEAMS;
  const { fetcher, saves } = heldOrderFetcher({ list: () => teams });
  await loadTeamContext(fetcher);
  const saving = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
  await settle();
  teams = listedTeams(['support', 'sales', 'marketing']);
  await loadTeamContext(fetcher, 'marketing');
  saves[0].answer(response(500, {}));
  await assert.rejects(saving, /The Team order could not be saved/);
  assert.deepEqual(orderIds(), ['support', 'sales', 'marketing']);
});

test('a stale membership refusal reloads the Team list and keeps the selection', async () => {
  let teams = THREE_TEAMS;
  const { fetcher, saves } = heldOrderFetcher({ list: () => teams });
  await loadTeamContext(fetcher, 'support');
  const saving = reorderTeams(fetcher, ['support', 'marketing', 'sales']);
  await settle();
  const oracle = { team_id: 'oracle', team_name: 'Oracle', status: 'running' };
  teams = [oracle, ...THREE_TEAMS];
  saves[0].answer(response(409, { detail: 'The Teams changed.' }));
  await assert.rejects(saving, (error) => error.status === 409);
  await settle();
  assert.deepEqual(orderIds(), ['oracle', 'marketing', 'support', 'sales']);
  assert.equal(get(teamContext).selectedTeamId, 'support');
});

test('reloading the list after the selected Team is gone reloads the whole context', async () => {
  let teams = THREE_TEAMS;
  const { fetcher } = heldOrderFetcher({ list: () => teams });
  await loadTeamContext(fetcher, 'support');
  teams = listedTeams(['sales', 'marketing']);
  await reloadTeamList(fetcher);
  assert.deepEqual(orderIds(), ['sales', 'marketing']);
  assert.equal(get(teamContext).selectedTeamId, 'sales');
});

test('a reorder that is not an exact permutation of the listed Teams is refused before any request', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  await loadTeamContext(fetcher);
  for (const ids of [
    ['marketing', 'support'],
    ['marketing', 'support', 'support'],
    ['marketing', 'support', 'unknown'],
    ['marketing', 'support', 'sales', 'extra'],
    'marketing',
  ]) {
    await assert.rejects(reorderTeams(fetcher, ids), /Invalid local Team request/);
  }
  assert.throws(() => reorderTeams(null, []), /Invalid local Team request/);
  await settle();
  assert.equal(saves.length, 0);
  assert.deepEqual(orderIds(), ['marketing', 'support', 'sales']);
});

test('an order answer with other Teams or an invalid shape fails closed and restores the order', async () => {
  for (const answer of [
    response(200, { teams: listedTeams(['marketing', 'support']) }),
    response(200, { teams: THREE_TEAMS, extra: true }),
  ]) {
    clearTeamContext();
    const { fetcher, saves } = heldOrderFetcher();
    await loadTeamContext(fetcher);
    const saving = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
    await settle();
    saves[0].answer(answer);
    await assert.rejects(saving, /invalid/);
    assert.deepEqual(orderIds(), ['marketing', 'support', 'sales']);
  }
});

test('a save answered after the context cleared never publishes', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  await loadTeamContext(fetcher);
  const saving = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
  await settle();
  clearTeamContext();
  saves[0].answer(response(503, {}));
  await saving;
  assert.deepEqual(get(teamContext).teams, []);
});

test('a move made after the context cleared and reloaded during a save is still saved, and a failure restores it', async () => {
  const { fetcher, saves } = heldOrderFetcher();
  await loadTeamContext(fetcher);
  const first = reorderTeams(fetcher, ['sales', 'support', 'marketing']);
  await settle();
  clearTeamContext();
  await loadTeamContext(fetcher);
  const second = reorderTeams(fetcher, ['support', 'marketing', 'sales']);
  assert.equal(first, second);
  saves[0].answer(response(200, { teams: listedTeams(['sales', 'support', 'marketing']) }));
  await settle();
  assert.deepEqual(saves.map((save) => save.body.team_ids), [
    ['sales', 'support', 'marketing'],
    ['support', 'marketing', 'sales'],
  ]);
  // The old save never published over the reloaded list; the new move is still on screen.
  assert.deepEqual(orderIds(), ['support', 'marketing', 'sales']);
  saves[1].answer(response(503, {}));
  await assert.rejects(second, /The Team order could not be saved/);
  assert.deepEqual(orderIds(), ['marketing', 'support', 'sales']);
});

// Like heldOrderFetcher, but once `hold()` is called every Team list read also waits for the test to answer it.
function heldListAndOrderFetcher() {
  const lists = [];
  let holding = false;
  const held = heldOrderFetcher();
  const fetcher = async (url, options = {}) => {
    if (holding && url === '/api/teams') return new Promise((resolve) => lists.push({ answer: resolve }));
    return held.fetcher(url, options);
  };
  return { fetcher, saves: held.saves, lists, hold: () => { holding = true; } };
}

const ORACLE = { team_id: 'oracle', team_name: 'Oracle', status: 'running' };

for (const reloadFirst of [false, true]) {
  test(`a list re-read after a 409 never overrides a later saved reorder (${reloadFirst ? 'read' : 'save'} answered first)`, async () => {
    const { fetcher, saves, lists, hold } = heldListAndOrderFetcher();
    await loadTeamContext(fetcher, 'marketing');
    hold();
    // Another tab added Oracle: the save is refused as stale and the list is read again, but that read is slow.
    const refused = reorderTeams(fetcher, ['support', 'marketing', 'sales']);
    await settle();
    saves[0].answer(response(409, { detail: 'The Teams changed.' }));
    await assert.rejects(refused, (error) => error.status === 409);
    await settle();
    assert.equal(lists.length, 1);

    // Oracle is removed again, so the shown three Teams are current, and a new reorder of them is saved.
    const saving = reorderTeams(fetcher, ['sales', 'marketing', 'support']);
    await settle();
    const stale = response(200, { teams: [ORACLE, ...THREE_TEAMS] });
    if (reloadFirst) {
      lists[0].answer(stale);
      await settle();
    }
    saves[1].answer(response(200, { teams: listedTeams(['sales', 'marketing', 'support']) }));
    await saving;
    if (!reloadFirst) {
      lists[0].answer(stale);
      await settle();
    }
    assert.deepEqual(orderIds(), ['sales', 'marketing', 'support']);
    assert.equal(get(teamContext).selectedTeamId, 'marketing');
  });
}
