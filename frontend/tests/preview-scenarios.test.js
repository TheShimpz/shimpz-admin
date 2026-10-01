import assert from 'node:assert/strict';
import test from 'node:test';

import { renderClarification } from '../src/lib/clarification.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import { CLARIFICATION, createScenario, SCENARIOS } from '../e2e/scenarios.js';

const ROUTINES = '/api/teams/marketing/routines';

function propose(scenario, message) {
  const [done] = scenario.chat.message({ type: 'chat', message, files: [], assistant_ids: [] });
  return done.routine_proposal;
}

test('a scenario answers only what it declares and fails closed otherwise', () => {
  for (const name of SCENARIOS) {
    const scenario = createScenario(name);
    assert.equal(scenario.respond({ method: 'POST', path: '/api/session' }).status, 200);
    assert.equal(scenario.respond({ method: 'GET', path: '/api/space/reset' }), null);
    assert.equal(scenario.respond({ method: 'DELETE', path: '/api/teams/marketing' }), null);
  }
  assert.equal(createScenario('setup').respond({ method: 'GET', path: '/api/teams' }), null);
  assert.equal(createScenario('empty').respond({ method: 'GET', path: ROUTINES }), null);
  assert.throws(() => createScenario('production'), /unknown scenario/);
});

test('scenarios never share state, and a caller cannot mutate one through a response', () => {
  const first = createScenario('routines');
  const second = createScenario('routines');
  first.respond({ method: 'GET', path: ROUTINES }).json.routines[0].quote = 'changed';
  first.respond({ method: 'DELETE', path: `${ROUTINES}/${'a'.repeat(32)}` });
  const untouched = second.respond({ method: 'GET', path: ROUTINES }).json;
  assert.equal(untouched.routines.length, 2);
  assert.notEqual(untouched.routines[0].quote, 'changed');
  assert.equal(first.respond({ method: 'GET', path: ROUTINES }).json.routines.length, 1);
});

test('a chat proposal previews its own words and is consumed once into a distinct Routine', () => {
  const scenario = createScenario('ready');
  const [empty] = scenario.chat.message({ type: 'chat', message: 'List my DNS zones now', files: [], assistant_ids: [] });
  assert.equal(empty.routine_proposal, null);
  const daily = propose(scenario, 'Every day at 9, check my certificates');
  const weekly = propose(scenario, 'Every Monday, list my DNS zones');
  assert.notEqual(daily.proposal_id, weekly.proposal_id);

  const preview = scenario.respond({
    method: 'POST',
    path: `${ROUTINES}/proposals/${daily.proposal_id}/preview`,
    body: { timezone: 'America/Sao_Paulo' },
  }).json;
  assert.equal(preview.quote, 'Every day at 9, check my certificates');
  assert.equal(preview.timezone, 'America/Sao_Paulo');

  const created = [daily, weekly].map((proposal) => scenario.respond({
    method: 'POST',
    path: ROUTINES,
    body: { proposal_id: proposal.proposal_id, timezone: 'UTC' },
  }).json.routine);
  assert.notEqual(created[0].routine_id, created[1].routine_id);
  assert.equal(created[0].quote, daily.quote);
  const reused = scenario.respond({ method: 'POST', path: ROUTINES, body: { proposal_id: daily.proposal_id } });
  assert.equal(reused.status, 404);
  assert.equal(
    scenario.respond({ method: 'POST', path: `${ROUTINES}/proposals/${daily.proposal_id}/preview`, body: {} }).status,
    404,
  );
  assert.equal(scenario.respond({ method: 'GET', path: ROUTINES }).json.routines.length, 2);
});

