import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { get } from 'svelte/store';

import * as context from '../src/lib/teamContext.js';
import { socketReads } from '../src/lib/adminSocket.js';
import { LocalApiError } from '../src/lib/localApi.js';
import { RETRY_FIRST_MS } from '../src/lib/synced.js';

const { clearTeamContext, teamContext } = context;
const EPOCH = 'a'.repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The Team context reads and changes Teams over the session socket (ADR-0114). Each test's fixture states a whole
// Space as one function of an operation's key and its params: the method, followed for one Team's operation by that
// Team (`teams.list`, `teams.create`, `teams.rename marketing`, `teams.delete marketing`, `teams.reorder`,
// `assistants.registry`, `assistants.list marketing`). Each watched topic's subscription is in place at once, and a test
// announces a change of a topic as Admin does.
let fixture = null;
const listeners = new Map();
const revisions = new Map();
socketReads.call = async (method, params) => fixture(params.team_id ? `${method} ${params.team_id}` : method, params);
socketReads.watch = (topic, listener) => {
  const set = listeners.get(topic) ?? new Set();
  listeners.set(topic, set);
  set.add(listener);
  queueMicrotask(() => {
    if (set.has(listener)) listener(topic, 'open', { epoch: EPOCH, revision: revisions.get(topic) ?? 0 });
  });
  return () => set.delete(listener);
};

function announce(topic) {
  const revision = (revisions.get(topic) ?? 0) + 1;
  revisions.set(topic, revision);
  for (const listener of [...(listeners.get(topic) ?? [])]) listener(topic, 'changed', { epoch: EPOCH, revision });
}

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
const renameTeam = using(context.renameTeam);
const reorderTeams = using(context.reorderTeams);
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
const CATALOG = [
  { id: 'hello-pulse', name: 'Hello Pulse' },
  { id: 'salesnator', name: 'Salesnator' },
];
const MARKETING = { team_id: 'marketing', team_name: 'Marketing', status: 'running' };
const SUPPORT = { team_id: 'support', team_name: 'Support', status: 'running' };

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

function held() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function fixtureFetcher(overrides = {}) {
  return async (key, params = {}) => {
    if (overrides[key]) return overrides[key](params);
    if (key === 'teams.list') return response(200, { teams: [MARKETING, SUPPORT] });
    if (key === 'assistants.registry') {
      return response(200, { assistants: CATALOG.map(({ id, name }) => ({ id, title: name })) });
    }
    if (key === 'assistants.list marketing') return response(200, { assistants: [installedAssistant('salesnator')] });
    if (key === 'assistants.list support') return response(200, { assistants: [installedAssistant('hello-pulse')] });
    throw new Error(`Unexpected request: ${key}`);
  };
}

function deleted(teamId = 'marketing') {
  return response(200, {
    team_id: teamId,
    destroyed: true,
    assistants_removed: 1,
    residue_absent: LOCAL_TEAM_RESIDUES,
    storage_removed: true,
    trace_id: 'c'.repeat(32),
  });
}

test.beforeEach(() => {
  clearTeamContext();
  revisions.clear();
});

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
    catalog: CATALOG,
    installedAssistants: [installedAssistant('hello-pulse')],
    activeAssistantIds: ['hello-pulse'],
    inventory: 'ready',
    error: '',
  });
});

test('switching Teams immediately selects the asked Team and clears stale inventory', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const assistants = held();
  const pending = selectTeam(fixtureFetcher({ 'assistants.list support': () => assistants.promise }), 'support');

  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  assert.equal(get(teamContext).inventory, 'loading');
  assistants.release(response(200, { assistants: [installedAssistant('hello-pulse')] }));
  assert.deepEqual(await pending, { installedAssistants: [installedAssistant('hello-pulse')] });
  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('hello-pulse')]);
});

test('a Team that refuses to open returns the selection to the Team selected before', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  await assert.rejects(
    selectTeam(fixtureFetcher({ 'assistants.list support': async () => response(404, { detail: 'Team not found' }) }),
      'support'),
    (error) => error instanceof LocalApiError && error.status === 404,
  );
  await flush();
  // It says so, without the inventory a message names, until that inventory is read again.
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.equal(get(teamContext).phase, 'error');
  assert.equal(get(teamContext).error, 'Team not found');
  assert.equal(get(teamContext).inventory, 'failed');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  await refreshTeamInventory(fixtureFetcher());
  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('salesnator')]);
  await assert.rejects(selectTeam(fixtureFetcher(), 'unknown'), /Invalid local Team request/);
});

