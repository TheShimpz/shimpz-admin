import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadTeamFile } from '../src/lib/chat/attachments/files.js';
import { renderClarification } from '../src/lib/chat/clarification.js';
import { displayedHumanRequest, parseChatEvent } from '../src/lib/chat/protocol.js';
import {
  answerRoutineCard,
  confirmRoutineProposal,
  listRoutines,
  openRoutineCard,
  pageBinding,
  parseRoutineRunEntry,
  readPlanSteps,
  readRunDiagnostics,
  readRunSteps,
  revokeRoutineProposal,
  runBinding,
} from '../src/lib/routines/protocol.js';
import { failureCause, questionWords, refusalWords } from '../src/lib/routines/words.js';
import { messages } from '../src/lib/i18n/catalogs.js';
import { listLocalAssistantSnapshots, listPublicAssistantCatalog } from '../src/lib/assistants/api.js';
import { loadAssistantDetails, loadLocalAssistantDetails, loadLocalAssistantSummary } from '../src/lib/assistants/preview.js';
import { CLARIFICATION, createScenario, SCENARIOS } from '../e2e/scenarios.js';
import { ROUTINE_TEXT, routineLifecycleStart } from '../e2e/routineScenarios.js';
import { via } from './socketStub.js';

// Each interface language's own catalog of this copy.
const routineMessages = Object.fromEntries(Object.entries(messages).map(([code, catalog]) => [code, catalog.routine]));

const ROUTINE = 'a'.repeat(32);

// A session socket read answered from the scenario, as the preview's socket answers it (ADR-0114).
function reader(scenario) {
  return async (method, params) => {
    const answer = scenario.call(method, params);
    return { ok: answer.status < 300, status: answer.status, async json() { return answer.json; } };
  };
}

test('a scenario answers only what it declares and fails closed otherwise', () => {
  for (const name of SCENARIOS) {
    const scenario = createScenario(name);
    assert.equal(scenario.respond({ method: 'POST', path: '/api/session' }).status, 200);
    assert.equal(scenario.respond({ method: 'GET', path: '/api/space/reset' }), null);
    assert.equal(scenario.call('space.reset', {}), null);
  }
  assert.equal(createScenario('setup').call('teams.list', {}), null);
  assert.equal(createScenario('empty').call('routines.list', { team_id: 'marketing' }), null);
  assert.throws(() => createScenario('production'), /unknown scenario/);
});

test('scenarios never share state, and a caller cannot mutate one through a response', () => {
  const first = createScenario('routines');
  const second = createScenario('routines');
  first.call('routines.list', { team_id: 'marketing' }).json.routines[0].name = 'changed';
  first.call('routines.delete', { team_id: 'marketing', routine_id: ROUTINE, body: { code: '123456' } });
  const untouched = second.call('routines.list', { team_id: 'marketing' }).json;
  assert.equal(untouched.routines.length, 2);
  assert.notEqual(untouched.routines[0].name, 'changed');
  assert.equal(first.call('routines.list', { team_id: 'marketing' }).json.routines.length, 1);
});