test('runs are stopped or released by id, and the chat socket answers a sync', () => {
  const scenario = createScenario('routines');
  const stop = scenario.respond({ method: 'POST', path: `${ROUTINES}/runs/${'f'.repeat(32)}/stop`, body: {} });
  assert.equal(stop.json.stopped, true);
  const release = scenario.respond({ method: 'POST', path: `${ROUTINES}/runs/${'b'.repeat(32)}/resolve`, body: {} });
  assert.equal(release.json.resolved, true);
  assert.deepEqual(scenario.respond({ method: 'GET', path: ROUTINES }).json.runs, []);
  assert.deepEqual(scenario.chat.message({ type: 'sync' }), [{ type: 'sync-empty' }]);
  assert.deepEqual(scenario.chat.message({ type: 'unknown' }), []);
});

test('the clarify scenarios ask one valid question and fail the first answer only when told to', () => {
  const chat = (scenario, message) => scenario.chat.message({ type: 'chat', message, files: [], assistant_ids: [] })[0];
  const answer = `Pedido\n\nQuestion: ${CLARIFICATION.question}\nAnswer: Stack montável`;
  for (const name of ['clarify', 'clarify-error']) {
    const scenario = createScenario(name);
    const asked = chat(scenario, 'Pedido');
    assert.equal(asked.reply, renderClarification(CLARIFICATION));
    assert.deepEqual(parseChatEvent(asked, 'marketing', 'Marketing').clarification, CLARIFICATION);
    if (name === 'clarify-error') {
      assert.deepEqual(chat(scenario, answer), { type: 'error', status: 502, detail: 'local chat request failed' });
    }
    const done = chat(scenario, answer);
    assert.equal(done.type, 'done');
    assert.equal(done.clarification, null);
    assert.match(done.reply, /Stack montável/u);
  }
});

test('the human-request scenario pauses with a challenge the chat parser admits and resolves either decision', () => {
  for (const decision of ['deny', 'submit']) {
    const scenario = createScenario('human-request');
    const [challenge] = scenario.chat.message({
      type: 'chat', message: 'Notícias de IA de hoje', files: [], assistant_ids: [], locale: 'pt',
    });
    const parsed = parseChatEvent(challenge, 'marketing', 'Marketing');
    assert.equal(parsed.help_url, 'https://dashboard.exa.ai/api-keys');
    assert.equal(parsed.request.stored_input, 'exa-api-key');
    const [done] = scenario.chat.message({
      type: 'human-response',
      challenge_id: challenge.challenge_id,
      decision,
      ...(decision === 'submit' ? { value: 'exa-key' } : {}),
    });
    assert.equal(parseChatEvent(done, 'marketing', 'Marketing').type, 'done');
  }
});

test('a human request names an Assistant its Team inventory lists, so Admin opens it', () => {
  for (const [name, kind] of [['human-request', 'input:password'], ['human-approval', 'approval']]) {
    const scenario = createScenario(name);
    const [challenge] = scenario.chat.message({ type: 'chat', message: 'News', files: [], assistant_ids: [] });
    const parsed = parseChatEvent(challenge, 'marketing', 'Marketing');
    const inventory = scenario.respond({ method: 'GET', path: '/api/teams/marketing/assistants' }).json.assistants;
    assert.equal(parsed.type, 'human-required', name);
    assert.equal(parsed.request.kind, kind, name);
    assert.ok(inventory.some((entry) => entry.assistant === parsed.assistant.id), name);
  }
});

test('the Team order is saved only as an exact permutation of the listed Teams', () => {
  const scenario = createScenario('ready');
  const ids = () => scenario.respond({ method: 'GET', path: '/api/teams' }).json.teams.map((team) => team.team_id);
  const put = (body) => scenario.respond({ method: 'PUT', path: '/api/teams/order', body });
  const listed = ids();
  assert.deepEqual(listed, ['marketing', 'trinity', 'cypher', 'morpheus', 'neo', 'smith']);

  for (const body of [
    null,
    [],
    { team_ids: 'marketing' },
    { team_ids: listed, extra: true },
    { team_ids: [...listed, 'marketing'] },
    { team_ids: ['Marketing', ...listed.slice(1)] },
    { team_ids: Array.from({ length: 129 }, (_, index) => `t${index}`) },
  ]) {
    assert.equal(put(body).status, 400);
  }
  assert.equal(put({ team_ids: listed.slice(1) }).status, 409);
  assert.equal(put({ team_ids: [...listed.slice(1), 'oracle'] }).status, 409);
  assert.deepEqual(ids(), listed);

  const reordered = [...listed].reverse();
  assert.deepEqual(put({ team_ids: reordered }).json.teams.map((team) => team.team_id), reordered);
  assert.deepEqual(ids(), reordered);
});

