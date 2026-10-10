import assert from 'node:assert/strict';
import test from 'node:test';

import { loadActionConfirmation, saveActionConfirmation } from '../src/lib/actionConfirmation.js';

function fetcher(answers) {
  const calls = [];
  const pending = [...answers];
  const fetch = async (url, init) => {
    calls.push([url, init]);
    const [status, body] = pending.shift();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

test('a Team Action confirmation setting is read and changed as exactly one boolean', async () => {
  const api = fetcher([
    [200, { team_id: 'team_1', confirm_mutating: true }],
    [200, { team_id: 'team_1', confirm_mutating: false }],
  ]);
  assert.equal(await loadActionConfirmation(api.fetch, 'team_1'), true);
  assert.equal(await saveActionConfirmation(api.fetch, 'team_1', false), false);
  assert.equal(api.calls[0][0], '/api/teams/team_1/action-confirmation');
  assert.equal(api.calls[1][1].method, 'PUT');
  assert.deepEqual(JSON.parse(api.calls[1][1].body), { confirm_mutating: false });
});

test('an invalid request, refusal, or answer is an error', async () => {
  await assert.rejects(loadActionConfirmation(null, 'team_1'), /Invalid/);
  await assert.rejects(loadActionConfirmation(fetcher([]).fetch, 'Team 1'), /Invalid/);
  await assert.rejects(saveActionConfirmation(fetcher([]).fetch, 'team_1', 'false'), /Invalid/);
  for (const [status, body] of [
    [503, { detail: 'team unavailable' }],
    [200, { team_id: 'team_2', confirm_mutating: true }],
    [200, { team_id: 'team_1', confirm_mutating: 1 }],
    [200, { team_id: 'team_1', confirm_mutating: true, extra: 1 }],
  ]) await assert.rejects(loadActionConfirmation(fetcher([[status, body]]).fetch, 'team_1'));
  // Team saved another value than the one asked for.
  await assert.rejects(
    saveActionConfirmation(fetcher([[200, { team_id: 'team_1', confirm_mutating: true }]]).fetch, 'team_1', false),
    /invalid/,
  );
});