test('an outage while a Team opens is retried, never shown as a failure, and the Team opens once it reads', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await loadTeamContext(fixtureFetcher(), 'marketing');
    let failures = 1;
    const fetcher = fixtureFetcher({
      'assistants.list support': async () => (failures-- > 0
        ? response(503, { detail: 'Team is unavailable' })
        : response(200, { assistants: [] })),
    });
    const opening = selectTeam(fetcher, 'support');
    await flush();
    assert.equal(get(teamContext).phase, 'loading');
    assert.equal(get(teamContext).error, '');
    mock.timers.tick(RETRY_FIRST_MS);
    assert.deepEqual(await opening, { installedAssistants: [] });
    assert.equal(get(teamContext).phase, 'ready');
  } finally {
    mock.timers.reset();
  }
});

test('the Team list and the inventory follow every change Admin announces, the newest read last', async () => {
  let teams = [MARKETING, SUPPORT];
  let installed = [installedAssistant('salesnator')];
  const listRead = { pending: null };
  const fetcher = fixtureFetcher({
    'teams.list': async () => {
      if (listRead.pending) await listRead.pending;
      return response(200, { teams });
    },
    'assistants.list marketing': async () => response(200, { assistants: installed }),
  });
  await loadTeamContext(fetcher, 'marketing');

  // A change lands while the list is read: the read under way is followed by one more, and the newest list shows.
  const first = held();
  listRead.pending = first.promise;
  teams = [MARKETING];
  announce('teams');
  teams = [MARKETING, { team_id: 'growth', team_name: 'Growth', status: 'running' }];
  announce('teams');
  listRead.pending = null;
  first.release();
  await flush();
  await flush();
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'growth']);

  installed = [installedAssistant('salesnator'), installedAssistant('hello-pulse', 'stopped')];
  announce('team/marketing/inventory');
  await flush();
  assert.deepEqual(get(teamContext).installedAssistants, installed);
  assert.deepEqual(get(teamContext).activeAssistantIds, ['salesnator']);
});

test('a selected Team removed elsewhere gives way to the first Team the list read shows', async () => {
  let teams = [MARKETING, SUPPORT];
  const fetcher = fixtureFetcher({ 'teams.list': async () => response(200, { teams }) });
  await loadTeamContext(fetcher, 'support');
  teams = [MARKETING];
  announce('teams');
  await flush();
  await flush();
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('salesnator')]);
});

test('a confirmed empty Space keeps the catalog while malformed Team data fails closed', async () => {
  await loadTeamContext(fixtureFetcher({ 'teams.list': async () => response(200, { teams: [] }) }));
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: CATALOG,
    installedAssistants: [],
    activeAssistantIds: [],
    inventory: 'ready',
    error: '',
  });

  for (const document of [
    { teams: [{ team_id: '../escape', team_name: 'Unsafe', status: 'running' }] },
    { teams: [{ id: 'marketing', name: 'Unsupported alias', status: 'running' }] },
    { teams: [], trace_id: '../invalid' },
    { teams: [], debug: true },
  ]) {
    clearTeamContext();
    await assert.rejects(
      loadTeamContext(fixtureFetcher({ 'teams.list': async () => response(200, document) })),
      (error) => error instanceof LocalApiError && error.message === 'The local Team inventory is invalid.',
    );
    assert.equal(get(teamContext).phase, 'error');
    assert.deepEqual(get(teamContext).teams, []);
  }
  clearTeamContext();
  await loadTeamContext(fixtureFetcher({
    'teams.list': async () => response(200, { teams: [], trace_id: 'a'.repeat(32) }),
  }));
  assert.equal(get(teamContext).phase, 'ready');
});

test('a refused read is shown, and the context recovers by itself on the next change', async () => {
  let refuse = true;
  const fetcher = fixtureFetcher({
    'teams.list': async () => (refuse ? response(400, { detail: 'Team id is invalid' }) : response(200, { teams: [] })),
  });
  await assert.rejects(loadTeamContext(fetcher), /Team id is invalid/);
  assert.equal(get(teamContext).error, 'Team id is invalid');
  refuse = false;
  announce('teams');
  await flush();
  await flush();
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).error, '');
});