test('a recording turn carries the Cloudflare card; Criar rotina creates its Routine and Cancelar creates nothing', async () => {
  const scenario = createScenario('routine-card', 'pt');
  const frame = (message) => ({ type: 'chat', message, files: [], assistant_ids: [], timezone: 'America/Sao_Paulo' });
  const [first] = scenario.chat.message(frame(ROUTINE_TEXT.pt.request));
  const card = parseChatEvent(first, 'marketing', 'Marketing').routine_proposal;
  assert.equal(card.name, ROUTINE_TEXT.pt.card);
  assert.deepEqual(card.schedule, { kind: 'continuous', gap: 30, cap: 2880 });
  assert.deepEqual(card.steps.map((step) => step.action), ['list-zones', 'list-dns-records']);
  assert.deepEqual(card.steps[1].inputs[0].where, { member: 'name', value_json: '"shimpz.com"' });
  assert.equal(card.steps[1].inputs[0].item, '/id');
  // Nothing is created until the person confirms.
  assert.deepEqual(scenario.call('routines.list', { team_id: 'marketing' }).json.routines, []);
  assert.deepEqual(await confirmRoutineProposal(reader(scenario), 'marketing', card.proposal_id), {
    status: 'created',
    routineId: scenario.call('routines.list', { team_id: 'marketing' }).json.routines[0].routine_id,
  });
  const [routine] = (await listRoutines(reader(scenario), 'marketing')).routines;
  assert.equal(routine.name, card.name);
  // A used card answers once; a second confirmation is refused as expired.
  await assert.rejects(
    confirmRoutineProposal(reader(scenario), 'marketing', card.proposal_id),
    (error) => error.code === 'routine-proposal-expired',
  );
  const [second] = scenario.chat.message(frame(ROUTINE_TEXT.pt.request));
  const revoked = parseChatEvent(second, 'marketing', 'Marketing').routine_proposal;
  assert.equal((await revokeRoutineProposal(reader(scenario), 'marketing', revoked.proposal_id)).status, 'revoked');
  assert.equal((await listRoutines(reader(scenario), 'marketing')).routines.length, 1);
  // The transcript keeps each card with its reply, and the created notice names the Routine.
  const { entries } = scenario.call('history.page', { team_id: 'marketing' }).json;
  assert.equal(entries.filter((entry) => entry.routine_proposal).length, 2);
  const created = entries.filter((entry) => entry.kind === 'routine-run').map(parseRoutineRunEntry);
  assert.deepEqual(created.map((notice) => [notice.outcome, notice.name]), [['created', card.name]]);
  // A plain message in another scenario creates nothing and carries no card.
  const plain = createScenario('ready');
  const [reply] = plain.chat.message(frame('Every day at 9, list my DNS zones'));
  assert.equal(Object.hasOwn(reply, 'routine_proposal'), false);
  assert.deepEqual(plain.call('routines.list', { team_id: 'marketing' }).json.routines, []);
});

test("a refused recording says in the person's language that no Routine was created", () => {
  for (const locale of Object.keys(ROUTINE_TEXT)) {
    const scenario = createScenario('routine-refusal', locale);
    const [reply] = scenario.chat.message({ type: 'chat', message: ROUTINE_TEXT[locale].refusalRequest, files: [], assistant_ids: [] });
    const { routine_refusal: refusal } = parseChatEvent(reply, 'marketing', 'Marketing');
    assert.equal(refusalWords(refusal, routineMessages[locale].proposal), routineMessages[locale].proposal.refusals.secret, locale);
    assert.deepEqual(scenario.call('routines.list', { team_id: 'marketing' }).json.routines, [], locale);
  }
});

test("a question scenario asks Team's question in every language and answers the next send with the card", () => {
  for (const name of ['routine-question', 'routine-output', 'routine-ambiguous', 'routine-exact-target']) {
    for (const locale of Object.keys(ROUTINE_TEXT)) {
      const scenario = createScenario(name, locale);
      const send = (message) => scenario.chat.message({ type: 'chat', message, files: [], assistant_ids: [] })[0];
      const asked = parseChatEvent(send(ROUTINE_TEXT[locale].request), 'marketing', 'Marketing');
      const words = questionWords(asked.routine_question, routineMessages[locale].proposal.questions);
      assert.ok(words.question.length > 0, `${name} ${locale}`);
      // A target question is answered only by an option's exact JSON text; a schedule question by any words.
      const answer = words.answers.at(-1).text;
      if (asked.routine_question.options.length > 0) {
        const unmatched = parseChatEvent(send('Q: x\nA: shimpz.com'), 'marketing', 'Marketing');
        assert.equal(Object.hasOwn(unmatched, 'routine_question'), true, `${name} ${locale}`);
      }
      const answered = parseChatEvent(send(`Q: x\nA: ${answer}`), 'marketing', 'Marketing');
      assert.equal(Object.hasOwn(answered, 'routine_proposal'), true, `${name} ${locale}`);
    }
  }
});

