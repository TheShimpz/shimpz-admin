import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadTeamFile } from '../src/lib/attachments.js';
import { renderClarification } from '../src/lib/clarification.js';
import { displayedHumanRequest, parseChatEvent } from '../src/lib/localChat.js';
import {
  answerRoutineCard,
  listRoutines,
  openRoutineCard,
  parseRoutineRunEntry,
  readRunDiagnostics,
} from '../src/lib/routine.js';
import { CLARIFICATION, createScenario, SCENARIOS } from '../e2e/scenarios.js';
import { ROUTINE_TEXT } from '../e2e/routineScenarios.js';

const ROUTINES = '/api/teams/marketing/routines';

// A fetch that answers from the scenario, as the preview installs it in the browser.
function adapter(scenario) {
  return async (path, init = {}) => {
    const answer = scenario.respond({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(init.body) : null });
    return { ok: answer.status < 300, status: answer.status, async json() { return answer.json; } };
  };
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
  first.respond({ method: 'DELETE', path: `${ROUTINES}/${'a'.repeat(32)}`, body: { code: '123456' } });
  const untouched = second.respond({ method: 'GET', path: ROUTINES }).json;
  assert.equal(untouched.routines.length, 2);
  assert.notEqual(untouched.routines[0].quote, 'changed');
  assert.equal(first.respond({ method: 'GET', path: ROUTINES }).json.routines.length, 1);
});

test('a recurring chat request creates its Routine directly with a created notice and no card', () => {
  const scenario = createScenario('ready');
  const frame = (message) => ({ type: 'chat', message, files: [], assistant_ids: [], timezone: 'America/Sao_Paulo' });
  const [once] = scenario.chat.message(frame('List my DNS zones now'));
  assert.equal(Object.hasOwn(once, 'routine_proposal'), false);
  assert.deepEqual(scenario.respond({ method: 'GET', path: ROUTINES }).json.routines, []);
  scenario.chat.message(frame('Every day at 9, check my certificates'));
  scenario.chat.message(frame('Every Monday, list my DNS zones'));
  const { routines } = scenario.respond({ method: 'GET', path: ROUTINES }).json;
  assert.equal(routines.length, 2);
  assert.notEqual(routines[0].routine_id, routines[1].routine_id);
  assert.equal(routines[0].timezone, 'America/Sao_Paulo');
  const { entries } = scenario.respond({ method: 'GET', path: '/api/teams/marketing/chat/history' }).json;
  const notices = entries.map(parseRoutineRunEntry);
  assert.deepEqual(notices.map((notice) => notice.outcome), ['created', 'created']);
  assert.equal(notices[0].quote, 'Every day at 9, check my certificates');
  // There is no confirmation or preview route any more.
  assert.equal(scenario.respond({ method: 'POST', path: ROUTINES, body: {} }), null);
});

