import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { get } from 'svelte/store';

import { socketReads } from '../src/lib/session/socket.js';
import {
  clearTeamRoutines,
  FOLLOWED_TEAMS,
  refreshTeamRoutines,
  retainTeamRoutines,
  routineContext,
  showTeamRoutines,
} from '../src/lib/routines/context.js';
import { RETRY_FIRST_MS } from '../src/lib/session/synced.js';

const ROUTINE = {
  routine_id: 'a'.repeat(32),
  name: 'Daily DNS zones',
  plan: {
    revision: 1,
    plan_digest: `sha256:${'d'.repeat(64)}`,
    steps: 1,
    actions: [['shimpz-cloudflare', 'list-zones', 1]],
    more: 0,
  },
  output: { mode: 'show', step: 1 },
  schedule: { kind: 'weekly', weekday: 0, time: '09:00' },
  timezone: 'America/Sao_Paulo',
  timezone_source: 'browser',
  next_run_at: '2026-10-05T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  state: 'active',
};
const OTHER = { ...ROUTINE, routine_id: 'c'.repeat(32), name: 'Weekly certificates' };
const RUN = {
  run_id: 'b'.repeat(32),
  routine_id: ROUTINE.routine_id,
  status: 'leased',
  scheduled_at: '2026-10-05T12:00:00Z',
  request_kind: null,
  assistant_id: null,
  action: null,
  position: null,
  steps: null,
};
const INCIDENT = {
  incident_id: 'd'.repeat(32),
  routine_id: ROUTINE.routine_id,
  name: ROUTINE.name,
  created_at: '2026-10-05T12:01:07Z',
  assistant_id: null,
  action: null,
  position: null,
  steps: null,
};

const EPOCH = 'a'.repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The session socket as the Routine lists see it: each watched topic's listeners, and each `routines.list` read held
// until the test answers it, with the revision of the Team's Routines topic it reflects.
function socket() {
  const watched = new Map();
  const reads = [];
  socketReads.watch = (topic, listener) => {
    if (!watched.has(topic)) watched.set(topic, new Set());
    watched.get(topic).add(listener);
    return () => watched.get(topic).delete(listener);
  };
  socketReads.call = (method, params) => new Promise((resolve) => {
    assert.equal(method, 'routines.list');
    reads.push({
      team: params.team_id,
      answer(routines, { runs = [], incidents = [], revision = 1, status = 200 } = {}) {
        const body = status === 200 ? { team_id: params.team_id, routines, runs, incidents } : { code: 'routine-unavailable' };
        resolve({
          ok: status === 200,
          status,
          async json() { return body; },
          revision: status === 200 ? { topic: `team/${params.team_id}/routines`, epoch: EPOCH, revision } : null,
        });
      },
    });
  });
  return {
    reads,
    watched,
    announce(teamId, cause, revision) {
      for (const listener of [...(watched.get(`team/${teamId}/routines`) ?? [])]) {
        listener(`team/${teamId}/routines`, cause, { epoch: EPOCH, revision });
      }
    },
  };
}

function listedIds(teamId) {
  return get(routineContext).get(teamId)?.routines.map((item) => item.routine_id);
}

test('a listed Team is read once its subscription is in place, and again on each change, in order', async () => {
  clearTeamRoutines();
  const api = socket();
  retainTeamRoutines(['constructor']);
  assert.equal(api.reads.length, 0);
  // A Team not read yet has nothing listed, never an empty list, and no inherited property is a Team.
  assert.equal(get(routineContext).get('constructor'), undefined);
  assert.equal(get(routineContext).get('toString'), undefined);
  api.announce('constructor', 'open', 1);
  api.announce('constructor', 'changed', 2);
  // The change heard while the first read runs is read once, after it: an older answer never shows last.
  assert.equal(api.reads.length, 1);
  api.reads[0].answer([], { revision: 1 });
  await flush();
  assert.equal(api.reads.length, 2);
  api.reads[1].answer([ROUTINE], { revision: 2 });
  await flush();
  assert.deepEqual(listedIds('constructor'), [ROUTINE.routine_id]);
  // A reopen at the revision already read reads nothing; one at a newer revision reads again.
  api.announce('constructor', 'reopen', 2);
  assert.equal(api.reads.length, 2);
  api.announce('constructor', 'reopen', 3);
  assert.equal(api.reads.length, 3);
  api.reads[2].answer([ROUTINE, OTHER], { runs: [RUN], incidents: [INCIDENT], revision: 3 });
  await flush();
  assert.deepEqual(get(routineContext).get('constructor'), {
    routines: [ROUTINE, OTHER], runs: [RUN], incidents: [INCIDENT], failed: false,
  });
  clearTeamRoutines();
});