test('a paused Routine resumes and pauses again, and the chat socket answers a sync', () => {
  const scenario = createScenario('routines');
  const listed = scenario.call('routines.list', { team_id: 'marketing' }).json;
  assert.equal(listed.incidents.length, 1);
  assert.equal(listed.routines[0].state, 'paused');
  const resumed = scenario.call('routines.resume', { team_id: 'marketing', routine_id: ROUTINE });
  assert.equal(resumed.json.paused, false);
  assert.equal(scenario.call('routines.list', { team_id: 'marketing' }).json.routines[0].state, 'active');
  assert.equal(scenario.call('routines.pause', { team_id: 'marketing', routine_id: ROUTINE }).json.paused, true);
  assert.equal(scenario.call('routines.list', { team_id: 'marketing' }).json.routines[0].state, 'paused');
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
    assert.match(parsed.help, /^Uma chave que permite/);
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
    ['approval-input', 'approval'],
  ]) {
    const scenario = createScenario(name);
    const [challenge] = scenario.chat.message({ type: 'chat', message: 'News', files: [], assistant_ids: [], locale: 'en' });
    const parsed = parseChatEvent(challenge, 'marketing', 'Marketing');
    const inventory = scenario.call('assistants.list', { team_id: 'marketing' }).json.assistants;
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
  const ids = () => scenario.call('teams.list', {}).json.teams.map((team) => team.team_id);
  const put = (body) => scenario.call('teams.reorder', { body });
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
  const order = (scenario) => scenario.call('teams.list', {}).json.teams.map((team) => team.team_id);
  const reversed = order(unavailable).reverse();
  assert.equal(unavailable.call('teams.reorder', { body: { team_ids: reversed } }).status, 503);
  assert.equal(unavailable.call('teams.reorder', { body: { team_ids: reversed } }).status, 200);

  const conflict = createScenario('reorder-conflict');
  const before = order(conflict);
  assert.equal(conflict.call('teams.reorder', { body: { team_ids: before } }).status, 409);
  assert.deepEqual(order(conflict), ['oracle', ...before]);
  assert.equal(conflict.call('teams.reorder', { body: { team_ids: order(conflict) } }).status, 200);
});

test('every listed Team answers its read-only views, and an unlisted one fails closed', () => {
  const scenario = createScenario('ready');
  for (const method of [
    'history.page',
    'routines.list',
    'assistants.list',
    'inference.read',
    'integrations.list',
    'stored_inputs.list',
  ]) {
    assert.equal(scenario.call(method, { team_id: 'neo' }).status, 200, method);
    assert.equal(scenario.call(method, { team_id: 'oracle' }), null, method);
  }
  assert.equal(scenario.respond({ method: 'GET', path: '/api/teams/neo/unknown' }), null);
  assert.equal(scenario.call('routines.resume', { team_id: 'neo', routine_id: ROUTINE }), null);
});

test('every listed Team answers its chat with a reply the parser admits, and an unlisted one never attaches', () => {
  const scenario = createScenario('ready');
  assert.equal(scenario.attachable('neo'), true);
  assert.equal(scenario.attachable('marketing'), true);
  assert.equal(scenario.attachable('oracle'), false);
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
  const inventory = scenario.call('assistants.list', { team_id: 'marketing' }).json.assistants;
  assert.ok(inventory.some((entry) => entry.assistant === portuguese.assistant.id));
});