test('runs are stopped by id, a paused Routine resumes, and the chat socket answers a sync', () => {
  const scenario = createScenario('routines');
  const stop = scenario.respond({ method: 'POST', path: `${ROUTINES}/runs/${'f'.repeat(32)}/stop`, body: {} });
  assert.equal(stop.json.stopped, true);
  assert.deepEqual(scenario.respond({ method: 'GET', path: ROUTINES }).json.runs, []);
  // The retired release of an uncertain run stays absent.
  assert.equal(scenario.respond({ method: 'POST', path: `${ROUTINES}/runs/${'b'.repeat(32)}/resolve`, body: {} }), null);
  const listed = scenario.respond({ method: 'GET', path: ROUTINES }).json;
  assert.equal(listed.incidents.length, 1);
  assert.equal(listed.routines[0].paused, true);
  const resumed = scenario.respond({ method: 'POST', path: `${ROUTINES}/${'a'.repeat(32)}/resume`, body: {} });
  assert.equal(resumed.json.paused, false);
  assert.equal(scenario.respond({ method: 'GET', path: ROUTINES }).json.routines[0].paused, false);
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
    assert.equal(parsed.locale, 'pt');
    assert.ok(parsed.purpose);
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
  for (const [name, kind] of [
    ['human-request', 'input:password'],
    ['human-approval', 'input:choice'],
    ['human-confirm', 'approval'],
  ]) {
    const scenario = createScenario(name);
    const [challenge] = scenario.chat.message({ type: 'chat', message: 'News', files: [], assistant_ids: [], locale: 'en' });
    const parsed = parseChatEvent(challenge, 'marketing', 'Marketing');
    const inventory = scenario.respond({ method: 'GET', path: '/api/teams/marketing/assistants' }).json.assistants;
    assert.equal(parsed.type, 'human-required', name);
    assert.equal(parsed.request.kind, kind, name);
    assert.ok(inventory.some((entry) => entry.assistant === parsed.assistant.id), name);
  }
  // The Stored Input purpose was written in Portuguese, so an English challenge carries none.
  const [stored] = createScenario('human-request').chat.message({
    type: 'chat', message: 'News', files: [], assistant_ids: [], locale: 'en',
  });
  assert.equal(parseChatEvent(stored, 'marketing', 'Marketing').purpose, undefined);
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

test('the human-approval scenario renders its copy in the turn language and keeps canonical option values', () => {
  const scenario = createScenario('human-approval');
  const ask = (locale) => scenario.chat.message({
    type: 'chat', message: 'Publish my DNS changes', files: [], assistant_ids: [], locale,
  })[0];
  const portuguese = parseChatEvent(ask('pt'), 'marketing', 'Marketing');
  assert.equal(portuguese.locale, 'pt');
  assert.equal(displayedHumanRequest(portuguese).title, 'Alterações de DNS a publicar: 3. Zona: example.com.');
  const japanese = parseChatEvent(ask('ja'), 'marketing', 'Marketing');
  assert.equal(japanese.locale, 'ja');
  assert.equal(displayedHumanRequest(japanese).title, 'DNS changes to publish: 3. Zone: example.com.');
  assert.deepEqual(portuguese.request, japanese.request);
  // A sync reopens the pending request in the language it names, as Team does (ADR-0091).
  const [reopened] = scenario.chat.message({ type: 'sync', locale: 'pt' });
  assert.equal(parseChatEvent(reopened, 'marketing', 'Marketing').locale, 'pt');
  assert.deepEqual(displayedHumanRequest(portuguese).options.map((option) => option.value), ['proxied', 'dns-only']);
  const [done] = scenario.chat.message({
    type: 'human-response', challenge_id: portuguese.challenge_id, decision: 'submit', value: 'dns-only',
  });
  assert.match(parseChatEvent(done, 'marketing', 'Marketing').reply, /dns-only/u);
  assert.deepEqual(scenario.chat.message({ type: 'sync', locale: 'pt' }), [{ type: 'sync-empty' }]);
  const inventory = scenario.respond({ method: 'GET', path: '/api/teams/marketing/assistants' }).json.assistants;
  assert.ok(inventory.some((entry) => entry.assistant === portuguese.assistant.id));
});

test('the Routine lifecycle preview holds only rows, views, cards, and details the real parsers admit', async () => {
  const scenario = createScenario('routine-lifecycle');
  const { entries } = scenario.respond({ method: 'GET', path: '/api/teams/marketing/chat/history' }).json;
  const outcomes = entries.map((entry) => parseRoutineRunEntry(entry).outcome);
  for (const outcome of ['created', 'changed', 'done', 'healthy', 'recovered', 'user-skipped', 'failed', 'held', 'paused']) {
    assert.ok(outcomes.includes(outcome), outcome);
  }
  const listed = await listRoutines(adapter(scenario), 'marketing');
  assert.ok(listed.routines.some((routine) => routine.schedule.kind === 'continuous'));
  assert.ok(listed.routines.some((routine) => routine.paused));
  const [held, paused] = listed.incidents;
  const card = await openRoutineCard(adapter(scenario), 'marketing', held.incident_id);
  assert.equal(card.recommended, 'verify');
  assert.equal((await openRoutineCard(adapter(scenario), 'marketing', paused.incident_id)).recommended, 'pause');
  // Verify walks through every unresolved verdict; Skip settles the held run.
  const verdicts = [];
  for (let index = 0; index < 5; index += 1) {
    const fresh = await openRoutineCard(adapter(scenario), 'marketing', held.incident_id);
    verdicts.push((await answerRoutineCard(adapter(scenario), 'marketing', held.incident_id, fresh, 'verify')).verdict);
  }
  assert.deepEqual(verdicts, ['inconclusive', 'policy', 'unquiesced', 'unclassified', 'exhausted']);
  await answerRoutineCard(adapter(scenario), 'marketing', held.incident_id, card, 'skip');
  assert.equal((await listRoutines(adapter(scenario), 'marketing')).incidents.length, 1);
  const failed = entries.find((entry) => entry.outcome === 'failed');
  assert.equal((await readRunDiagnostics(adapter(scenario), 'marketing', failed.run_id)).length, 3);
});

test('the daily-cap preview asks its question, then creates the continuous Routine the answer names', () => {
  const scenario = createScenario('routine-cap', 'pt');
  const frame = (message) => ({ type: 'chat', message, files: [], assistant_ids: [], timezone: 'America/Sao_Paulo' });
  const [asked] = scenario.chat.message(frame('Fique conferindo meus registros DNS sem parar'));
  const event = parseChatEvent(asked, 'marketing', 'Marketing');
  assert.equal(event.clarification.options.length, 3);
  assert.equal(asked.reply, renderClarification(event.clarification));
  const [done] = scenario.chat.message(frame(
    'Fique conferindo meus registros DNS sem parar\n\nPergunta: Qual limite diário de execuções você prefere?\nResposta: Até 500 execuções por dia',
  ));
  assert.equal(done.clarification, null);
  const { routines } = scenario.respond({ method: 'GET', path: ROUTINES }).json;
  assert.deepEqual(routines.map((routine) => routine.schedule), [{ kind: 'continuous', gap: 5, cap: 500 }]);
  const { entries } = scenario.respond({ method: 'GET', path: '/api/teams/marketing/chat/history' }).json;
  assert.equal(parseRoutineRunEntry(entries.at(-1)).detail.schedule.cap, 500);
});

test("every locale's Routine preview names and asks in that language, through the real parsers", async () => {
  for (const locale of Object.keys(ROUTINE_TEXT)) {
    const scenario = createScenario('routine-lifecycle', locale);
    const { routines } = await listRoutines(adapter(scenario), 'marketing');
    assert.deepEqual(routines.map((routine) => routine.name), ROUTINE_TEXT[locale].names, locale);
    assert.deepEqual(routines.map((routine) => routine.quote), ROUTINE_TEXT[locale].quotes, locale);
    const { entries } = scenario.respond({ method: 'GET', path: '/api/teams/marketing/chat/history' }).json;
    for (const entry of entries) assert.ok(ROUTINE_TEXT[locale].quotes.includes(parseRoutineRunEntry(entry).quote), locale);
    const asking = createScenario('routine-cap', locale);
    const [asked] = asking.chat.message({ type: 'chat', message: ROUTINE_TEXT[locale].quotes[0], files: [], assistant_ids: [] });
    const { clarification } = parseChatEvent(asked, 'marketing', 'Marketing');
    assert.equal(clarification.question, ROUTINE_TEXT[locale].capQuestion, locale);
    const [created] = asking.chat.message({
      type: 'chat', message: `${ROUTINE_TEXT[locale].quotes[0]}\n\nQ: ${clarification.question}\nA: ${clarification.options[1].label}`,
      files: [], assistant_ids: [],
    });
    assert.equal(created.clarification, null, locale);
    assert.equal(asking.respond({ method: 'GET', path: ROUTINES }).json.routines[0].schedule.cap, 500, locale);
  }
});

test('the attachment previews hold only uploads, replies, and approvals the real parsers admit', async () => {
  const scenario = createScenario('attachments', 'pt');
  const fetcher = async (path, init) => {
    const file = init.body.get('file');
    const answer = scenario.respond({
      method: init.method,
      path,
      body: { file: { name: file.name, type: file.type, size: file.size } },
    });
    return { ok: answer.status < 300, status: answer.status, async json() { return answer.json; } };
  };
  const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown; charset=utf-8' });
  const stored = await uploadTeamFile(fetcher, 'marketing', notes);
  assert.equal(stored.media_type, 'text/markdown');
  const second = await uploadTeamFile(fetcher, 'marketing', new File(['x'], 'raw', { type: '' }));
  assert.equal(second.media_type, 'application/octet-stream');
  assert.notEqual(second.id, stored.id);
  await assert.rejects(uploadTeamFile(fetcher, 'marketing', new File(['x'], 'bad.refused')), { reason: 'invalid' });
  assert.equal(scenario.respond({ method: 'POST', path: '/api/teams/marketing/files', body: null }).status, 400);

  const frame = (message) => ({ type: 'chat', message, files: [stored.id], assistant_ids: [], locale: 'pt' });
  const [reply] = scenario.chat.message(frame('Quando o contrato renova?'));
  assert.equal(parseChatEvent(reply, 'marketing', 'Marketing').restricted_actions.total, 3);
  const [guidance] = scenario.chat.message(frame('Instale o Assistant do WhatsApp'));
  const parsed = parseChatEvent(guidance, 'marketing', 'Marketing');
  assert.equal(parsed.code, 'assistant-lifecycle-attachments');
  assert.match(parsed.reply, /sem anexos/);

  const full = createScenario('attachments-full');
  await assert.rejects(
    uploadTeamFile(async (path, init) => {
      const answer = full.respond({ method: init.method, path, body: { file: { name: 'a.md', type: '', size: 1 } } });
      return { ok: false, status: answer.status, async json() { return answer.json; } };
    }, 'marketing', notes),
    { reason: 'quota' },
  );

  for (const locale of ['en', 'pt']) {
    const approval = createScenario('attachment-approval', locale);
    const [challenge] = approval.chat.message({ type: 'chat', message: 'Upload', files: [], assistant_ids: [], locale });
    assert.equal(parseChatEvent(challenge, 'marketing', 'Marketing').file.name, 'Contract.pdf');
    const [done] = approval.chat.message({ type: 'human-response', decision: 'submit' });
    assert.match(done.reply, /Contract\.pdf/);
  }
});

test('the preview confirms a Routine deletion with a password and a code, and refuses the wrong ones', () => {
  const scenario = createScenario('routines');
  const routine = `${ROUTINES}/${'a'.repeat(32)}`;
  assert.deepEqual(scenario.respond({ method: 'POST', path: `${routine}/deletion`, body: { password: 'wrong password' } }), {
    status: 401,
    json: { code: 'password-incorrect' },
  });
  assert.deepEqual(scenario.respond({ method: 'POST', path: `${routine}/deletion`, body: { password: 'any other' } }), {
    status: 202,
    json: { methods: ['totp'] },
  });
  assert.equal(scenario.respond({ method: 'DELETE', path: routine, body: { code: '000000' } }).json.code, 'code-incorrect');
  assert.equal(scenario.respond({ method: 'DELETE', path: routine }).json.code, 'authentication-expired');
  assert.equal(scenario.respond({ method: 'GET', path: ROUTINES }).json.routines.length, 2);
  assert.equal(scenario.respond({ method: 'DELETE', path: routine, body: { code: '123456' } }).json.deleted, true);
  assert.equal(scenario.respond({ method: 'GET', path: ROUTINES }).json.routines.length, 1);
});
