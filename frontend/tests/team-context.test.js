import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import * as context from '../src/lib/teamContext.js';
import { socketReads } from '../src/lib/adminSocket.js';
import { LocalApiError } from '../src/lib/localApi.js';

const { clearTeamContext, teamContext } = context;

// The Team context reads and changes Teams over the session socket (ADR-0114). Each test's fixture states a whole
// Space as one function of an operation's key and its params: the method, followed for one Team's operation by that
// Team (`teams.list`, `teams.create`, `teams.rename marketing`, `teams.delete marketing`, `teams.reorder`,
// `assistants.registry`, `assistants.list marketing`).
let fixture = null;
socketReads.call = async (method, params) => fixture(params.team_id ? `${method} ${params.team_id}` : method, params);
function using(operation) {
  return (fetcher, ...args) => {
    fixture = fetcher;
    return operation(...args);
  };
}
const createTeam = using(context.createTeam);
const deleteTeam = using(context.deleteTeam);
const loadTeamContext = using(context.loadTeamContext);
const refreshTeamInventory = using(context.refreshTeamInventory);
const reloadTeamList = using(context.reloadTeamList);
const renameTeam = using(context.renameTeam);
const teamListChanged = using(context.teamListChanged);
const reorderTeams = using(context.reorderTeams);
const requestInventoryRefresh = using(context.requestInventoryRefresh);
const selectTeam = using(context.selectTeam);

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
  return async (key, params = {}) => {
    if (overrides[key]) return overrides[key](params);
    if (key === 'teams.list') {
      return response(200, {
        teams: [
          { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
          { team_id: 'support', team_name: 'Support', status: 'running' },
        ],
      });
    }
    if (key === 'assistants.registry') {
      return response(200, {
        assistants: [
          { id: 'hello-pulse', title: 'Hello Pulse' },
          { id: 'salesnator', title: 'Salesnator' },
        ],
      });
    }
    if (key === 'assistants.list marketing') {
      return response(200, { assistants: [installedAssistant('salesnator')] });
    }
    if (key === 'assistants.list support') {
      return response(200, { assistants: [installedAssistant('hello-pulse')] });
    }
    throw new Error(`Unexpected request: ${key}`);
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
    inventory: 'ready',
    error: '',
  });
});

test('switching Teams immediately selects the URL authority and clears stale inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');

  let releaseAssistants;
  const assistants = new Promise((resolve) => { releaseAssistants = resolve; });
  const fetcher = fixtureFetcher({
    'assistants.list support': async () => assistants,
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
      'assistants.list support': async () => response(503, {}),
    }), 'support'),
    (error) => error instanceof LocalApiError,
  );

  assert.equal(get(teamContext).phase, 'error');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.deepEqual(get(teamContext).installedAssistants, []);
});

test('a Team switch keeps the Space catalog it read, and reads it again only for an Assistant it does not name', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const catalog = get(teamContext).catalog;
  let catalogRequests = 0;
  await selectTeam(fixtureFetcher({
    'assistants.registry': async () => {
      catalogRequests += 1;
      return response(503, {});
    },
  }), 'support');
  assert.equal(catalogRequests, 0);
  assert.equal(get(teamContext).catalog, catalog);
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('hello-pulse')]);

  await selectTeam(fixtureFetcher({
    'assistants.list marketing': async () => response(200, {
      assistants: [installedAssistant('salesnator'), installedAssistant('newcomer')],
    }),
    'assistants.registry': async () => {
      catalogRequests += 1;
      return response(200, {
        assistants: [
          { id: 'hello-pulse', title: 'Hello Pulse' },
          { id: 'newcomer', title: 'Newcomer' },
          { id: 'salesnator', title: 'Salesnator' },
        ],
      });
    },
  }), 'marketing');
  assert.equal(catalogRequests, 1);
  assert.deepEqual(get(teamContext).catalog.map((assistant) => assistant.name), ['Hello Pulse', 'Newcomer', 'Salesnator']);
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator', 'newcomer']);
});