test('the Routine lifecycle preview holds only rows, views, cards, and details the real parsers admit', async () => {
  const scenario = createScenario('routine-lifecycle');
  const entries = routineLifecycleStart('en').history;
  const outcomes = entries.map((entry) => parseRoutineRunEntry(entry).outcome);
  // The chat's view of them holds only each Routine's creation.
  const chat = scenario.call('history.page', { team_id: 'marketing' }).json.entries;
  assert.ok(chat.length > 0);
  assert.ok(chat.every((entry) => parseRoutineRunEntry(entry).outcome === 'created'));
  for (const outcome of ['created', 'changed', 'done', 'healthy', 'recovered', 'user-skipped', 'failed', 'held', 'paused', 'deleted']) {
    assert.ok(outcomes.includes(outcome), outcome);
  }
  // Every row is titled by the name Team froze into it; the deleted Routine's notice is the last row and still names it.
  const notices = entries.map(parseRoutineRunEntry);
  assert.deepEqual([notices.at(-1).outcome, notices.at(-1).name], ['deleted', ROUTINE_TEXT.en.names[4]]);
  // Runs report their usage with and without a model, and one run says it lost its secret-value protection.
  assert.ok(notices.some((notice) => notice.usage?.models.length === 0));
  assert.ok(notices.some((notice) => notice.usage?.models.length > 0));
  assert.ok(notices.some((notice) => notice.protectionLost));
  const listed = await listRoutines(reader(scenario), 'marketing');
  assert.ok(listed.routines.some((routine) => routine.schedule.kind === 'continuous'));
  assert.ok(listed.routines.some((routine) => routine.state === 'paused'));
  const [held, paused] = listed.incidents;
  // The weekly Routine's update hit a Cloudflare account out of credits; the card shows it as a likely credits cause.
  const card = await openRoutineCard(reader(scenario), 'marketing', held.incident_id);
  assert.deepEqual(card.choices, ['run', 'delete']);
  assert.deepEqual([card.evidence, failureCause(card.diagnostic)], ['recorded', 'credits']);
  assert.equal(failureCause((await openRoutineCard(reader(scenario), 'marketing', paused.incident_id)).diagnostic), 'auth');
  // Rodar sets the weekly one's held run aside.
  assert.equal((await answerRoutineCard(reader(scenario), 'marketing', held.incident_id, card, 'run')).status, 'requested');
  assert.equal((await listRoutines(reader(scenario), 'marketing')).incidents.length, 1);
  const rows = scenario.call('history.page', { team_id: 'marketing', routine: held.routine_id }).json.entries;
  const setAside = parseRoutineRunEntry(rows.find((entry) => entry.run_id === held.incident_id));
  assert.deepEqual([setAside.outcome, setAside.detail.choice], ['user-skipped', 'run']);
  const failed = entries.find((entry) => entry.outcome === 'failed');
  assert.equal((await readRunDiagnostics(reader(scenario), 'marketing', failed.run_id)).length, 3);
  // Every listed Routine's steps read page by page for its own revision; the 120-step watch takes two pages, and a
  // revision that is no longer current is refused.
  for (const routine of listed.routines) {
    const pages = [await readPlanSteps(reader(scenario), 'marketing', routine.routine_id, routine.plan, 0)];
    while (pages.at(-1).next !== null) {
      pages.push(await readPlanSteps(reader(scenario), 'marketing', routine.routine_id, routine.plan, pages.at(-1).next));
    }
    assert.equal(pages.flatMap((page) => page.steps).length, routine.plan.steps);
  }
  assert.ok(listed.routines.some((routine) => routine.plan.steps === 120));
  const [watch] = listed.routines;
  await assert.rejects(
    readPlanSteps(reader(scenario), 'marketing', watch.routine_id, { ...watch.plan, revision: 2 }, 0),
    (error) => error.code === 'routine-revision-changed',
  );
  // Runs with and without a shown result, and a failed run whose notice names no plan, have their own step records,
  // of one snapshot; another snapshot was changed since.
  const recorded = entries.filter((item) => item.detail.output?.state === 'shown' || ['c'.repeat(32), failed.run_id].includes(item.run_id));
  assert.equal(recorded.length, 4);
  for (const entry of recorded) {
    const binding = runBinding(entry.routine_id, entry.detail.plan ?? null);
    const page = await readRunSteps(reader(scenario), 'marketing', entry.run_id, binding, 'latest', 0);
    const bound = pageBinding(page);
    assert.equal(page.steps.length, Math.min(64, page.total));
    assert.deepEqual(await readRunSteps(reader(scenario), 'marketing', entry.run_id, bound, page.snapshot, 0), page);
    await assert.rejects(
      readRunSteps(reader(scenario), 'marketing', entry.run_id, bound, 'e'.repeat(32), 0),
      (error) => error.code === 'routine-run-changed',
    );
  }
});