test('reading the inventory again shows the context loading until the fresh one, with the registry, is read', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const inventory = held();
  const refreshing = refreshTeamInventory(fixtureFetcher({
    'assistants.registry': async () => response(200, { assistants: [{ id: 'new-one', title: 'New One' }] }),
    'assistants.list marketing': () => inventory.promise,
  }));
  assert.equal(get(teamContext).phase, 'loading');
  assert.equal(get(teamContext).inventory, 'loading');
  // The last inventory stays on display meanwhile.
  assert.deepEqual(get(teamContext).installedAssistants, [installedAssistant('salesnator')]);
  inventory.release(response(200, { assistants: [installedAssistant('new-one')] }));
  assert.deepEqual(await refreshing, { installedAssistants: [installedAssistant('new-one')] });
  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).catalog, [{ id: 'new-one', name: 'New One' }]);
  assert.deepEqual(get(teamContext).activeAssistantIds, ['new-one']);

  await assert.rejects(
    refreshTeamInventory(fixtureFetcher({
      'assistants.list marketing': async () => response(200, { assistants: 'invalid' }),
    })),
    /installed Assistant inventory is invalid/,
  );
  assert.equal(get(teamContext).inventory, 'failed');
  assert.deepEqual(get(teamContext).installedAssistants, []);
  clearTeamContext();
  await assert.rejects(refreshTeamInventory(fixtureFetcher()), /context changed/);
});

test('creates a Team with the exact payload and selects it once the Team list read shows it', async () => {
  let teams = [MARKETING];
  const created = [];
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, { teams }),
    'teams.create': async (params) => {
      created.push(params);
      teams = [MARKETING, { team_id: 'growth', team_name: 'Growth', status: 'running' }];
      return response(201, { created: true, team_id: 'growth', team_name: 'Growth', status: 'running' });
    },
    'assistants.list growth': async () => response(200, { assistants: [] }),
  });
  await loadTeamContext(fetcher, 'marketing');
  const result = await createTeam(fetcher, '  Growth  ');
  assert.deepEqual(created, [{ body: { team_name: 'Growth' } }]);
  assert.deepEqual(result, { created: true, id: 'growth', name: 'Growth', status: 'running' });
  await flush();
  assert.equal(get(teamContext).selectedTeamId, 'growth');
  assert.equal(get(teamContext).phase, 'ready');
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'growth']);
});

test('a creation\'s own answer never writes the Team list: the read after it does', async () => {
  const fetcher = fixtureFetcher({
    // Admin answers the creation, but the list it reads next does not hold the Team yet.
    'teams.create': async () => response(201, { created: true, team_id: 'growth', team_name: 'Growth', status: 'running' }),
  });
  await loadTeamContext(fetcher, 'marketing');
  await createTeam(fetcher, 'Growth');
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'support']);
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
});

test('a Team that could not be created leaves the selected Team, and invalid answers are refused', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  await assert.rejects(createTeam(fixtureFetcher({
    'teams.create': async () => response(503, { detail: 'unavailable' }),
  }), 'Growth'), /unavailable/);
  for (const body of [
    { created: true, team_id: 'growth', team_name: 'Growth', status: 'running', redirect: 'https://example.test' },
    { created: true, team_id: 123, team_name: 'Growth', status: 'running' },
    { created: true, id: 'growth', name: 'Growth', status: 'running' },
  ]) {
    await assert.rejects(
      createTeam(fixtureFetcher({ 'teams.create': async () => response(201, body) }), 'Growth'),
      (error) => error instanceof LocalApiError && error.message === 'The Team creation returned an invalid response.',
    );
  }
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  assert.equal(get(teamContext).phase, 'ready');
  await assert.rejects(createTeam(fixtureFetcher(), '   '), /valid Team name/);
});

test('a first Team whose creation answer was lost opens once Admin says the Team list changed', async () => {
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

  announce('teams');
  await flush();
  await flush();
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'growth');
  assert.equal(get(teamContext).inventory, 'ready');
});