test('a removed Team or an ended session discards what is still in flight', async () => {
  clearTeamRoutines();
  const api = socket();
  retainTeamRoutines(['marketing']);
  api.announce('marketing', 'open', 1);
  retainTeamRoutines(['sales']);
  api.reads[0].answer([ROUTINE]);
  await flush();
  assert.equal(get(routineContext).has('marketing'), false);
  api.announce('sales', 'open', 1);
  clearTeamRoutines();
  api.reads[1].answer([ROUTINE]);
  await flush();
  assert.equal(get(routineContext).size, 0);
});

test('a refusal keeps what was known beside its failure; an outage is read again on its own', async () => {
  clearTeamRoutines();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const api = socket();
    retainTeamRoutines(['marketing']);
    api.announce('marketing', 'open', 1);
    // A first listing Team refuses is marked failed with nothing listed.
    api.reads[0].answer([], { status: 409 });
    await flush();
    assert.deepEqual(get(routineContext).get('marketing'), { routines: [], runs: [], incidents: [], failed: true });
    api.announce('marketing', 'changed', 2);
    api.reads[1].answer([ROUTINE, OTHER], { runs: [RUN], revision: 2 });
    await flush();
    assert.equal(get(routineContext).get('marketing').failed, false);
    // A Team that is briefly unavailable keeps its lists, unmarked, and is read again after a backoff.
    api.announce('marketing', 'changed', 3);
    api.reads[2].answer([], { status: 503 });
    await flush();
    assert.deepEqual(get(routineContext).get('marketing'), {
      routines: [ROUTINE, OTHER], runs: [RUN], incidents: [], failed: false,
    });
    mock.timers.tick(RETRY_FIRST_MS);
    assert.equal(api.reads.length, 4);
    api.reads[3].answer([OTHER], { revision: 3 });
    await flush();
    assert.deepEqual(listedIds('marketing'), [OTHER.routine_id]);
    // A later refusal keeps the last known lists beside it.
    api.announce('marketing', 'changed', 4);
    api.reads[4].answer([], { status: 404 });
    await flush();
    assert.deepEqual(get(routineContext).get('marketing'), { routines: [OTHER], runs: [], incidents: [], failed: true });
  } finally {
    mock.timers.reset();
    clearTeamRoutines();
  }
});

test('a change to a Routine shows only through the read after it', async () => {
  clearTeamRoutines();
  const api = socket();
  retainTeamRoutines(['marketing']);
  api.announce('marketing', 'open', 1);
  api.reads[0].answer([ROUTINE, OTHER]);
  await flush();
  let settled = false;
  const refreshed = refreshTeamRoutines('marketing').then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(listedIds('marketing'), [ROUTINE.routine_id, OTHER.routine_id]);
  api.reads[1].answer([OTHER], { revision: 2 });
  await refreshed;
  assert.deepEqual(listedIds('marketing'), [OTHER.routine_id]);
  // A Team not listed has nothing to read again.
  await refreshTeamRoutines('sales');
  clearTeamRoutines();
});

test('the first Teams follow their Routines topic, any other is read once, and the shown one always follows', async () => {
  clearTeamRoutines();
  const api = socket();
  const ids = Array.from({ length: FOLLOWED_TEAMS + 2 }, (_, index) => `team_${index}`);
  retainTeamRoutines(ids);
  assert.equal(api.watched.size, FOLLOWED_TEAMS);
  const last = ids.at(-1);
  // A Team past the followed ones is read as it is listed, without a topic.
  assert.ok(api.reads.some((read) => read.team === last));
  const read = api.reads.find((item) => item.team === last);
  read.answer([ROUTINE]);
  await flush();
  assert.deepEqual(listedIds(last), [ROUTINE.routine_id]);
  // Shown in the chat, it follows its topic, and its last listing stays while it reads again.
  const stop = showTeamRoutines(last);
  assert.ok(api.watched.has(`team/${last}/routines`));
  assert.deepEqual(listedIds(last), [ROUTINE.routine_id]);
  stop();
  assert.equal(api.watched.get(`team/${last}/routines`).size, 0);
  clearTeamRoutines();
});
