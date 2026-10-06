import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';

import {
  clearTeamRoutines,
  dropTeamRoutine,
  loadTeamRoutines,
  retainTeamRoutines,
  routineContext,
} from '../src/lib/routineContext.js';

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
  output: { mode: 'show', step: 1, when: null },
  schedule: { kind: 'weekly', weekday: 0, time: '09:00' },
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-05T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  state: 'active',
  permitted: { total: 1, changes: 0 },
  permissions_revision: 0,
  model: null,
  allowance: 0,
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

// Each listing answers only when the test releases it, so responses can arrive out of order.
function deferredFetcher() {
  const pending = [];
  const fetch = (path) => new Promise((resolve) => {
    pending.push((routines, runs = [], incidents = []) => {
      const team = decodeURIComponent(path.split('/')[3]);
      resolve({ ok: true, status: 200, async json() { return { team_id: team, routines, runs, incidents }; } });
    });
  });
  return { fetch, pending };
}

async function settle(promise) {
  await promise;
  await new Promise((resolve) => setImmediate(resolve));
}

test('only a Team\'s newest Routine listing applies, whatever order responses arrive in', async () => {
  clearTeamRoutines();
  const api = deferredFetcher();
  const older = loadTeamRoutines(api.fetch, 'constructor');
  const newer = loadTeamRoutines(api.fetch, 'constructor');
  api.pending[1]([ROUTINE]);
  await settle(newer);
  api.pending[0]([]);
  await settle(older);
  assert.deepEqual(get(routineContext).get('constructor').routines.map((item) => item.routine_id), [ROUTINE.routine_id]);
  // A Team id that names an Object.prototype member resolves to nothing until it is loaded.
  assert.equal(get(routineContext).get('toString'), undefined);
});

test('a removed Team, an ended session, or a confirmed deletion discards responses still in flight', async () => {
  clearTeamRoutines();
  const api = deferredFetcher();
  await settle(Promise.all([loadTeamRoutines(api.fetch, 'marketing'), Promise.resolve(api.pending[0]([ROUTINE, OTHER], [RUN]))]));

  const afterRemoval = loadTeamRoutines(api.fetch, 'marketing');
  retainTeamRoutines(['sales']);
  api.pending[1]([ROUTINE]);
  await settle(afterRemoval);
  assert.equal(get(routineContext).has('marketing'), false);

  const afterSession = loadTeamRoutines(api.fetch, 'marketing');
  clearTeamRoutines();
  api.pending[2]([ROUTINE]);
  await settle(afterSession);
  assert.equal(get(routineContext).size, 0);

  const loaded = loadTeamRoutines(api.fetch, 'marketing');
  api.pending[3]([ROUTINE, OTHER], [RUN], [INCIDENT]);
  await settle(loaded);
  const beforeDeletion = loadTeamRoutines(api.fetch, 'marketing');
  dropTeamRoutine('marketing', ROUTINE.routine_id);
  // Deleting a Routine sets its held runs aside: none of its incidents waits for a card any more.
  const remaining = { routines: [OTHER], runs: [], incidents: [] };
  assert.deepEqual(get(routineContext).get('marketing'), remaining);
  api.pending[4]([ROUTINE, OTHER], [RUN]);
  await settle(beforeDeletion);
  assert.deepEqual(get(routineContext).get('marketing'), remaining);

  // Dropping a Routine of a Team never loaded leaves the projection unchanged.
  const unchanged = get(routineContext);
  dropTeamRoutine('sales', ROUTINE.routine_id);
  assert.equal(get(routineContext), unchanged);
});
