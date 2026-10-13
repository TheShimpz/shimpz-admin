import assert from 'node:assert/strict';
import test from 'node:test';

import { get } from 'svelte/store';

import { assistantNames } from '../src/lib/assistantNames.js';
import { clearTeamContext, loadTeamContext, refreshTeamInventory } from '../src/lib/teams/context.js';
import { socketReads } from '../src/lib/session/socket.js';
import { response, via } from './socketStub.js';

// Every topic the Team context watches is subscribed at once.
socketReads.watch = (topic, listener) => {
  queueMicrotask(() => listener(topic, 'open', { epoch: 'a'.repeat(32), revision: 0 }));
  return () => {};
};

// The Team context reads the Team list, the registry, and the selected Team's inventory over the session socket.
function spaceWith(catalog) {
  return async (method) => {
    if (method === 'teams.list') {
      return response(200, { teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] });
    }
    if (method === 'assistants.registry') return response(200, { assistants: catalog });
    if (method === 'assistants.list') return response(200, { assistants: [] });
    throw new Error(`Unexpected request: ${method}`);
  };
}

test('Assistant names follow the catalog the Team context reads, and a cleared context names none', async () => {
  clearTeamContext();
  await via(spaceWith([{ id: 'hello-pulse', title: 'Hello Pulse' }]), () => loadTeamContext('marketing'));
  assert.deepEqual(get(assistantNames), { 'hello-pulse': 'Hello Pulse' });

  // An Assistant published since the first read is named once the catalog is read again, after an install.
  await via(spaceWith([
    { id: 'hello-pulse', title: 'Hello Pulse' },
    { id: 'salesnator', title: 'Salesnator' },
  ]), refreshTeamInventory);
  assert.deepEqual(get(assistantNames), { 'hello-pulse': 'Hello Pulse', salesnator: 'Salesnator' });

  // Another session reads its own catalog.
  clearTeamContext();
  assert.deepEqual(get(assistantNames), {});
});