test('a Team rename is sent by id and the name shown is the one the Team list read after it holds', async () => {
  let name = 'Marketing';
  const renames = [];
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, { teams: [{ ...MARKETING, team_name: name }, SUPPORT] }),
    'teams.rename marketing': async (params) => {
      renames.push(params.body);
      name = params.body.team_name;
      return response(200, { team_id: 'marketing', team_name: params.body.team_name });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  await assert.rejects(renameTeam(fetcher, 'marketing', '   '), /valid Team name/);
  assert.equal((await renameTeam(fetcher, 'marketing', 'Marketing')).name, 'Marketing');
  assert.deepEqual(renames, []);
  assert.equal((await renameTeam(fetcher, 'marketing', ' Growth ')).name, 'Growth');
  assert.deepEqual(renames, [{ team_name: 'Growth' }]);
  assert.equal(get(teamContext).teams.find((team) => team.id === 'marketing').name, 'Growth');
  await assert.rejects(renameTeam(fetcher, 'unknown', 'Other'), /Invalid local Team request/);
  await assert.rejects(renameTeam(fixtureFetcher({
    'teams.rename marketing': async () => response(200, { team_id: 'support', team_name: 'Other' }),
  }), 'marketing', 'Other'), /invalid response/);
  await assert.rejects(renameTeam(fixtureFetcher({
    'teams.rename marketing': async () => response(409, { detail: 'another Team already has this name' }),
  }), 'marketing', 'Taken'), /another Team already has this name/);
  // Team names are sent and compared in NFC, and bounded by code points, as Team admits them.
  const nfc = [];
  await renameTeam(fixtureFetcher({
    'teams.rename marketing': async (params) => {
      nfc.push(params.body.team_name);
      return response(200, { team_id: 'marketing', team_name: params.body.team_name });
    },
  }), 'marketing', 'Équipe');
  assert.deepEqual(nfc, ['Équipe']);
  await assert.rejects(renameTeam(fetcher, 'marketing', '\u{1F600}'.repeat(81)), /valid Team name/);
});

test('a Team is renamed while its inventory is read again', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  const inventory = held();
  const fetcher = fixtureFetcher({
    'teams.rename marketing': async () => response(200, { team_id: 'marketing', team_name: 'Growth' }),
    'assistants.list marketing': () => inventory.promise,
  });
  const refreshing = refreshTeamInventory(fetcher);
  assert.equal(get(teamContext).phase, 'loading');
  const renaming = renameTeam(fetcher, 'marketing', 'Growth');
  inventory.release(response(200, { assistants: [] }));
  await refreshing;
  assert.equal((await renaming).id, 'marketing');
});

test('deletes a Team with exact credentials and selects a remaining Team from the read after it', async () => {
  const calls = [];
  let gone = false;
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, { teams: gone ? [SUPPORT] : [MARKETING, SUPPORT] }),
    'teams.delete marketing': async (params) => {
      calls.push(params);
      gone = true;
      return deleted();
    },
  });
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
    storageRemoved: true,
  });
  await flush();
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'support');
  assert.deepEqual(get(teamContext).teams, [{ id: 'support', name: 'Support', status: 'running' }]);
});

test('deleting the last Team leaves a context known to be empty', async () => {
  let gone = false;
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, { teams: gone ? [] : [MARKETING] }),
    'teams.delete marketing': async () => {
      gone = true;
      return deleted();
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  await deleteTeam(fetcher, 'marketing', 'Marketing', 'secret');
  assert.deepEqual(get(teamContext), {
    phase: 'ready',
    teams: [],
    selectedTeamId: '',
    catalog: CATALOG,
    installedAssistants: [],
    activeAssistantIds: [],
    inventory: 'ready',
    error: '',
  });
});

test('a Team deletion fails closed on an inexact name, a bounded password, or a malformed answer', async () => {
  await loadTeamContext(fixtureFetcher(), 'marketing');
  let requests = 0;
  const counting = async () => { requests += 1; };
  await assert.rejects(deleteTeam(counting, 'marketing', 'marketing', 'secret'), /Enter the exact Team name/);
  await assert.rejects(deleteTeam(counting, 'marketing', 'Marketing', ''), /current Supervisor password/);
  // 4,097 astral characters are 4,097 code points: one more than the bound, whatever their UTF-16 length.
  await assert.rejects(
    deleteTeam(counting, 'marketing', 'Marketing', '\u{1F512}'.repeat(4097)),
    /current Supervisor password/,
  );
  assert.equal(requests, 0);
  const valid = await deleted();
  const body = await valid.json();
  for (const answer of [
    { ...body, redirect: 'https://example.test' },
    { ...body, residue_absent: undefined },
    { ...body, residue_absent: [] },
    { ...body, residue_absent: [...LOCAL_TEAM_RESIDUES].reverse() },
    { ...body, residue_absent: [...LOCAL_TEAM_RESIDUES, 'team_storage'] },
    { ...body, residue_absent: [...LOCAL_TEAM_RESIDUES.slice(0, -1), 'TeamStorage'] },
  ]) {
    await assert.rejects(
      deleteTeam(fixtureFetcher({ 'teams.delete marketing': async () => response(200, answer) }),
        'marketing', 'Marketing', 'secret'),
      (error) => error instanceof LocalApiError && error.message === 'The Team deletion returned an invalid response.',
    );
  }
  await assert.rejects(
    deleteTeam(fixtureFetcher({
      'teams.delete marketing': async () => response(403, { detail: 'Supervisor password is incorrect' }),
    }), 'marketing', 'Marketing', 'wrong password'),
    (error) => error.status === 403 && error.message === 'Supervisor password is incorrect',
  );
  assert.equal(get(teamContext).phase, 'ready');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  // A password of 1,600 astral and 1,001 BMP characters is 2,601 code points: inside the bound, sent unchanged.
  let sent = '';
  const password = '\u{1F512}'.repeat(1600) + 'a'.repeat(1001);
  await deleteTeam(fixtureFetcher({
    'teams.delete marketing': async (params) => {
      sent = params.body.password;
      return deleted();
    },
  }), 'marketing', 'Marketing', password);
  assert.equal(sent, password);
});

