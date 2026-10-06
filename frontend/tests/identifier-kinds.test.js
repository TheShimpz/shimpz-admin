import assert from 'node:assert/strict';
import test from 'node:test';

import { localizedChallenge } from '../e2e/localizedRequest.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import { isActionId, isAssistantId, isIdentifier } from '../src/lib/validate.js';

const CHALLENGE_ID = 'b'.repeat(32);
const ACTIONS = ['dns.read', 'zone_get', 'a'.repeat(128)];
const MALFORMED = ['', 'Lookup', 'a\n', 'a.', null, 7];

test('each identifier kind admits exactly its Team protocol grammar and bound', () => {
  assert.equal(isAssistantId('a'.repeat(40)), true);
  for (const value of ['a'.repeat(41), 'dns.read', 'a--b', ...MALFORMED]) assert.equal(isAssistantId(value), false);
  for (const value of ['api-token', 'a'.repeat(64)]) assert.equal(isIdentifier(value), true);
  for (const value of ['a'.repeat(65), 'api.token', 'api_token', ...MALFORMED]) assert.equal(isIdentifier(value), false);
  for (const value of ACTIONS) assert.equal(isActionId(value), true);
  for (const value of ['a'.repeat(129), 'dns..read', ...MALFORMED]) assert.equal(isActionId(value), false);
});

function progress(assistantId, action) {
  return {
    type: 'progress', seq: 1, origin: 'team', phase: 'action', state: 'started',
    assistant_id: assistantId, index: 1, action, total: 1,
  };
}

test('progress names a canonical Assistant and any canonical Action', () => {
  for (const action of ACTIONS) {
    assert.equal(parseChatEvent(progress('helper', action), 'team_1', 'Marketing').action, action);
  }
  for (const [assistantId, action] of [['a'.repeat(41), 'lookup'], ['helper', 'a'.repeat(129)], ['helper', 'a\n']]) {
    assert.throws(() => parseChatEvent(progress(assistantId, action), 'team_1', 'Marketing'), /invalid/i);
  }
});

function humanChallenge(action) {
  return {
    type: 'human-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: action, summary: 'Read records.' },
    ...localizedChallenge({
      kind: 'approval',
      ordinal: 0,
      title: 'Confirm this Action',
      description: 'The Action is waiting for your response.',
      fingerprint: 'c'.repeat(64),
    }),
  };
}

test('a human challenge names any canonical Action', () => {
  for (const action of ACTIONS) {
    assert.equal(parseChatEvent(humanChallenge(action), 'team_1', 'Marketing').action.id, action);
  }
  assert.throws(() => parseChatEvent(humanChallenge('a'.repeat(129)), 'team_1', 'Marketing'), /invalid/i);
});

function integrations(overrides) {
  return {
    type: 'integrations-required',
    challenge_id: CHALLENGE_ID,
    expires_in: 300,
    requirements: [{
      assistant_id: 'social-publisher',
      assistant_name: 'Social Publisher',
      integration_id: 'x-integration',
      provider: 'x',
      name: 'X integration',
      scopes: ['tweet.read'],
      actions: [{ id: 'publish-post' }],
      ...overrides,
    }],
  };
}

test('an integration requirement names Developers identifiers and canonical Actions', () => {
  const widest = { integration_id: 'i'.repeat(64), provider: 'p'.repeat(64), actions: [{ id: 'posts.publish_now' }] };
  assert.deepEqual(parseChatEvent(integrations(widest), 'team_1', 'Marketing').requirements[0].actions, widest.actions);
  for (const invalid of [
    { integration_id: 'i'.repeat(65) },
    { integration_id: 'x.integration' },
    { provider: 'p'.repeat(65) },
    { actions: [{ id: 'a'.repeat(129) }] },
  ]) assert.throws(() => parseChatEvent(integrations(invalid), 'team_1', 'Marketing'), /invalid/i);
});
