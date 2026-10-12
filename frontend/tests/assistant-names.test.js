import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import { assistantNames } from '../src/lib/assistantNames.js';
import { socketReads } from '../src/lib/adminSocket.js';
import { clearTeamContext, loadTeamContext, refreshTeamInventory } from '../src/lib/teamContext.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

// The Team list is the session socket's `teams.list` read (ADR-0114).
socketReads.call = async (method) => {
  assert.equal(method, 'teams.list');
  return response(200, { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] });
};

function fetcherWith(catalog) {
  return async (url) => {
    if (url === '/api/assistants') return response(200, { assistants: catalog });
    if (url === '/api/teams/marketing/assistants') return response(200, { assistants: [] });
    throw new Error(`Unexpected request: ${url}`);
  };
}

test('Assistant names follow the catalog the Team context reads, and a cleared context names none', async () => {
  clearTeamContext();
  await loadTeamContext(fetcherWith([{ id: 'hello-pulse', title: 'Hello Pulse' }]), 'marketing');
  assert.deepEqual(get(assistantNames), { 'hello-pulse': 'Hello Pulse' });

  // An Assistant published since the first read is named once the catalog is read again, after an install.
  await refreshTeamInventory(fetcherWith([
    { id: 'hello-pulse', title: 'Hello Pulse' },
    { id: 'salesnator', title: 'Salesnator' },
  ]));
  assert.deepEqual(get(assistantNames), { 'hello-pulse': 'Hello Pulse', salesnator: 'Salesnator' });

  // Another session reads its own catalog.
  clearTeamContext();
  assert.deepEqual(get(assistantNames), {});
});