test('a reorder shows the moved order at once, saves it, and then shows the Team list read after it', async () => {
  let saved = ['marketing', 'support'];
  const sends = [];
  const save = held();
  const fetcher = fixtureFetcher({
    'teams.list': async () => response(200, {
      teams: saved.map((id) => (id === 'marketing' ? MARKETING : SUPPORT)),
    }),
    'teams.reorder': async (params) => {
      sends.push(params.body.team_ids);
      await save.promise;
      saved = params.body.team_ids;
      return response(200, { teams: saved.map((id) => (id === 'marketing' ? MARKETING : SUPPORT)) });
    },
  });
  await loadTeamContext(fetcher, 'marketing');
  const saving = reorderTeams(fetcher, ['support', 'marketing']);
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['support', 'marketing']);
  // A move made during the save is coalesced into one later save; saves are never concurrent.
  const again = reorderTeams(fetcher, ['marketing', 'support']);
  assert.equal(again, saving);
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'support']);
  save.release();
  await saving;
  assert.deepEqual(sends, [['support', 'marketing'], ['marketing', 'support']]);
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'support']);
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
});

test('a refused or lost reorder shows the Team list as Admin holds it', async () => {
  const fetcher = fixtureFetcher({
    'teams.reorder': async () => response(409, { code: 'team-order-stale', detail: 'The Team list changed' }),
  });
  await loadTeamContext(fetcher, 'marketing');
  await assert.rejects(reorderTeams(fetcher, ['support', 'marketing']), (error) => error.status === 409);
  await flush();
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'support']);
  await assert.rejects(reorderTeams(fixtureFetcher({
    'teams.reorder': async () => { throw new LocalApiError('Admin disconnected before it answered.', 0, 'outcome-unknown'); },
  }), ['support', 'marketing']), (error) => error.code === 'outcome-unknown');
  assert.deepEqual(get(teamContext).teams.map((team) => team.id), ['marketing', 'support']);
  await assert.rejects(reorderTeams(fixtureFetcher({
    'teams.reorder': async () => response(200, { teams: [MARKETING] }),
  }), ['support', 'marketing']), /invalid response/);
  for (const ids of [['marketing'], ['marketing', 'marketing'], ['marketing', 'other'], 'marketing']) {
    await assert.rejects(reorderTeams(fetcher, ids), /Invalid local Team request/);
  }
});

test('clearing the context forgets everything and a late answer never shows in the next session', async () => {
  const teams = held();
  const loading = loadTeamContext(fixtureFetcher({ 'teams.list': () => teams.promise }));
  await flush();
  clearTeamContext();
  teams.release(response(200, { teams: [MARKETING] }));
  await assert.rejects(loading, /context changed/);
  await flush();
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
  // The next session reads its own.
  await loadTeamContext(fixtureFetcher(), 'support');
  assert.equal(get(teamContext).selectedTeamId, 'support');
});

test('a retry reads every value again and keeps the selection', async () => {
  let teamReads = 0;
  const fetcher = fixtureFetcher({
    'teams.list': async () => {
      teamReads += 1;
      return response(200, { teams: [MARKETING, SUPPORT] });
    },
  });
  await loadTeamContext(fetcher, 'support');
  await loadTeamContext(fetcher, 'support');
  assert.equal(teamReads, 2);
  assert.equal(get(teamContext).selectedTeamId, 'support');
  // A retry naming another listed Team selects it.
  await loadTeamContext(fetcher, 'marketing');
  assert.equal(get(teamContext).selectedTeamId, 'marketing');
  await assert.rejects(context.loadTeamContext('Not A Team'), /Invalid local Team request/);
});