test('Team and Assistant catalogs load in parallel and each context load refreshes the catalog', async () => {
  let releaseTeams;
  let releaseCatalog;
  let teamRequests = 0;
  let catalogRequests = 0;
  const teams = new Promise((resolve) => { releaseTeams = resolve; });
  const catalog = new Promise((resolve) => { releaseCatalog = resolve; });
  const fetcher = fixtureFetcher({
    'teams.list': async () => {
      teamRequests += 1;
      return teams;
    },
    'assistants.registry': async () => {
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
    'assistants.registry': async () => {
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
    'teams.list': async () => response(200, { teams: [] }),
    'assistants.registry': async () => {
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
    inventory: 'ready',
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
        'teams.list': async () => response(200, { teams }),
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
    'teams.list': async () => response(200, {
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
        'teams.list': async () => response(200, document),
      })),
      (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
    );
  }
});

test('refresh accepts authoritative installed inventory while display metadata catches up', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const refreshed = fixtureFetcher({
    'assistants.registry': async () => response(200, { assistants: [] }),
    'assistants.list marketing': async () => response(200, {
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
    'assistants.registry': async () => response(200, { assistants: [] }),
    'assistants.list marketing': async () => response(200, { assistants: [] }),
  }), 'marketing');

  await refreshTeamInventory(fixtureFetcher({
    'assistants.registry': async () => response(200, {
      assistants: [{
        id: 'shimpz-cloudflare',
        title: 'Shimpz Cloudflare',
      }],
    }),
    'assistants.list marketing': async () => response(200, {
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

test('a refresh keeps the last inventory on display, loading, until the fresh one is published', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const refreshing = refreshTeamInventory(fixtureFetcher({
    'assistants.list marketing': async () => held,
  }));

  assert.equal(get(teamContext).phase, 'loading');
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('salesnator')]);
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator']);
  release(response(200, { assistants: [installedAssistant('salesnator'), installedAssistant('hello-pulse')] }));
  await refreshing;
  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator', 'hello-pulse']);
});

for (const operation of ['create', 'delete']) {
  test(`an inventory refresh during a Team ${operation} never drops the Team list it publishes`, async () => {
    await loadTeamContext(fixtureFetcher(), 'marketing');
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const listed = operation === 'create'
      ? [
        { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
        { team_id: 'support', team_name: 'Support', status: 'running' },
        { team_id: 'growth', team_name: 'Growth', status: 'running' },
      ]
      : [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }];
    const fetcher = fixtureFetcher({
      'teams.create': async () => {
        await held;
        return response(201, { created: true, team_id: 'growth', team_name: 'Growth', status: 'running' });
      },
      'teams.list': async () => response(200, { teams: listed }),
      'teams.delete support': async () => {
        await held;
        return response(200, {
          team_id: 'support',
          destroyed: true,
          assistants_removed: 1,
          storage_removed: true,
          residue_absent: LOCAL_TEAM_RESIDUES,
        });
      },
      'assistants.list growth': async () => response(200, { assistants: [] }),
    });
    const changing = operation === 'create'
      ? createTeam(fetcher, 'Growth')
      : deleteTeam(fetcher, 'support', 'Support', 'test-password');
    const refreshing = refreshTeamInventory(fetcher);
    release();
    await Promise.all([changing, refreshing]);

    assert.equal(get(teamContext).phase, 'ready');
    assert.deepEqual(get(teamContext).teams.map((team) => team.id), listed.map((team) => team.team_id));
    assert.equal(get(teamContext).selectedTeamId, operation === 'create' ? 'growth' : 'marketing');
  });
}

test('a refresh waiting on a Team operation when the session ends publishes nothing into the next one', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, { teams: [] }),
    'teams.create': async () => {
      await held;
      return response(201, { created: true, team_id: 'growth', team_name: 'Growth', status: 'running' });
    },
  });
  const creating = createTeam(fetcher, 'Growth');
  const refreshing = refreshTeamInventory(fetcher);
  clearTeamContext();
  release();
  await creating.catch(() => {});
  await assert.rejects(refreshing, (error) => error instanceof LocalApiError);

  // The next session's sidebar still finds an unloaded context and reads its Teams.
  assert.equal(get(teamContext).phase, 'idle');
  assert.deepEqual(get(teamContext).teams, []);

  // Neither does a refresh whose own read answers after the session ended.
  await loadTeamContext(fixtureFetcher(), 'marketing');
  let answer;
  const late = new Promise((resolve) => { answer = resolve; });
  const reading = refreshTeamInventory(fixtureFetcher({ 'assistants.list marketing': async () => late }));
  clearTeamContext();
  answer(response(200, { assistants: [installedAssistant('salesnator')] }));
  await reading;
  assert.equal(get(teamContext).phase, 'idle');
  assert.deepEqual(get(teamContext).teams, []);
});

test('a Team that could not be created leaves the selected Team and its current inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  await assert.rejects(createTeam(fixtureFetcher({
    'teams.create': async () => response(503, { detail: 'unavailable' }),
  }), 'Growth'), (error) => error instanceof LocalApiError);

  assert.equal(get(teamContext).phase, 'error');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.equal(get(teamContext).inventory, 'ready');
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator']);
});

