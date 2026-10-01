import assert from 'node:assert/strict';
import test from 'node:test';

import { renderClarification } from '../src/lib/clarification.js';
import { displayedHumanRequest, parseChatEvent } from '../src/lib/localChat.js';
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
  const scenario = createScenario('human-request');
  const [challenge] = scenario.chat.message({ type: 'chat', message: 'News', files: [], assistant_ids: [] });
  const parsed = parseChatEvent(challenge, 'marketing', 'Marketing');
  const inventory = scenario.respond({ method: 'GET', path: '/api/teams/marketing/assistants' }).json.assistants;
  assert.equal(parsed.type, 'human-required');
  assert.ok(inventory.some((entry) => entry.assistant === parsed.assistant.id));
});

test('the human-approval scenario renders its copy in the turn language and keeps canonical option values', () => {
  const scenario = createScenario('human-approval');
  const ask = (locale) => scenario.chat.message({
    type: 'chat', message: 'Publish my DNS changes', files: [], assistant_ids: [], locale,
  })[0];
  const portuguese = parseChatEvent(ask('pt'), 'marketing', 'Marketing');
  assert.equal(portuguese.locale, 'pt');
  assert.equal(displayedHumanRequest(portuguese).title, 'Alterações de DNS a publicar: 3. Zona: example.com.');
  const english = parseChatEvent(ask('ja'), 'marketing', 'Marketing');
  assert.equal(english.locale, 'en');
  assert.equal(displayedHumanRequest(english).title, 'DNS changes to publish: 3. Zone: example.com.');
  assert.deepEqual(portuguese.request, english.request);
  assert.deepEqual(displayedHumanRequest(portuguese).options.map((option) => option.value), ['proxied', 'dns-only']);
  const [done] = scenario.chat.message({
    type: 'human-response', challenge_id: portuguese.challenge_id, decision: 'submit', value: 'dns-only',
  });
  assert.match(parseChatEvent(done, 'marketing', 'Marketing').reply, /dns-only/u);
  const inventory = scenario.respond({ method: 'GET', path: '/api/teams/marketing/assistants' }).json.assistants;
  assert.ok(inventory.some((entry) => entry.assistant === portuguese.assistant.id));
});