test('the reorder failure scenarios fail one save, then save normally', () => {
  const unavailable = createScenario('reorder-unavailable');
  const order = (scenario) => scenario.respond({ method: 'GET', path: '/api/teams' }).json.teams.map((team) => team.team_id);
  const reversed = order(unavailable).reverse();
  assert.equal(unavailable.respond({ method: 'PUT', path: '/api/teams/order', body: { team_ids: reversed } }).status, 503);
  assert.equal(unavailable.respond({ method: 'PUT', path: '/api/teams/order', body: { team_ids: reversed } }).status, 200);

  const conflict = createScenario('reorder-conflict');
  const before = order(conflict);
  assert.equal(conflict.respond({ method: 'PUT', path: '/api/teams/order', body: { team_ids: before } }).status, 409);
  assert.deepEqual(order(conflict), ['oracle', ...before]);
  assert.equal(conflict.respond({ method: 'PUT', path: '/api/teams/order', body: { team_ids: order(conflict) } }).status, 200);
});

test('every listed Team answers its read-only views, and an unlisted one fails closed', () => {
  const scenario = createScenario('ready');
  for (const view of ['assistants', 'files', 'chat/history', 'inference', 'assistant-integrations', 'assistant-stored-inputs', 'routines']) {
    assert.equal(scenario.respond({ method: 'GET', path: `/api/teams/neo/${view}` }).status, 200, view);
    assert.equal(scenario.respond({ method: 'GET', path: `/api/teams/oracle/${view}` }), null, view);
  }
  assert.equal(scenario.respond({ method: 'GET', path: '/api/teams/neo/unknown' }), null);
  assert.equal(scenario.respond({ method: 'POST', path: '/api/teams/neo/routines', body: {} }), null);
});

test('every listed Team answers its chat with a reply the parser admits, and an unlisted one has no socket', () => {
  const scenario = createScenario('ready');
  assert.equal(scenario.chat.team('/api/teams/neo/chat/ws'), 'neo');
  assert.equal(scenario.chat.team('/api/teams/marketing/chat/ws'), 'marketing');
  assert.equal(scenario.chat.team('/api/teams/oracle/chat/ws'), null);
  assert.equal(scenario.chat.team('/api/teams/neo/chat'), null);
  const [done] = scenario.chat.message({ type: 'chat', message: 'Hello', files: [], assistant_ids: [] }, 'neo');
  const parsed = parseChatEvent(done, 'neo', 'Neo');
  assert.equal(parsed.team_name, 'Neo');
  assert.equal(parsed.reply, 'Preview reply to: Hello');
  assert.deepEqual(scenario.chat.message({ type: 'sync' }, 'neo'), [{ type: 'sync-empty' }]);
  assert.deepEqual(scenario.chat.message({ type: 'stop' }, 'neo'), []);
});

test('every preview reply reports usage in the exact done-frame shape', () => {
  const scenario = createScenario('ready');
  for (const teamId of ['marketing', 'neo']) {
    const [done] = scenario.chat.message({ type: 'chat', message: 'Hello', files: [], assistant_ids: [] }, teamId);
    const parsed = parseChatEvent(done, teamId, done.team_name);
    assert.equal(parsed.usage.models.length, 1, teamId);
    assert.equal(parsed.usage.duration_ms, 6240, teamId);
  }
});