test('the Routine lifecycle preview spans the day before it opened and that day, oldest first', () => {
  const { history } = routineLifecycleStart('pt', Date.parse('2026-10-03T15:00:00.400Z'));
  const instants = history.map((entry) => Date.parse(entry.created_at));
  assert.deepEqual(instants, [...instants].sort((left, right) => left - right));
  assert.deepEqual(history.map((entry) => entry.created_at.slice(0, 10)), [
    ...Array(6).fill('2026-10-02'),
    ...Array(5).fill('2026-10-03'),
  ]);
  for (const entry of history) assert.equal(parseRoutineRunEntry(entry).createdAt, entry.created_at);
});

test("every locale's Routine preview names its Routines and its card in that language, through the real parsers", async () => {
  for (const locale of Object.keys(ROUTINE_TEXT)) {
    const scenario = createScenario('routine-lifecycle', locale);
    const { routines } = await listRoutines(reader(scenario), 'marketing');
    assert.deepEqual(routines.map((routine) => routine.name), ROUTINE_TEXT[locale].names.slice(0, 4), locale);
    for (const entry of routineLifecycleStart(locale).history) {
      assert.ok(ROUTINE_TEXT[locale].names.includes(parseRoutineRunEntry(entry).name), locale);
    }
    const recording = createScenario('routine-card', locale);
    const [reply] = recording.chat.message({ type: 'chat', message: ROUTINE_TEXT[locale].request, files: [], assistant_ids: [] });
    assert.equal(parseChatEvent(reply, 'marketing', 'Marketing').routine_proposal.name, ROUTINE_TEXT[locale].card, locale);
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
  const routine = { team_id: 'marketing', routine_id: ROUTINE };
  assert.deepEqual(scenario.call('routines.deletion', { ...routine, body: { password: 'wrong password' } }), {
    status: 401,
    json: { code: 'password-incorrect' },
  });
  assert.deepEqual(scenario.call('routines.deletion', { ...routine, body: { password: 'any other' } }), {
    status: 202,
    json: { methods: ['totp'] },
  });
  assert.equal(scenario.call('routines.delete', { ...routine, body: { code: '000000' } }).json.code, 'code-incorrect');
  assert.equal(scenario.call('routines.delete', { ...routine, body: {} }).json.code, 'authentication-expired');
  assert.equal(scenario.call('routines.list', { team_id: 'marketing' }).json.routines.length, 2);
  assert.equal(scenario.call('routines.delete', { ...routine, body: { code: '123456' } }).json.deleted, true);
  assert.equal(scenario.call('routines.list', { team_id: 'marketing' }).json.routines.length, 1);
});

test("the catalog scenario's Assistants and pages pass Admin's own admission in each language", async () => {
  const scenario = createScenario('catalog');
  const socket = reader(scenario);
  const snapshots = await via(socket, () => listLocalAssistantSnapshots());
  assert.equal(snapshots.length, 4);
  assert.deepEqual(await via(socket, () => listPublicAssistantCatalog('pt')), []);
  for (const locale of ['en', 'pt', 'ja']) {
    for (const snapshot of snapshots) {
      const page = await via(socket, () => loadLocalAssistantDetails(snapshot.image_id, snapshot.assistant_id, locale));
      assert.equal(page.summary, await via(socket, () => loadLocalAssistantSummary(snapshot.image_id, locale)));
    }
    for (const assistant of ['shimpz-cloudflare', 'shimpz-exa']) {
      const page = await via(socket, () => loadAssistantDetails('marketing', assistant, locale));
      assert.equal(page.assistant_id, assistant);
    }
  }
  assert.equal(scenario.call('snapshots.details', { image_id: `sha256:${'f'.repeat(64)}`, locale: 'en' }), null);
  assert.equal(scenario.call('assistants.details', { team_id: 'marketing', assistant_id: 'meta-ads', locale: 'en' }), null);
});