test('creates a Team with the exact payload, validates the response, and refreshes its inventory', async () => {
  const calls = [];
  const fetcher = fixtureFetcher({
    'teams.create': async (params) => {
      calls.push(params);
      return response(201, {
        created: true,
        team_id: 'growth',
        team_name: 'Growth',
        status: 'running',
        trace_id: 'b'.repeat(32),
      });
    },
    'teams.list': async () => response(200, { teams: [{ team_id: 'growth', team_name: 'Growth', status: 'running' }] }),
    'assistants.list growth': async () => response(200, { assistants: [] }),
  });

  const created = await createTeam(fetcher, '  Growth  ');

  assert.deepEqual(created, { created: true, id: 'growth', name: 'Growth', status: 'running' });
  assert.deepEqual(calls, [{ body: { team_name: 'Growth' } }]);
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'growth');
});

test('keeps a confirmed Team creation successful when its follow-up context refresh fails', async () => {
  let postRequests = 0;
  const fetcher = fixtureFetcher({
    'teams.create': async () => {
      postRequests += 1;
      return response(201, { created: true, team_id: 'growth', team_name: 'Growth', status: 'running' });
    },
    'teams.list': async () => response(200, { teams: [{ team_id: 'growth', team_name: 'Growth', status: 'running' }] }),
    'assistants.registry': async () => response(503, {}),
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
    'teams.list': async () => response(200, {
      teams: deleted
        ? [{ team_id: 'support', team_name: 'Support', status: 'running' }]
        : [
            { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
            { team_id: 'support', team_name: 'Support', status: 'running' },
          ],
    }),
    'teams.delete marketing': async (params) => {
      calls.push(params);
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
      team_id: 'marketing',
      body: { team_name: 'Marketing', password: 'violet otter lantern quartz 92' },
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
      'teams.delete marketing': async () => response(200, {
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
        'teams.delete marketing': async () => response(200, body),
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
      'teams.delete marketing': async () => response(403, { detail: 'Supervisor password is incorrect' }),
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
    'teams.delete marketing': async (params) => {
      sent = params.body.password;
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
    'teams.list': async () => response(200, {
      teams: deleted
        ? []
        : [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    }),
    'teams.delete marketing': async () => {
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
    inventory: 'ready',
    error: '',
  });
});

test('a first Team whose creation answer was lost opens once the Team list is read again', async () => {
  let created = false;
  const fetcher = fixtureFetcher({
    'teams.create': async () => {
      // Team created it, and Admin's connection dropped before its answer arrived.
      created = true;
      throw new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown');
    },
    'teams.list': async () => response(200, {
      teams: created ? [{ team_id: 'growth', team_name: 'Growth', status: 'running' }] : [],
    }),
    'assistants.list growth': async () => response(200, { assistants: [] }),
  });
  await loadTeamContext(fetcher, '');
  assert.equal(get(teamContext).teams.length, 0);
  await assert.rejects(createTeam(fetcher, 'Growth'), (error) => error.code === 'outcome-unknown');

  await reloadTeamList(fetcher);
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'growth');
  assert.equal(get(teamContext).inventory, 'ready');
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
    'teams.list': async () => teams,
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
    inventory: 'idle',
    error: '',
  });
});

test('every running Assistant joins the chat scope and stopped ones stay out', async () => {
  const inventory = (status) => fixtureFetcher({
    'assistants.list marketing': async () => response(200, {
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
    'teams.rename marketing': async (params) => {
      patches.push(params.body);
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

  const refused = fixtureFetcher({ 'teams.rename marketing': async () => response(409, { detail: 'Another Team already has this name.' }) });
  await assert.rejects(renameTeam(refused, 'marketing', 'Support'), /Another Team already has this name/);
  const forged = fixtureFetcher({ 'teams.rename marketing': async () => response(200, { team_id: 'marketing', team_name: 'Other' }) });
  await assert.rejects(renameTeam(forged, 'marketing', 'Sales'), /invalid response/);
});

test('a rename confirmed while a selection or a Team list read is pending keeps its new name', async () => {
  clearTeamContext();
  const inventory = deferred();
  const listRead = deferred();
  let holdInventory = false;
  let holdList = false;
  const base = fixtureFetcher({
    'teams.rename marketing': async () => response(200, { team_id: 'marketing', team_name: 'Growth' }),
  });
  const fetcher = async (key, params = {}) => {
    if (holdInventory && key === 'assistants.list support') await inventory.promise;
    if (key === 'teams.create') {
      return response(200, { created: true, status: 'running', team_id: 'research', team_name: 'Research' });
    }
    if (holdList && key === 'teams.list') {
      const answer = await base(key, params);
      await listRead.promise;
      return answer;
    }
    return base(key, params);
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
  const racing = async (key, params = {}) => {
    if (key === 'teams.rename marketing') {
      await patch.promise;
      return response(200, { team_id: 'marketing', team_name: 'Growth 2' });
    }
    if (key === 'assistants.list research') {
      inventoryRequested.resolve();
      await researchInventory.promise;
      return response(200, { assistants: [] });
    }
    if (key === 'teams.list') {
      await listRead.promise;
      return response(200, {
        teams: [
          { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
          { team_id: 'research', team_name: 'Research', status: 'running' },
        ],
      });
    }
    return fetcher(key, params);
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
    'teams.list': async () => response(200, { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
    'teams.create': async (params) => {
      posted.push(params.body);
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
      'teams.list': async () => response(200, {
        teams: [{ team_id: 'marketing', team_name: longest, status: 'running' }],
      }),
      'teams.rename marketing': async (params) => {
        patches.push(params.body);
        return response(200, { team_id: 'marketing', team_name: params.body.team_name });
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
        'teams.list': async () => response(200, {
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
    'teams.rename marketing': async () => {
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
    'teams.create': async () => response(200, { created: true, status: 'running', team_id: 'research', team_name: 'Research' }),
    'teams.list': async () => response(200, {
      teams: [
        { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
        { team_id: 'research', team_name: 'Research', status: 'running' },
      ],
    }),
    'assistants.list research': async () => response(200, { assistants: [] }),
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
    'teams.list': () => response(200, { teams: list() }),
    'assistants.list sales': () => response(200, { assistants: [] }),
  });
  const fetcher = async (key, params = {}) => {
    if (key !== 'teams.reorder') return base(key, params);
    return new Promise((resolve) => saves.push({ body: params.body, answer: resolve }));
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
    'teams.rename sales': () => response(200, { team_id: 'sales', team_name: 'Revenue' }),
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

// A fetcher whose Team list reads wait for the test to answer them, in any order.
function heldListFetcher() {
  const lists = [];
  const { fetcher } = heldOrderFetcher();
  let holding = false;
  const held = async (key, params = {}) => {
    if (key !== 'teams.list' || !holding) return fetcher(key, params);
    return new Promise((resolve) => lists.push((ids) => resolve(response(200, { teams: listedTeams(ids) }))));
  };
  return { fetcher: held, lists, hold() { holding = true; } };
}

test('of two concurrent list re-reads the one that began last wins, whichever answers first', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    clearTeamContext();
    const { fetcher, lists, hold } = heldListFetcher();
    await loadTeamContext(fetcher, 'support');
    hold();
    const older = reloadTeamList(fetcher);
    const newer = reloadTeamList(fetcher);
    await settle();
    const answers = [['marketing', 'sales', 'support'], ['sales', 'support', 'marketing']];
    for (const index of order) {
      lists[index](answers[index]);
      await settle();
    }
    await Promise.all([older, newer]);
    assert.deepEqual(orderIds(), answers[1], `answered in the order ${order}`);
  }
});

test('a Team list change announced while the context loads is read once the load ends', async () => {
  const { fetcher, lists, hold } = heldListFetcher();
  hold();
  const loading = loadTeamContext(fetcher, 'support');
  await settle();
  teamListChanged(fetcher);
  assert.equal(lists.length, 1);
  lists[0](['marketing', 'support', 'sales']);
  await loading;
  await settle();
  // The change is not dropped: the list is read again after the load.
  assert.equal(lists.length, 2);
  lists[1](['sales', 'support', 'marketing']);
  await settle();
  assert.deepEqual(orderIds(), ['sales', 'support', 'marketing']);
  // A change announced once the context is ready is read at once.
  teamListChanged(fetcher);
  await settle();
  assert.equal(lists.length, 3);
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
  const fetcher = async (key, params = {}) => {
    if (holding && key === 'teams.list') return new Promise((resolve) => lists.push({ answer: resolve }));
    return held.fetcher(key, params);
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

test('requests for the inventory share one read, and one made while it runs gets one more read after it', async () => {
  let reads = 0;
  let hold = null;
  const fetcher = fixtureFetcher({
    'assistants.list marketing': async () => {
      reads += 1;
      if (hold) await hold.promise;
      return response(200, { assistants: [installedAssistant('salesnator')] });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  reads = 0;
  // Two requests within the window: one read, after which both settle.
  await Promise.all([requestInventoryRefresh(fetcher), requestInventoryRefresh(fetcher)]);
  assert.equal(reads, 1);

  // A request made while a read runs waits for one more read after it.
  hold = deferred();
  const first = requestInventoryRefresh(fetcher);
  while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  const second = requestInventoryRefresh(fetcher);
  const released = hold;
  hold = null;
  released.resolve();
  await first;
  await second;
  assert.equal(reads, 3);

  // Clearing the context settles a request still waiting for its read, which then never runs.
  const waiting = requestInventoryRefresh(fetcher);
  clearTeamContext();
  await waiting;
  assert.equal(reads, 3);
});
