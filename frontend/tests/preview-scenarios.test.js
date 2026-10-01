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
