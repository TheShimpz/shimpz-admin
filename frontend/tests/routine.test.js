import assert from 'node:assert/strict';
import test from 'node:test';

import { clockTime } from '../src/lib/chatDays.js';
import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import { LocalApiError } from '../src/lib/localApi.js';
import {
  answerRoutineCard,
  failureCause,
  answerRoutineChallenge,
  browserTimezone,
  beginRoutineDeletion,
  deleteRoutine,
  fillRoutineCopy,
  instantWords,
  isSchedule,
  isTimezone,
  listRoutines,
  openRoutineCard,
  openRoutineChallenge,
  newerRoutineEntries,
  parseIncidentView,
  parseRoutineRunEntry,
  parseRoutineView,
  isPlanStep,
  isRunStep,
  isSummary,
  isDisposition,
  isOutput,
  dispositionWords,
  omittedWords,
  outputScalarWords,
  outputLabels,
  outputTable,
  parseRunView,
  parseRoutineProposal,
  parseRoutineRefusal,
  parseRoutineQuestion,
  questionTarget,
  questionWords,
  QUESTION_CODES,
  isZoned,
  dailyCap,
  continuousCap,
  displayZone,
  refusalWords,
  proposalInputWords,
  confirmRoutineProposal,
  revokeRoutineProposal,
  attemptWords,
  runPosition,
  pauseRoutine,
  pointerWords,
  humanizeId,
  inputWords,
  literalWords,
  routineStatus,
  STATUS_TAGS,
  STATUS_WORDS,
  clockWords,
  fillParts,
  untilWords,
  readRunDiagnostics,
  resumeRoutine,
  resumeRoutineIntegrations,
  RoutineError,
  routineErrorMessage,
  routineNotice,
  scheduleWords,
  stepChain,
  summaryChain,
  needsPage,
  readPlanSteps,
  readRunSteps,
  pageBinding,
  runBinding,
} from '../src/lib/routine.js';
import { routineMessages } from '../src/lib/routineMessages.js';

const WEEKLY = { kind: 'weekly', weekday: 0, time: '09:00' };

test('mirrors the schedule and timezone grammar', () => {
  for (const schedule of [
    { kind: 'hourly', every: 1 },
    { kind: 'hourly', every: 24 },
    { kind: 'daily', time: '23:59' },
    { kind: 'weekly', weekday: 6, time: '00:00' },
    { kind: 'monthly', day: 28, time: '12:30' },
    { kind: 'continuous', gap: 5, cap: 17280 },
    { kind: 'continuous', gap: 30, cap: 2880 },
    { kind: 'continuous', gap: 86400, cap: 1 },
  ]) {
    assert.equal(isSchedule(schedule), true, JSON.stringify(schedule));
  }
  for (const schedule of [
    null,
    'daily',
    { kind: 'yearly', time: '09:00' },
    { kind: 'hourly', every: 25 },
    { kind: 'hourly', every: 0 },
    { kind: 'daily', time: '24:00' },
    { kind: 'daily', time: 900 },
    { kind: 'weekly', weekday: 7, time: '09:00' },
    { kind: 'monthly', day: 29, time: '09:00' },
    { kind: 'daily', time: '09:00', extra: 1 },
    { kind: 'continuous', gap: 4, cap: 10 },
    { kind: 'continuous', gap: 86401, cap: 10 },
    { kind: 'continuous', gap: 5, cap: 0 },
    { kind: 'continuous', gap: 5, cap: 1001 },
    { kind: 'continuous', gap: 30, cap: 1000 },
    { kind: 'continuous', gap: 5, cap: 17281 },
    { kind: 'continuous', gap: 5.5, cap: 10 },
    { kind: 'continuous', gap: 5 },
  ]) {
    assert.equal(isSchedule(schedule), false, JSON.stringify(schedule));
  }
  assert.equal(isTimezone('America/Argentina/Buenos_Aires'), true);
  assert.equal(isTimezone('UTC'), true);
  assert.equal(isTimezone('../etc'), false);
  assert.equal(isTimezone(null), false);
});

// The confirmation card Team's golden vectors carry: the owner's Cloudflare watch, its zone chosen by name.
const PROPOSAL = Object.freeze({
  proposal_id: '1'.repeat(32),
  expires_at: '2026-10-05T12:16:07Z',
  replaces: null,
  name: 'DNS de shimpz.com',
  schedule: { kind: 'continuous', gap: 30, cap: 2880 },
  timezone: 'America/Sao_Paulo',
  timezone_source: 'browser',
  next_runs: ['2026-10-05T12:01:37Z', '2026-10-05T12:02:07Z', '2026-10-05T12:02:37Z'],
  daily_cap: 2880,
  output: { mode: 'show' },
  steps: [
    { position: 1, assistant: 'shimpz-cloudflare', action: 'list-zones', read_only: true, inputs: [] },
    {
      position: 2,
      assistant: 'shimpz-cloudflare',
      action: 'list-dns-records',
      read_only: true,
      inputs: [{
        member: 'zone_id', origin: 'selector', value: null, step: 1, pointer: '/result',
        where: { member: 'name', value_json: '"shimpz.com"' }, item: '/id',
      }],
    },
  ],
  permitted: [
    { assistant: 'shimpz-cloudflare', action: 'list-dns-records', read_only: true },
    { assistant: 'shimpz-cloudflare', action: 'list-zones', read_only: true },
  ],
});

test("a recording turn's reply and its stored history carry at most one Routine card or refusal, never beside a question", async () => {
  const done = {
    type: 'done',
    team_id: 'team_1',
    team_name: 'Marketing',
    reply: 'Pronto: confiro o DNS de shimpz.com.',
    clarification: null,
  };
  assert.equal(Object.hasOwn(parseChatEvent(done, 'team_1', 'Marketing'), 'routine_proposal'), false);
  assert.deepEqual(parseChatEvent({ ...done, routine_proposal: PROPOSAL }, 'team_1', 'Marketing').routine_proposal, PROPOSAL);
  const refusal = { code: 'routine-secret-literal' };
  assert.deepEqual(parseChatEvent({ ...done, routine_refusal: refusal }, 'team_1', 'Marketing').routine_refusal, refusal);
  const question = { question: 'Qual zona?', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], default_index: 0 };
  for (const invalid of [
    { ...done, routine_proposal: null },
    { ...done, routine_proposal: { ...PROPOSAL, extra: 1 } },
    { ...done, routine_refusal: { code: 'Not A Code' } },
    { ...done, routine_proposal: PROPOSAL, routine_refusal: refusal },
    { ...done, routine_proposal: PROPOSAL, clarification: question },
  ]) {
    assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'));
  }

  const turn = 'b'.repeat(32);
  const reply = {
    id: `${turn}:reply`,
    created_at: '2026-10-02T21:15:00Z',
    kind: 'message',
    role: 'assistant',
    text: done.reply,
    author: 'Marketing',
  };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  assert.equal((await listChatHistory(page([reply]), 'marketing')).entries[0].text, done.reply);
  assert.deepEqual((await listChatHistory(page([{ ...reply, routine_proposal: PROPOSAL }]), 'marketing')).entries[0].routine_proposal, PROPOSAL);
  assert.deepEqual((await listChatHistory(page([{ ...reply, routine_refusal: refusal }]), 'marketing')).entries[0].routine_refusal, refusal);
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: null }]), 'marketing'));
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: PROPOSAL, routine_refusal: refusal }]), 'marketing'));
  // What Team asks before a card travels and reloads the same way, never beside a card, a refusal, or a clarification.
  const asked = { code: 'routine-schedule-unstated', options: [], value: null };
  assert.deepEqual(parseChatEvent({ ...done, routine_question: asked }, 'team_1', 'Marketing').routine_question, asked);
  assert.deepEqual((await listChatHistory(page([{ ...reply, routine_question: asked }]), 'marketing')).entries[0].routine_question, asked);
  for (const invalid of [
    { ...done, routine_question: asked, routine_refusal: refusal },
    { ...done, routine_question: asked, clarification: question },
    { ...done, routine_question: { ...asked, value: 30 } },
  ]) {
    assert.throws(() => parseChatEvent(invalid, 'team_1', 'Marketing'));
  }
});

test("every interface language offers exactly the Team protocol's output choices, in its order", async () => {
  const { readFileSync } = await import('node:fs');
  // The protocol mirror is the authority (ADR-0101): Team reads the chosen label back to its choice.
  const source = readFileSync(new URL('../../backend/protocol/http/v1/routine_proposal.py', import.meta.url), 'utf8');
  const kinds = [...source.match(/OUTPUT_KINDS = \(([^)]*)\)/u)[1].matchAll(/"([a-z]+)"/gu)].map(([, kind]) => kind);
  const block = source.match(/OUTPUT_CHOICES = \{\n([\s\S]*?)\n\}/u)[1];
  const protocol = {};
  for (const [, locale, body] of block.matchAll(/"([a-z]{2})": \{([^}]*)\}/gu)) {
    protocol[locale] = Object.fromEntries([...body.matchAll(/"([a-z]+)": "((?:[^"\\]|\\.)*)"/gu)].map(([, kind, label]) => [kind, label]));
  }
  assert.deepEqual(kinds, ['show', 'changes', 'none', 'chain']);
  assert.deepEqual(Object.keys(protocol).sort(), Object.keys(routineMessages).sort());
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    assert.deepEqual(catalog.proposal.questions.output.answers, kinds.map((kind) => protocol[locale][kind]), locale);
  }
});

test('a Routine question is admitted only in its closed form and reads as facts with answers in every locale', () => {
  // Each option carries its target's exact JSON text: a string with its quotes, an integer with every digit.
  const target = (text, label = 'shimpz.com') => ({ value: text, label });
  const quoted = (value) => JSON.stringify(value);
  const huge = '12345678901234567890';
  const valid = [
    { code: 'routine-schedule-unstated', options: [], value: null },
    { code: 'routine-interval-over-budget', options: [], value: 9 },
    { code: 'routine-binding-ambiguous', options: [target(quoted('a'.repeat(32))), target(quoted('b'.repeat(32)))], value: null },
    { code: 'routine-binding-ambiguous', options: [target('42', null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target(quoted(huge), null), target(huge, null)], value: null },
    ...QUESTION_CODES.filter((code) => !['routine-interval-over-budget'].includes(code))
      .map((code) => ({ code, options: [], value: null })),
  ];
  for (const value of valid) assert.deepEqual(parseRoutineQuestion(structuredClone(value)), value);
  for (const invalid of [
    null,
    { code: 'routine-other', options: [], value: null },
    { code: 'routine-no-room', options: [], value: null },
    { code: 'routine-timezone-unstated', options: [], value: null },
    { code: 'routine-timezone-ambiguous', options: [], value: null },
    { code: 'routine-schedule-unstated', options: [target(quoted('a'))], value: null },
    { code: 'routine-schedule-unstated', options: [], value: 9 },
    { code: 'routine-interval-over-budget', options: [], value: 4 },
    { code: 'routine-interval-over-budget', options: [], value: null },
    { code: 'routine-binding-ambiguous', options: [target(quoted('a')), target(quoted('a'))], value: null },
    { code: 'routine-binding-ambiguous', options: Array.from({ length: 9 }, (_, index) => target(quoted(`v${index}`))), value: null },
    { code: 'routine-binding-ambiguous', options: [{ value: quoted('a') }], value: null },
    { code: 'routine-binding-ambiguous', options: [target(42, null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target('a')], value: null },
    { code: 'routine-binding-ambiguous', options: [target('"a"x')], value: null },
    { code: 'routine-binding-ambiguous', options: [target('1.5', null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target('01', null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target('true', null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target('"\\u0061"')], value: null },
    { code: 'routine-binding-ambiguous', options: [target(quoted('a\u0000b'))], value: null },
    { code: 'routine-binding-ambiguous', options: [target('9'.repeat(121), null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target('', null)], value: null },
    { code: 'routine-binding-ambiguous', options: [target(quoted('a'), '')], value: null },
    { code: 'routine-schedule-unstated', options: [], value: null, extra: 1 },
  ]) {
    assert.throws(() => parseRoutineQuestion(invalid), RoutineError);
  }
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    const copy = catalog.proposal;
    for (const value of valid) {
      const words = questionWords(value, copy);
      assert.ok(words.question.length > 0 && !/\{/u.test(words.question), `${locale} ${value.code}`);
      assert.ok(words.answers.every((answer) => answer.label.length > 0 && !/\{/u.test(answer.label)), `${locale} ${value.code}`);
    }
    const schedule = copy.questions.schedule.answers;
    assert.deepEqual(questionWords(valid[0], copy).answers, schedule.map((answer) => ({ label: answer, text: answer })));
  }
  const en = routineMessages.en.proposal;
  // A person reads each target's label; the answer sends its exact JSON text, the only form Team matches.
  assert.deepEqual(questionWords(valid[2], en).answers, [
    { label: `shimpz.com (${'a'.repeat(32)})`, text: quoted('a'.repeat(32)) },
    { label: `shimpz.com (${'b'.repeat(32)})`, text: quoted('b'.repeat(32)) },
  ]);
  assert.deepEqual(questionWords(valid[3], en).answers, [{ label: '42', text: '42' }]);
  // A string and an integer of the same digits stay two answers, and no digit of the integer is rounded.
  assert.deepEqual(questionWords(valid[4], en).answers.map((answer) => answer.text), [quoted(huge), huge]);
  assert.equal(questionTarget(huge).shown, huge);
  assert.equal(questionTarget(quoted(huge)).kind, 'string');
  // What each run does with its result is answered with exactly the Team protocol's four labels, in its order.
  const output = questionWords({ code: 'routine-output-unstated', options: [], value: null }, en);
  assert.deepEqual(output.answers.map((answer) => answer.text), [
    'Show every run', 'Show only when it changes', "Don't show", 'Use it in other Actions',
  ]);
  const budget = questionWords(valid[1], en);
  assert.match(budget.question, /\b9\b/u);
  assert.deepEqual(budget.answers, [{ label: 'Every 9 seconds', text: 'Every 9 seconds' }]);
});

test("a Routine's cap is its gap's whole day and UTC stands in when no timezone was given", () => {
  assert.equal(continuousCap(5), 17280);
  assert.equal(continuousCap(30), 2880);
  assert.equal(continuousCap(86400), 1);
  assert.equal(dailyCap({ kind: 'continuous', gap: 30, cap: 2880 }), 2880);
  assert.equal(dailyCap({ kind: 'hourly', every: 5 }), 5);
  assert.equal(dailyCap({ kind: 'weekly', weekday: 0, time: '09:00' }), 1);
  assert.equal(isZoned('America/Sao_Paulo', 'browser'), true);
  assert.equal(isZoned('Europe/Paris', 'person'), true);
  assert.equal(isZoned('UTC', 'none'), true);
  for (const [zone, source] of [['America/Sao_Paulo', 'none'], ['UTC', 'guess'], ['../etc', 'browser']]) {
    assert.equal(isZoned(zone, source), false);
  }
  // With no timezone given, instants show in the UTC the Routine actually runs in.
  assert.equal(displayZone({ timezone: 'UTC', timezone_source: 'none' }), 'UTC');
  assert.equal(displayZone({ timezone: 'America/Sao_Paulo', timezone_source: 'browser' }), 'America/Sao_Paulo');
  // A card whose cap is not its schedule's is refused.
  assert.throws(() => parseRoutineProposal({ ...PROPOSAL, daily_cap: 1000 }), RoutineError);
  assert.throws(() => parseRoutineProposal({ ...PROPOSAL, clamped: false }), RoutineError);
  // A calendar schedule and a run date both run in UTC when no timezone was given.
  const clocked = { ...PROPOSAL.steps[0], inputs: [{ member: 'day', origin: 'clock', value: null, step: null, pointer: null, where: null, item: null }] };
  const daily = { ...PROPOSAL, schedule: { kind: 'daily', time: '09:00' }, daily_cap: 1, timezone: 'UTC', timezone_source: 'none' };
  assert.equal(parseRoutineProposal({ ...daily, steps: [clocked, PROPOSAL.steps[1]] }).timezone_source, 'none');
  assert.equal(parseRoutineProposal({ ...PROPOSAL, timezone: 'UTC', timezone_source: 'none' }).timezone_source, 'none');
});

test('a Routine card is admitted only whole, and its inputs say where each value comes from', () => {
  assert.deepEqual(parseRoutineProposal(structuredClone(PROPOSAL)), PROPOSAL);
  // A step that changes something reads like any other: the card names it.
  const changing = {
    ...PROPOSAL,
    steps: [PROPOSAL.steps[0], { ...PROPOSAL.steps[1], read_only: false }],
    permitted: [{ ...PROPOSAL.permitted[0], read_only: false }, PROPOSAL.permitted[1]],
  };
  assert.equal(parseRoutineProposal(changing).steps[1].read_only, false);
  // The permitted Actions are exactly the steps' Actions with their effect: none extra, none missing, none other.
  for (const permitted of [
    [...PROPOSAL.permitted, { assistant: 'shimpz-cloudflare', action: 'purge-cache', read_only: false }],
    PROPOSAL.permitted.slice(1),
    [{ ...PROPOSAL.permitted[0], read_only: false }, PROPOSAL.permitted[1]],
    [],
  ]) {
    assert.throws(() => parseRoutineProposal({ ...PROPOSAL, permitted }), RoutineError, JSON.stringify(permitted));
  }
  // The output takes only a closed mode and its own members, and every plan runs a step.
  for (const invalid of [
    { ...PROPOSAL, output: { mode: 'other' } },
    { ...PROPOSAL, output: { ...PROPOSAL.output, extra: null } },
    { ...PROPOSAL, steps: [], permitted: [] },
  ]) {
    assert.throws(() => parseRoutineProposal(invalid), RoutineError, JSON.stringify(invalid));
  }
  for (const invalid of [
    { ...PROPOSAL, extra: 1 },
    { ...PROPOSAL, next_runs: [] },
    { ...PROPOSAL, next_runs: [PROPOSAL.next_runs[1], PROPOSAL.next_runs[0]] },
    { ...PROPOSAL, daily_cap: 1001 },
    { ...PROPOSAL, name: ' padded ' },
    { ...PROPOSAL, output: { mode: 'show', step: 2 } },
    { ...PROPOSAL, permitted: [...PROPOSAL.permitted].reverse() },
    { ...PROPOSAL, steps: [{ ...PROPOSAL.steps[0], position: 2 }] },
    { ...PROPOSAL, steps: [PROPOSAL.steps[0], { ...PROPOSAL.steps[1], inputs: [{ ...PROPOSAL.steps[1].inputs[0], where: null }] }] },
    {
      ...PROPOSAL,
      steps: [{
        ...PROPOSAL.steps[0],
        inputs: [{ member: 'page', origin: 'request', value: 'a‮b', step: null, pointer: null, where: null, item: null }],
      }, PROPOSAL.steps[1]],
    },
  ]) {
    assert.throws(() => parseRoutineProposal(invalid), RoutineError, JSON.stringify(invalid).slice(0, 100));
  }
  const copy = routineMessages.pt;
  const input = (changes) => ({ member: 'x', value: null, step: null, pointer: null, where: null, item: null, ...changes });
  const selector = proposalInputWords(PROPOSAL.steps[1].inputs[0], copy.proposal, copy.plan);
  assert.equal(selector.value, 'result › id');
  assert.match(selector.origin, /shimpz\.com/u);
  assert.deepEqual(
    proposalInputWords(input({ origin: 'request', value: '"50"' }), copy.proposal, copy.plan),
    { value: '50', origin: copy.proposal.origins.request },
  );
  assert.equal(proposalInputWords(input({ origin: 'clock' }), copy.proposal, copy.plan).origin, copy.proposal.origins.clock);
  const fromStep = proposalInputWords(input({ origin: 'step', step: 1, pointer: '/result/0/id' }), copy.proposal, copy.plan);
  assert.equal(fromStep.value, 'result › primeiro › id');
  // Every documented refusal has its own sentence; a plan code reads as the plan's, any other code as the generic one.
  assert.equal(refusalWords(parseRoutineRefusal({ code: 'routine-secret-literal' }), copy.proposal), copy.proposal.refusals.secret);
  assert.equal(refusalWords({ code: 'plan-input-type' }, copy.proposal), copy.proposal.refusals.plan);
  assert.equal(refusalWords({ code: 'routine-something-new' }, copy.proposal), copy.proposal.refusals.generic);
  for (const code of ['routine-recording-cyclic', 'routine-recording-conflict', 'routine-recording-unverified']) {
    assert.equal(refusalWords({ code }, copy.proposal), copy.proposal.refusals.unverified);
  }
  assert.equal(refusalWords({ code: 'routine-recording-ambiguous' }, copy.proposal), copy.proposal.refusals.ambiguous);
  assert.throws(() => parseRoutineRefusal({ code: 'x', extra: 1 }), RoutineError);
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    for (const words of Object.values(catalog.proposal.refusals)) assert.ok(words.length > 0, locale);
    assert.ok(catalog.proposal.confirm && catalog.proposal.cancel && catalog.proposal.confirm !== catalog.proposal.cancel, locale);
  }
  assert.equal(routineMessages.pt.proposal.confirm, 'Criar rotina');
  assert.equal(routineMessages.pt.proposal.cancel, 'Cancelar');
});

test('Criar rotina confirms and Cancelar revokes exactly one card', async () => {
  const proposalId = PROPOSAL.proposal_id;
  const path = `/api/teams/team_1/routines/proposals/${proposalId}`;
  const routineId = 'a'.repeat(32);
  let api = fetcher([[200, { team_id: 'team_1', proposal_id: proposalId, routine_id: routineId, status: 'created' }]]);
  assert.deepEqual(await confirmRoutineProposal(api.fetch, 'team_1', proposalId), { status: 'created', routineId });
  assert.equal(api.calls[0].path, path);
  assert.equal(api.calls[0].init.method, 'POST');
  assert.equal(api.calls[0].init.body, '{}');
  api = fetcher([[200, { team_id: 'team_1', proposal_id: proposalId, routine_id: null, status: 'revoked' }]]);
  assert.deepEqual(await revokeRoutineProposal(api.fetch, 'team_1', proposalId), { status: 'revoked', routineId: null });
  assert.equal(api.calls[0].path, path);
  assert.equal(api.calls[0].init.method, 'DELETE');
  assert.equal(api.calls[0].init.body, undefined);
  for (const [call, body] of [
    [confirmRoutineProposal, { team_id: 'team_1', proposal_id: proposalId, routine_id: null, status: 'revoked' }],
    [confirmRoutineProposal, { team_id: 'team_2', proposal_id: proposalId, routine_id: routineId, status: 'created' }],
    [revokeRoutineProposal, { team_id: 'team_1', proposal_id: proposalId, routine_id: routineId, status: 'revoked' }],
    [revokeRoutineProposal, { team_id: 'team_1', proposal_id: 'f'.repeat(32), routine_id: null, status: 'revoked' }],
  ]) {
    await assert.rejects(call(fetcher([[200, body]]).fetch, 'team_1', proposalId), (error) => error.code === 'routine-response-invalid');
  }
  await assert.rejects(
    confirmRoutineProposal(fetcher([[409, { code: 'routine-proposal-expired' }]]).fetch, 'team_1', proposalId),
    (error) => error.code === 'routine-proposal-expired' &&
      routineErrorMessage(error, routineMessages.pt.errors) === routineMessages.pt.errors.proposalExpired,
  );
  await assert.rejects(confirmRoutineProposal(fetcher([]).fetch, 'team_1', '../x'), (error) => error.code === 'routine-request-invalid');
});

// A revision's projected steps, read page by page, each named by its 1-based position (ADR-0092, 2026-10-05, scale).
const PLAN = [
    {
      position: 1,
      assistant: 'shimpz-cloudflare',
      action: 'list-zones',
      read_only: true,
      inputs: [{ member: 'page', source: 'literal', value: '1' }],
      stored_inputs: ['api-token'],
    },
  ];
const DIGEST = `sha256:${'d'.repeat(64)}`;
// The summary every list view and notice carries instead of the steps.
const SUMMARY = Object.freeze({ revision: 1, plan_digest: DIGEST, steps: 1, actions: [['shimpz-cloudflare', 'list-zones', 1]], more: 0 });
const ROUTINE = {
  routine_id: 'a'.repeat(32),
  name: 'DNS semanal',
  plan: SUMMARY,
  output: { mode: 'show', step: 1 },
  schedule: WEEKLY,
  timezone: 'America/Sao_Paulo',
  timezone_source: 'browser',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-05T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  state: 'active',
  permitted: { total: 1, changes: 0 },
};
const LEASED = {
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
const FROZEN = {
  ...LEASED, status: 'frozen', request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'list-zones',
  position: { phase: 'replay', step: 1 }, steps: 1,
};
const HELD = { ...LEASED, status: 'held' };
// One recorded handled failure of a held step, in Team's sanitized diagnostic view (ADR-0092 section 8).
const ATTEMPT_FAILURE = Object.freeze({
  operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
  attempt: 1,
  assistant_id: 'shimpz-cloudflare',
  action: 'list-zones',
  position: { phase: 'replay', step: 1 },
  recorded_at: '2026-10-05T12:01:05Z',
  failure: Object.freeze({
    error_type: 'httpx.HTTPStatusError',
    message: "Client error '402 Payment Required'",
    provider: 'api.cloudflare.com',
    http_status: 402,
    response_excerpt: '{"success":false}',
    redacted: false,
    truncated: false,
  }),
  condition: null,
});

const INCIDENT = {
  incident_id: 'b'.repeat(32),
  routine_id: ROUTINE.routine_id,
  name: 'DNS semanal',
  created_at: '2026-10-05T12:01:07Z',
  assistant_id: 'shimpz-cloudflare',
  action: 'replace-dns-record',
  position: { phase: 'replay', step: 2 },
  steps: 3,
};
const UNPLACED = Object.freeze({ assistant_id: null, action: null, position: null, steps: null });

test('Routines and runs are admitted only in their closed views', () => {
  assert.deepEqual(parseRoutineView(ROUTINE), ROUTINE);
  assert.deepEqual(parseRoutineView({ ...ROUTINE, state: 'paused' }), { ...ROUTINE, state: 'paused' });
  const { state: _state, ...stateless } = ROUTINE;
  for (const invalid of [
    { ...ROUTINE, extra: 1 },
    { ...ROUTINE, deleting: 'no' },
    { ...ROUTINE, assistant_ids: ['Bad'] },
    { ...ROUTINE, state: 'running' },
    stateless,
    { ...ROUTINE, output: { mode: 'show', step: 1, extra: null } },
    { ...ROUTINE, output: { mode: 'other', step: null } },
    { ...ROUTINE, plan: { ...SUMMARY, steps: 0, actions: [] }, output: { mode: 'none', step: null } },
    { ...ROUTINE, permitted: { total: 1, changes: 2 } },
    { ...ROUTINE, permitted: { total: 0, changes: 0 } },
    { ...ROUTINE, permitted: { total: 257, changes: 0 } },
    // A Routine view carries its summary, never its steps, and shows a step by its position.
    { ...Object.fromEntries(Object.entries(ROUTINE).filter(([key]) => key !== 'plan')), steps: PLAN },
    { ...ROUTINE, output: { mode: 'show', step: 2 } },
    { ...ROUTINE, output: { mode: 'show', step: 'zones' } },
  ]) {
    assert.throws(() => parseRoutineView(invalid), RoutineError, JSON.stringify(invalid));
  }
  for (const run of [LEASED, FROZEN, HELD]) assert.deepEqual(parseRunView(run), run);
  for (const invalid of [
    { ...LEASED, status: 'running' },
    { ...LEASED, extra: null },
    { ...LEASED, request_kind: 'human' },
    { ...HELD, assistant_id: 'shimpz-cloudflare' },
    { ...FROZEN, action: null },
    { ...FROZEN, position: null },
    { ...FROZEN, position: { phase: 'other', step: 1 } },
    { ...FROZEN, request_kind: 'email' },
  ]) {
    assert.throws(() => parseRunView(invalid), RoutineError, JSON.stringify(invalid));
  }
  for (const incident of [INCIDENT, { ...INCIDENT, ...UNPLACED }]) {
    assert.deepEqual(parseIncidentView(incident), incident);
  }
  for (const invalid of [
    { ...INCIDENT, assistant_id: null },
    { ...INCIDENT, position: { phase: 'replay', step: 4 } },
    { ...INCIDENT, position: null },
    { ...INCIDENT, step: 2 },
    { ...INCIDENT, ...UNPLACED, steps: 3 },
    { ...INCIDENT, steps: 257, position: { phase: 'replay', step: 1 } },
    { ...INCIDENT, name: '' },
    { ...INCIDENT, extra: 'x' },
    { ...INCIDENT, created_at: '2026-10-05' },
    { ...INCIDENT, status: 'unresolved' },
  ]) {
    assert.throws(() => parseIncidentView(invalid), RoutineError, JSON.stringify(invalid));
  }
});

function fetcher(responses) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push({ path, init });
    const [status, body] = responses.shift();
    return { ok: status < 300, status, async json() { return body; } };
  };
  return { fetch, calls };
}

test('Routine requests go to exact Admin routes and admit only exact answers', async () => {
  let api = fetcher([[200, { team_id: 'team_1', routines: [ROUTINE], runs: [FROZEN], incidents: [INCIDENT] }]]);
  assert.deepEqual(await listRoutines(api.fetch, 'team_1'), { routines: [ROUTINE], runs: [FROZEN], incidents: [INCIDENT] });
  assert.equal(api.calls[0].init.headers['Content-Type'], undefined);

  const CODE = { code: '123456' };
  api = fetcher([[200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, deleted: true }]]);
  assert.deepEqual(await deleteRoutine(api.fetch, 'team_1', ROUTINE.routine_id, CODE), { deleted: true });
  await assert.rejects(
    deleteRoutine(fetcher([[200, { team_id: 'team_1', routine_id: 'f'.repeat(32), deleted: true }]]).fetch, 'team_1', ROUTINE.routine_id, CODE),
    (error) => error.code === 'routine-response-invalid',
  );
  assert.equal(api.calls[0].init.method, 'DELETE');
  assert.equal(api.calls[0].init.body, JSON.stringify(CODE));

  api = fetcher([[200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, paused: false }]]);
  assert.equal(await resumeRoutine(api.fetch, 'team_1', ROUTINE.routine_id), false);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/${ROUTINE.routine_id}/resume`);

  const empty = { team_id: 'team_1', routines: [], runs: [], incidents: [] };
  for (const [call, responses] of [
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, team_id: 'team_2' }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, routines: Array(9).fill(ROUTINE) }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, incidents: Array(33).fill(INCIDENT) }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { team_id: 'team_1', routines: [], runs: [] }]]],
    [(f) => resumeRoutine(f, 'team_1', ROUTINE.routine_id), [[200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, paused: true }]]],
  ]) {
    await assert.rejects(call(fetcher(responses).fetch), (error) => error.code === 'routine-response-invalid');
  }
  await assert.rejects(
    deleteRoutine(fetcher([[409, { code: 'routine-busy' }]]).fetch, 'team_1', ROUTINE.routine_id, CODE),
    (error) => error.code === 'routine-busy' && error.status === 409,
  );
  await assert.rejects(
    deleteRoutine(fetcher([[500, { code: 'Not Safe' }]]).fetch, 'team_1', ROUTINE.routine_id, CODE),
    (error) => error.code === 'routine-request-failed',
  );
  for (const refused of [
    () => listRoutines(null, 'team_1'),
    () => listRoutines(fetcher([]).fetch, 'Team 1'),
    () => deleteRoutine(fetcher([]).fetch, 'team_1', '../x', CODE),
    () => deleteRoutine(fetcher([]).fetch, 'team_1', ROUTINE.routine_id),
    () => deleteRoutine(fetcher([]).fetch, 'team_1', ROUTINE.routine_id, { code: '12345' }),
    () => deleteRoutine(fetcher([]).fetch, 'team_1', ROUTINE.routine_id, { code: '123456', credential: {} }),
    () => beginRoutineDeletion(fetcher([]).fetch, 'team_1', ROUTINE.routine_id, ''),
    () => resumeRoutine(fetcher([]).fetch, 'team_1', 'x'),
    () => openRoutineCard(fetcher([]).fetch, 'team_1', 'x'),
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'approve'),
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'x' }, 'run'),
    // Excluir is the confirmed deletion, never a card answer.
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'delete'),
  ]) {
    await assert.rejects(refused(), (error) => error.code === 'routine-request-invalid');
  }
});

test('schedules, instants, and failures read naturally in each locale', () => {
  const words = routineMessages.en.schedule;
  assert.equal(scheduleWords({ kind: 'hourly', every: 1 }, words, 'en'), 'Every hour');
  assert.equal(scheduleWords({ kind: 'hourly', every: 6 }, words, 'en'), 'Every 6 hours');
  assert.equal(scheduleWords({ kind: 'daily', time: '09:00' }, words, 'en'), 'Every day at 09:00');
  assert.equal(scheduleWords({ kind: 'weekly', weekday: 0, time: '09:00' }, words, 'en'), 'Every Monday at 09:00');
  // Portuguese weekdays take their own article: Todo sábado and Todo domingo, Toda segunda-feira.
  assert.equal(scheduleWords({ kind: 'weekly', weekday: 6, time: '09:00' }, routineMessages.pt.schedule, 'pt'), 'Todo domingo às 09:00');
  assert.equal(scheduleWords({ kind: 'weekly', weekday: 0, time: '09:00' }, routineMessages.pt.schedule, 'pt'), 'Toda segunda-feira às 09:00');
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      assert.doesNotMatch(scheduleWords({ kind: 'weekly', weekday, time: '09:00' }, catalog.schedule, locale), /\{|undefined/, locale);
    }
  }
  assert.equal(scheduleWords({ kind: 'monthly', day: 28, time: '18:30' }, words, 'en'), 'On day 28 of every month at 18:30');
  // A continuous Routine's pause and cap are numbers in the viewer's locale.
  const continuous = { kind: 'continuous', gap: 5, cap: 17280 };
  assert.equal(scheduleWords(continuous, words, 'en'), 'Every 5 s after each run, up to 17,280 a day');
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    assert.doesNotMatch(scheduleWords(continuous, catalog.schedule, locale), /\{/, locale);
  }
  assert.equal(instantWords('2026-10-05T12:00:00Z', 'en', 'America/Sao_Paulo'), 'Oct 5, 2026, 9:00 AM');
  assert.equal(fillRoutineCopy('{a} and {missing}', { a: 1 }), '1 and {missing}');
  const errors = routineMessages.en.errors;
  assert.equal(routineErrorMessage(new RoutineError('routine-rate-limit'), errors), errors.full);
  assert.equal(routineErrorMessage(new RoutineError('team-context-unavailable'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('human-request-invalid'), errors), errors.changed);
  assert.equal(routineErrorMessage(new RoutineError('assistant-language-drift'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('routine-card-expired'), errors), errors.expired);
  assert.equal(routineErrorMessage(new RoutineError('routine-card-stale'), errors), errors.stale);
  assert.equal(routineErrorMessage(new RoutineError('routine-incident-unavailable'), errors), errors.ended);
  for (const [code, key] of [
    ['routine-busy', 'busy'],
    ['routine-workload-unquiesced', 'stillRunning'],
    ['routine-contracts-changed', 'contractsChanged'],
    ['routine-recovery-stopped', 'stopped'],
    ['routine-proposal-expired', 'proposalExpired'],
    ['notices-full', 'unavailable'],
    // A Team's daily step and definition budgets each say their own fact, never the run ceiling's.
    ['routine-step-budget', 'stepBudget'],
    ['routine-team-budget', 'teamBudget'],
    ['routine-too-large', 'tooLarge'],
    ['routine-revision-changed', 'routineChanged'],
    ['routine-run-changed', 'stale'],
  ]) {
    assert.equal(routineErrorMessage(new RoutineError(code), errors), errors[key], code);
  }
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    const budgets = ['routine-step-budget', 'routine-team-budget', 'routine-rate-limit']
      .map((code) => routineErrorMessage(new RoutineError(code), catalog.errors));
    assert.equal(new Set(budgets).size, 3, locale);
    assert.ok(budgets.every((words) => typeof words === 'string' && words.length > 0), locale);
  }
  assert.match(errors.stepBudget, /20,000/u);
  assert.equal(routineErrorMessage(new RoutineError('other'), errors), errors.generic);
  assert.equal(routineErrorMessage(new Error('x'), errors), errors.generic);
  const zone = browserTimezone();
  assert.equal(zone === null || isTimezone(zone), true);
});

const DEFINED = {
  name: 'DNS semanal',
  plan: SUMMARY,
  output: { mode: 'show', step: 1 },
  schedule: WEEKLY,
  timezone: 'America/Sao_Paulo',
  timezone_source: 'browser',
  state: 'active',
  permitted: { total: 1, changes: 0 },
};
// A run that called no model reports only its duration; one whose recovery called a model reports its tokens.
const REPLAY_USAGE = Object.freeze({ duration_ms: 4120, models: [] });
const RUN_ENTRY = {
  id: `${'b'.repeat(32)}:routine`,
  kind: 'routine-run',
  notice_id: 'b'.repeat(32),
  routine_id: 'a'.repeat(32),
  name: 'DNS semanal',
  run_id: 'b'.repeat(32),
  outcome: 'done',
  created_at: '2026-10-05T12:01:07Z',
  detail: { plan: SUMMARY, output: null },
  version: 2,
  usage: REPLAY_USAGE,
  protection_lost: false,
};
const STEP = { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record', position: { phase: 'replay', step: 2 }, steps: 3 };
// A two-step plan's summary, and a 120-step one whose middle Action repeats.
const TWO = Object.freeze({ ...SUMMARY, steps: 2, actions: [['shimpz-cloudflare', 'list-zones', 1], ['shimpz-cloudflare', 'list-dns-records', 1]] });
const LONG = Object.freeze({
  ...SUMMARY,
  steps: 120,
  actions: [['shimpz-cloudflare', 'list-zones', 1], ['shimpz-cloudflare', 'list-dns-records', 118], ['shimpz-cloudflare', 'purge-cache', 1]],
});
// A run's shown result: Team's bounded projection of the zones it listed, one cut, and a value Team redacted.
const SHOWN_OUTPUT = Object.freeze({
  step: 1,
  state: 'shown',
  value: {
    kind: 'fields',
    fields: [
      ['zones', {
        kind: 'list',
        items: [
          { kind: 'fields', fields: [['name', { kind: 'text', value: 'example.com', cut: false }], ['paused', { kind: 'bool', value: false }]], omitted: 0 },
          { kind: 'fields', fields: [['name', { kind: 'text', value: '<b>example.org</b>', cut: false }], ['token', { kind: 'redacted' }]], omitted: 0 },
        ],
        omitted: 2,
      }],
      ['count', { kind: 'number', value: '1234.5' }],
    ],
    omitted: 0,
  },
  truncated: true,
});
const UNSHOWN = Object.freeze({ step: 1, state: 'unavailable', value: null, truncated: false });

test('a Routine transcript row is admitted only in its closed form', async () => {
  assert.deepEqual(parseRoutineRunEntry(RUN_ENTRY), {
    id: RUN_ENTRY.id,
    kind: 'routine-run',
    runId: RUN_ENTRY.run_id,
    routineId: RUN_ENTRY.routine_id,
    name: RUN_ENTRY.name,
    outcome: 'done',
    createdAt: RUN_ENTRY.created_at,
    detail: RUN_ENTRY.detail,
    version: RUN_ENTRY.version,
    usage: REPLAY_USAGE,
    protectionLost: false,
  });
  const valid = [
    { ...RUN_ENTRY, outcome: 'recovered', detail: { plan: LONG, output: { ...UNSHOWN, step: 120 } } },
    { ...RUN_ENTRY, protection_lost: true },
    {
      ...RUN_ENTRY,
      usage: { duration_ms: 9800, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 6500, output_tokens: 300 }] },
    },
    { ...RUN_ENTRY, outcome: 'deleted', run_id: null, usage: null, detail: {} },
    { ...RUN_ENTRY, outcome: 'held', detail: STEP },
    { ...RUN_ENTRY, outcome: 'held', detail: UNPLACED },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'exhausted' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'policy' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...UNPLACED, reason: 'evidence' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { ...STEP, choice: 'run' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { ...UNPLACED, choice: 'delete' } },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, usage: null, notice_id: 'f'.repeat(32), id: `${'f'.repeat(32)}:routine`, detail: { missed: 3 } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, usage: null, detail: { assistants: ['shimpz-cloudflare'] } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 12 } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'human', ...STEP } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']], position: null, steps: null } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'plan-input-type', actions: [], position: { phase: 'replay', step: 37 }, steps: 120 } },
    { ...RUN_ENTRY, outcome: 'denied', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'stopped', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: DEFINED },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: DEFINED },
  ];
  for (const entry of valid) assert.equal(parseRoutineRunEntry(entry).outcome, entry.outcome);
  for (const invalid of [
    null,
    { ...RUN_ENTRY, extra: 1 },
    { ...RUN_ENTRY, kind: 'message' },
    { ...RUN_ENTRY, outcome: 'run' },
    { ...RUN_ENTRY, id: `${'c'.repeat(32)}:routine` },
    { ...RUN_ENTRY, run_id: 'c'.repeat(32) },
    { ...RUN_ENTRY, run_id: null },
    { ...RUN_ENTRY, routine_id: 'x' },
    { ...RUN_ENTRY, notice_id: 'x' },
    // A row's title is only the name Team froze into it.
    { ...RUN_ENTRY, name: ' padded ' },
    { ...RUN_ENTRY, name: null },
    { ...RUN_ENTRY, usage: null },
    { ...RUN_ENTRY, usage: { duration_ms: 1, models: [], extra: 1 } },
    { ...RUN_ENTRY, protection_lost: 'no' },
    { ...RUN_ENTRY, detail: { ...RUN_ENTRY.detail, extra: null } },
    { ...RUN_ENTRY, outcome: 'held', detail: { ...STEP, position: { phase: 'other', step: 2 } } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'email', ...STEP } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, extra: null } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, output: { mode: 'other', step: null } } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, output: { mode: 'show', step: 1, extra: null } } },
    { ...RUN_ENTRY, outcome: 'deleted', run_id: null, usage: null, detail: { name: 'x' } },
    { ...RUN_ENTRY, outcome: 'deleted', run_id: null, usage: REPLAY_USAGE, detail: {} },
    { ...RUN_ENTRY, outcome: 'deleted', run_id: null, usage: null, detail: {}, protection_lost: true },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { ...STEP, choice: 'other' } },
    { ...RUN_ENTRY, created_at: '2026-02-30T12:00:00Z' },
    { ...RUN_ENTRY, version: 0 },
    // A done row carries the summary of the plan it carried out, never a reply or a result.
    { ...RUN_ENTRY, detail: { reply: 'Done.' } },
    { ...RUN_ENTRY, detail: { actions: [['shimpz-cloudflare', 'list-zones']], output: null } },
    { ...RUN_ENTRY, detail: { plan: SUMMARY, output: null, result: { ip: '1.2.3.4' } } },
    { ...RUN_ENTRY, detail: { plan: SUMMARY, output: { ...UNSHOWN, step: 2 } } },
    { ...RUN_ENTRY, detail: { plan: { ...SUMMARY, steps: 2 }, output: null } },
    { ...RUN_ENTRY, detail: { plan: SUMMARY } },
    { ...RUN_ENTRY, outcome: 'needs-input', detail: { question: 'Which zone?' } },
    { ...RUN_ENTRY, outcome: 'held', detail: { ...STEP, action: null } },
    { ...RUN_ENTRY, outcome: 'held', detail: { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' } },
    { ...RUN_ENTRY, outcome: 'held', detail: { ...STEP, position: { phase: 'replay', step: 4 } } },
    { ...RUN_ENTRY, outcome: 'held', detail: { ...STEP, position: 2 } },
    { ...RUN_ENTRY, outcome: 'held', detail: { ...UNPLACED, position: { phase: 'replay', step: 1 } } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'approve' } },
    // A person's skip is a run outcome; it never stands in for the missed-schedule skip.
    { ...RUN_ENTRY, outcome: 'user-skipped', run_id: null, usage: null, detail: STEP },
    // A minute's healthy rollup belongs to the Routine, counts at most what its gaps allow, and names no Actions.
    { ...RUN_ENTRY, outcome: 'healthy', detail: { runs: 2 } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 13 } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 2, actions: [] } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'email', ...STEP } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'human', ...UNPLACED } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'Bad Code', actions: [], position: null, steps: null } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'x', actions: [] } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'x', actions: [], position: { phase: 'replay', step: 1 }, steps: null } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, usage: null, detail: { assistants: [] } },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, usage: null, detail: { missed: 0 } },
    { ...RUN_ENTRY, outcome: 'created', detail: DEFINED },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, plan: { ...SUMMARY, steps: 2 } } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, output: { mode: 'show', step: 2 } } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, plan: undefined, steps: PLAN } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, state: 'stopped' } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, actions: [] } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, name: ' padded ' } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, name: 'x'.repeat(81) } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, schedule: { kind: 'daily' } } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, timezone: '../etc' } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, usage: null, detail: { ...DEFINED, input: { zone: 'example.com' } } },
  ]) {
    assert.throws(() => parseRoutineRunEntry(invalid), RoutineError);
  }
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const own = { routine: RUN_ENTRY.routine_id };
  const history = await listChatHistory(page([RUN_ENTRY]), 'marketing', null, own);
  assert.equal(history.entries[0].kind, 'routine-run');
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, outcome: 'run' }]), 'marketing', null, own));
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, id: `${'b'.repeat(32)}:reply` }]), 'marketing', null, own));
});

test("the chat's view admits only a Routine's creation, and a Routine's view only its own history", async () => {
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const created = { ...RUN_ENTRY, outcome: 'created', run_id: null, usage: null, detail: DEFINED };
  const keyed = (letter) => ({ id: `${letter.repeat(32)}:routine`, notice_id: letter.repeat(32) });
  const missed = { ...RUN_ENTRY, ...keyed('c'), outcome: 'skipped', run_id: null, usage: null, detail: { missed: 2 } };
  const healthy = { ...RUN_ENTRY, ...keyed('d'), outcome: 'healthy', run_id: null, detail: { runs: 2 } };
  const changed = { ...created, outcome: 'changed' };
  assert.equal((await listChatHistory(page([created]), 'marketing')).entries[0].outcome, 'created');
  for (const hidden of [RUN_ENTRY, missed, healthy, changed]) {
    await assert.rejects(listChatHistory(page([hidden]), 'marketing'), LocalApiError, hidden.outcome);
  }
  const own = { routine: RUN_ENTRY.routine_id };
  const runs = await listChatHistory(page([missed, healthy, RUN_ENTRY]), 'marketing', null, own);
  assert.deepEqual(runs.entries.map((entry) => entry.outcome), ['skipped', 'healthy', 'done']);
  for (const foreign of [created, changed, { ...RUN_ENTRY, routine_id: 'c'.repeat(32) }]) {
    await assert.rejects(listChatHistory(page([foreign]), 'marketing', null, own), LocalApiError);
  }
  // The view travels as the Routine id, which must be one; nothing is requested otherwise.
  const requested = [];
  const fetcher = async (url) => { requested.push(url); return page([])(); };
  await listChatHistory(fetcher, 'marketing', 'AAAAAAAAAMg', own);
  assert.deepEqual(requested, [`/api/teams/marketing/chat/history?before=AAAAAAAAAMg&routine=${RUN_ENTRY.routine_id}`]);
  for (const routine of ['A'.repeat(32), '../x', 7]) {
    await assert.rejects(listChatHistory(fetcher, 'marketing', null, { routine }), LocalApiError);
  }
  assert.equal(requested.length, 1);
});

// A notice as the transcript (a creation) or a run opened in full shows it, in Portuguese.
function noticeShown(entry) {
  return routineNotice(parseRoutineRunEntry(entry), { copy: routineMessages.pt, locale: 'pt' });
}

test('a creation and every run read as one line: a status phrase colored by meaning and its time', () => {
  const cases = [
    [{ outcome: 'done', detail: { plan: SUMMARY, output: SHOWN_OUTPUT } }, ['healthy', 'concluída']],
    [{ outcome: 'recovered', detail: { plan: LONG, output: UNSHOWN } }, ['healthy', 'concluída após recuperação']],
    [{ outcome: 'failed', detail: { code: 'plan-input-type', actions: [['shimpz-cloudflare', 'list-zones']], position: { phase: 'replay', step: 37 }, steps: 120 } },
      ['danger', 'falhou']],
    [{ outcome: 'denied', detail: { actions: [] } }, ['danger', 'negada']],
    [{ outcome: 'held', detail: STEP }, ['danger', 'parou com erro']],
    [{ outcome: 'held', detail: UNPLACED }, ['danger', 'parou com erro']],
    [{ outcome: 'paused', detail: { ...STEP, reason: 'exhausted' } }, ['waiting', 'pausada']],
    [{ outcome: 'frozen', detail: { request_kind: 'human', ...STEP } }, ['waiting', 'aguardando aprovação']],
    [{ outcome: 'frozen', detail: { request_kind: 'integrations', ...STEP } }, ['waiting', 'aguardando conexão']],
    [{ outcome: 'stopped', detail: { actions: [['shimpz-cloudflare', 'list-zones']] } }, ['neutral', 'interrompida']],
    [{ outcome: 'user-skipped', detail: { ...STEP, choice: 'delete' } }, ['neutral', 'deixada de lado']],
    [{ outcome: 'created', run_id: null, usage: null, detail: { ...DEFINED, schedule: { kind: 'continuous', gap: 5, cap: 17280 }, plan: TWO } },
      ['neutral', 'criada']],
  ];
  const time = clockTime(Date.parse(RUN_ENTRY.created_at), 'pt');
  // The notice keeps its seconds (created at 12:01:07 UTC).
  assert.match(time, /^\d{2}:01:07$/);
  for (const [change, [tone, status]] of cases) {
    assert.deepEqual(noticeShown({ ...RUN_ENTRY, ...change }), { tone, status, time }, change.outcome);
  }
  // Every shown outcome has its status words in every Admin language.
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    for (const [change] of cases) {
      const shown = routineNotice(parseRoutineRunEntry({ ...RUN_ENTRY, ...change }), { copy: catalog, locale });
      assert.ok(shown.status && !/\{\w+\}/u.test(shown.status), `${locale} ${change.outcome}`);
    }
  }
});

test('a notice names its Assistant once for steps that share it and again only where it changes', () => {
  const name = (id) => ({ a: 'Alpha', b: 'Beta' })[id];
  // A summary's runs read once with their count, then how many steps follow beyond its sixteenth run.
  assert.equal(stepChain([['a', 'list-zones', 1], ['a', 'list-dns-records', 3]], name), 'Alpha · List zones › List DNS records ×3');
  const runs = Array.from({ length: 16 }, (_, index) => ['a', index % 2 ? 'list-dns-records' : 'list-zones', 1]);
  const many = { ...SUMMARY, steps: 256, actions: runs, more: 240 };
  assert.ok(isSummary(many));
  assert.match(summaryChain(many, name, routineMessages.pt.notice, 'pt'), / › mais 240 etapas$/u);
  assert.equal(summaryChain({ ...SUMMARY, actions: [['a', 'list-zones', 1]] }, name, routineMessages.pt.notice, 'pt'), 'Alpha · List zones');
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    assert.doesNotMatch(summaryChain(many, name, catalog.notice, locale), /\{|undefined/u, locale);
  }
  assert.equal(stepChain([['a', 'list-zones']], name), 'Alpha · List zones');
  assert.equal(stepChain([['a', 'list-zones'], ['a', 'list-dns-records']], name), 'Alpha · List zones › List DNS records');
  assert.equal(stepChain([['a', 'list-zones'], ['b', 'search'], ['a', 'update-dns-record']], name),
    'Alpha · List zones › Beta · Search › Alpha · Update DNS record');
  // A value that looks like markup stays the same characters; the transcript renders it as text.
  const hostile = '[x](https://evil.test) <img src=x onerror=alert(1)> **b**';
  assert.equal(stepChain([['a', 'list-zones']], () => hostile), `${hostile} · List zones`);
});

test('a re-read history page yields only Routine rows not yet shown at their version', () => {
  const row = (letter, version) => ({ id: `${letter.repeat(32)}:routine`, kind: 'routine-run', version });
  const message = { id: `${'c'.repeat(32)}:reply`, kind: 'message', role: 'assistant', text: 'Done.' };
  const shown = new Map([[row('a', 2).id, 2], [row('b', 1).id, 1]]);
  const page = [row('a', 2), message, row('b', 3), row('d', 1)];
  // An unchanged row and every other kind of entry stay as they are; a newer version and a new row come in page order.
  assert.deepEqual(newerRoutineEntries(shown, page), [row('b', 3), row('d', 1)]);
  assert.deepEqual(newerRoutineEntries(new Map([[row('b', 1).id, 4]]), [row('b', 3)]), []);
  assert.deepEqual(newerRoutineEntries(new Map(), []), []);
});

test('a frozen run is opened, answered, and resumed only through exact answers', async () => {
  const run = 'd'.repeat(32);
  const challenge = { type: 'human-required', challenge_id: 'b'.repeat(32), locale: 'pt' };
  let api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'human-required', challenge }]]);
  assert.deepEqual(await openRoutineChallenge(api.fetch, 'team_1', run, 'pt', (value) => ({ ...value })), {
    status: 'human-required',
    challenge,
  });
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/runs/${run}/challenge`);
  // Opening names exactly the interface language the request copy renders in (ADR-0091).
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { locale: 'pt' });
  assert.equal(api.calls[0].init.headers['Content-Type'], 'application/json');
  for (const locale of [null, 'pt-BR', 'PT', undefined]) {
    api = fetcher([]);
    await assert.rejects(openRoutineChallenge(api.fetch, 'team_1', run, locale, () => null), RoutineError);
    assert.equal(api.calls.length, 0);
  }
  api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'integrations-required' }]]);
  assert.deepEqual(await openRoutineChallenge(api.fetch, 'team_1', run, 'en', () => null), { status: 'integrations-required' });
  for (const [body, parse] of [
    [{ team_id: 'team_1', run_id: 'e'.repeat(32), status: 'integrations-required' }, () => null],
    [{ team_id: 'team_1', run_id: run, status: 'human-required', challenge }, () => { throw new Error('x'); }],
    [{ team_id: 'team_1', run_id: run, status: 'done' }, () => null],
    // A challenge rendered in another language than the opening named is refused.
    [{ team_id: 'team_1', run_id: run, status: 'human-required', challenge }, (value) => ({ ...value })],
  ]) {
    await assert.rejects(openRoutineChallenge(fetcher([[200, body]]).fetch, 'team_1', run, 'en', parse), RoutineError);
  }

  const frame = { type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'deny' };
  api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'denied' }]]);
  assert.deepEqual(await answerRoutineChallenge(api.fetch, 'team_1', run, frame), { status: 'denied' });
  assert.deepEqual(JSON.parse(api.calls[0].init.body), frame);
  const rejection = { type: 'human-response-rejected', challenge_id: 'b'.repeat(32), reason: 'authentication-denied', attempts_remaining: 2, retry_after: 0 };
  api = fetcher([[409, { code: 'authentication-denied', ...rejection }]]);
  assert.deepEqual(await answerRoutineChallenge(api.fetch, 'team_1', run, frame), { rejection });
  await assert.rejects(
    answerRoutineChallenge(fetcher([[409, { code: 'human-request-expired' }]]).fetch, 'team_1', run, frame),
    (error) => error.code === 'human-request-expired',
  );
  await assert.rejects(
    answerRoutineChallenge(fetcher([[500, { code: 'Not Safe' }]]).fetch, 'team_1', run, frame),
    (error) => error.code === 'routine-request-failed',
  );
  await assert.rejects(
    answerRoutineChallenge(fetcher([[200, { team_id: 'team_1', run_id: run, status: 'running' }]]).fetch, 'team_1', run, frame),
    RoutineError,
  );
  api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'frozen' }]]);
  assert.equal(await resumeRoutineIntegrations(api.fetch, 'team_1', run), 'frozen');
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/runs/${run}/integrations`);
});

test('a Routine plan projection bounds text in Unicode code points, as Team does', () => {
  // Team bounds each projected text by Python len(): a preview of 100 emoji is 102 code points but 202 UTF-16 units.
  const emoji = '\u{1F600}';
  const preview = JSON.stringify(emoji.repeat(100));
  const literal = (value) => ({ ...PLAN[0], inputs: [{ member: 'page', source: 'literal', value }] });
  // Each bound counts the whole string: a preview's JSON quotes, and a pointer's leading slash.
  assert.equal(isPlanStep(literal(JSON.stringify(emoji.repeat(118))), 1), true);
  const step = { ...PLAN[0], inputs: [{ member: emoji.repeat(128), source: 'literal', value: preview }] };
  const later = {
    position: 2,
    assistant: 'shimpz-cloudflare',
    action: 'list-dns-records',
    read_only: true,
    inputs: [{ member: 'zone_id', source: 'step_output', step: 1, pointer: `/${emoji.repeat(255)}`, where: null, item: null }],
    stored_inputs: [],
  };
  assert.equal(isPlanStep(step, 1), true);
  assert.equal(isPlanStep(later, 2), true);
  for (const [value, position] of [
    [literal(JSON.stringify(emoji.repeat(119))), 1],
    [{ ...step, inputs: [{ member: emoji.repeat(129), source: 'literal', value: '1' }] }, 1],
    [{ ...later, inputs: [{ ...later.inputs[0], pointer: `/${emoji.repeat(256)}` }] }, 2],
  ]) {
    assert.equal(isPlanStep(value, position), false, JSON.stringify(value));
  }
});

test('a Routine plan projection is admitted only in its closed, bounded form', () => {
  const step = PLAN[0];
  const later = {
    position: 2,
    assistant: 'shimpz-cloudflare',
    action: 'list-dns-records',
    read_only: true,
    inputs: [
      { member: 'day', source: 'run_clock', value: 'date' },
      { member: 'zone_id', source: 'step_output', step: 1, pointer: '/zones/0/id', where: null, item: null },
    ],
    stored_inputs: [],
  };
  const selected = {
    ...later,
    inputs: [{
      member: 'zone_id', source: 'step_output', step: 1, pointer: '/result', where: { member: 'name', value_json: '"shimpz.com"' }, item: '/id',
    }],
  };
  assert.equal(isPlanStep(selected, 2), true);
  assert.equal(isPlanStep(step, 1), true);
  assert.equal(isPlanStep(later, 2), true);
  // One Action may repeat: a step is named by its position, never by an id (ADR-0092 amendment, 2026-10-05, scale).
  assert.equal(isPlanStep({ ...step, position: 256 }, 256), true);
  for (const [value, position] of [
    [null, 1],
    ['zones', 1],
    [step, 2],
    [{ ...step, position: 257 }, 257],
    [{ ...step, position: 0 }, 0],
    [{ ...step, id: 'zones' }, 1],
    [{ ...step, assistant: 'Bad' }, 1],
    [{ ...step, action: 'Bad action' }, 1],
    [{ ...step, inputs: 'none' }, 1],
    [{ ...step, inputs: [null] }, 1],
    [{ ...step, inputs: [{ member: 'page', source: 'secret', value: '1' }] }, 1],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: '1', extra: true }] }, 1],
    [{ ...step, inputs: [{ member: '', source: 'literal', value: '1' }] }, 1],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: 'x'.repeat(121) }] }, 1],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: 'a‮b' }] }, 1],
    [{ ...step, inputs: [{ member: 'b', source: 'literal', value: '1' }, { member: 'a', source: 'literal', value: '1' }] }, 1],
    [{ ...later, inputs: [{ member: 'day', source: 'run_clock', value: 'weekday' }] }, 2],
    // A reference names an earlier position: never its own, a later one, or an id.
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 2, pointer: '/x', where: null, item: null }] }, 2],
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: '/x', where: null, item: null }] }, 2],
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 1, pointer: 'x', where: null, item: null }] }, 2],
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 1, pointer: 7, where: null, item: null }] }, 2],
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 1, pointer: '/'.repeat(257), where: null, item: null }] }, 2],
    [{ ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 1, pointer: '/​', where: null, item: null }] }, 2],
    [{ ...step, read_only: 'yes' }, 1],
    [{ ...selected, inputs: [{ ...selected.inputs[0], where: { member: 'name', value_json: '"a\u202eb"' } }] }, 2],
    [{ ...selected, inputs: [{ ...selected.inputs[0], where: { member: 'name', value_json: 'true' } }] }, 2],
    [{ ...selected, inputs: [{ ...selected.inputs[0], item: null }] }, 2],
    [{ ...step, stored_inputs: 'api-token' }, 1],
    [{ ...step, stored_inputs: Array(9).fill('a') }, 1],
    [{ ...step, stored_inputs: ['API token'] }, 1],
    [{ ...step, stored_inputs: [7] }, 1],
    [{ ...step, stored_inputs: ['b', 'a'] }, 1],
    // A step's projection over its byte bound is refused whole, never cut.
    [{ ...later, inputs: Array.from({ length: 64 }, (_, index) => ({
      member: `${String(index).padStart(3, '0')}${'m'.repeat(125)}`, source: 'step_output', step: 1, pointer: `/${'"'.repeat(255)}`,
      where: null, item: null,
    })) }, 2],
  ]) {
    assert.equal(isPlanStep(value, position), false, JSON.stringify(value)?.slice(0, 120));
  }
  // A summary's runs cover its steps in order, each differing from the one before; more counts only past sixteen runs.
  assert.ok(isSummary(SUMMARY));
  assert.ok(isSummary(LONG));
  for (const invalid of [
    null,
    // Every plan has at least one step.
    { ...SUMMARY, steps: 0, actions: [] },
    { ...SUMMARY, steps: 2 },
    { ...SUMMARY, revision: 0 },
    { ...SUMMARY, plan_digest: 'sha256:x' },
    { ...SUMMARY, more: 1, steps: 2 },
    { ...SUMMARY, steps: 2, actions: [['shimpz-cloudflare', 'list-zones', 1], ['shimpz-cloudflare', 'list-zones', 1]] },
    { ...SUMMARY, actions: [['shimpz-cloudflare', 'list-zones', 0]], steps: 0 },
    { ...SUMMARY, actions: [['shimpz-cloudflare', 'list-zones']] },
    { ...SUMMARY, actions: [['Bad', 'list-zones', 1]] },
    { ...SUMMARY, steps: 257, actions: [['shimpz-cloudflare', 'list-zones', 257]] },
    { ...SUMMARY, steps: 17, actions: Array.from({ length: 17 }, (_, index) => ['shimpz-cloudflare', index % 2 ? 'b' : 'a', 1]) },
    { ...SUMMARY, extra: 1 },
  ]) {
    assert.equal(isSummary(invalid), false, JSON.stringify(invalid));
  }
  for (const invalid of [{ ...ROUTINE, plan: { ...SUMMARY, steps: 0 } }, { ...ROUTINE, name: ' padded ' }, { ...ROUTINE, name: 'é' }]) {
    assert.throws(() => parseRoutineView(invalid), RoutineError, JSON.stringify(invalid));
  }
});

// A 120-step revision's steps as Team pages them: whole consecutive positions, at most 64 at a time.
function planPage(offset, size, total = 120) {
  const steps = Array.from({ length: size }, (_, index) => ({ ...PLAN[0], position: offset + index + 1 }));
  return {
    routine_id: ROUTINE.routine_id, revision: 1, plan_digest: DIGEST, total, offset, steps,
    next: offset + size === total ? null : offset + size,
  };
}

test("a Routine's steps are read page by page for exactly the revision its summary names", async () => {
  const routineId = ROUTINE.routine_id;
  let api = fetcher([[200, planPage(0, 64)], [200, planPage(64, 56)]]);
  const first = await readPlanSteps(api.fetch, 'team_1', routineId, LONG, 0);
  assert.equal(first.steps.length, 64);
  assert.equal(first.next, 64);
  assert.equal((await readPlanSteps(api.fetch, 'team_1', routineId, LONG, 64)).next, null);
  assert.deepEqual(api.calls.map((call) => call.path), [
    `/api/teams/team_1/routines/${routineId}/revisions/1/steps/0`,
    `/api/teams/team_1/routines/${routineId}/revisions/1/steps/64`,
  ]);
  // A page of another Routine, revision, digest, size, or offset is never combined with this one.
  for (const [body, offset] of [
    [{ ...planPage(0, 64), routine_id: 'c'.repeat(32) }, 0],
    [{ ...planPage(0, 64), revision: 2 }, 0],
    [{ ...planPage(0, 64), plan_digest: `sha256:${'e'.repeat(64)}` }, 0],
    [planPage(0, 64, 121), 0],
    [planPage(0, 64), 64],
    [planPage(0, 65), 0],
    [{ ...planPage(0, 64), next: null }, 0],
    [{ ...planPage(0, 2), steps: [PLAN[0], PLAN[0]] }, 0],
    [{ ...planPage(0, 64), extra: 1 }, 0],
  ]) {
    await assert.rejects(
      readPlanSteps(fetcher([[200, body]]).fetch, 'team_1', routineId, LONG, offset),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  // A revision that is no longer current is refused, so the reader reads the Routine again.
  await assert.rejects(
    readPlanSteps(fetcher([[409, { code: 'routine-revision-changed' }]]).fetch, 'team_1', routineId, LONG, 0),
    (error) => error.code === 'routine-revision-changed' && error.status === 409,
  );
  for (const refused of [
    () => readPlanSteps(fetcher([]).fetch, 'team_1', 'x', LONG, 0),
    () => readPlanSteps(fetcher([]).fetch, 'team_1', routineId, { ...LONG, steps: 0 }, 0),
    () => readPlanSteps(fetcher([]).fetch, 'team_1', routineId, LONG, 256),
    () => readPlanSteps(fetcher([]).fetch, 'team_1', routineId, LONG, -1),
    () => readPlanSteps(fetcher([]).fetch, 'team_1', routineId, LONG, '0'),
  ]) {
    await assert.rejects(refused(), (error) => error.code === 'routine-request-invalid');
  }
  // A reader asks for the next page only while it wants more steps than it has and Team named one.
  assert.equal(needsPage(0, 10, 0), true);
  assert.equal(needsPage(64, 20, 64), false);
  assert.equal(needsPage(64, 70, 64), true);
  assert.equal(needsPage(120, 130, null), false);
});

// A run's own step records as Team pages them (ADR-0092 amendment, 2026-10-05, scale).
const SNAPSHOT = 'c'.repeat(32);
const REPLAY_1 = Object.freeze({ phase: 'replay', step: 1 });
const RECORDED = Object.freeze({
  position: REPLAY_1, status: 'done', assistant_id: 'shimpz-cloudflare', action: 'list-zones', attempt: 1, duration_ms: 812,
  recorded_at: '2026-10-05T12:01:05Z', inputs: [{ member: 'page', source: 'literal', value: '1' }],
});
const GAP = Object.freeze({
  position: { phase: 'replay', step: 2 }, status: 'not_run', assistant_id: null, action: null, attempt: null, duration_ms: null, recorded_at: null, inputs: null,
});

function runPage(offset, steps, { total = 2, snapshot = SNAPSHOT, ended = true } = {}) {
  return {
    team_id: 'team_1', run_id: RUN_ENTRY.run_id, routine_id: ROUTINE.routine_id, revision: 1, plan_digest: DIGEST,
    total, snapshot, ended, offset, steps, next: offset + steps.length === total ? null : offset + steps.length,
  };
}
// A position outside the replay phase, and a record placed there.
const ASTRAY_POSITION = Object.freeze({ phase: 'other', step: 2 });
const ASTRAY = Object.freeze({ ...RECORDED, position: ASTRAY_POSITION });

test("a run's step records are admitted only for its own revision and one snapshot of them", async () => {
  const plan = runBinding(ROUTINE.routine_id, TWO);
  const run = RUN_ENTRY.run_id;
  const steps = [RECORDED, GAP];
  let api = fetcher([[200, runPage(0, steps)], [200, runPage(0, steps)]]);
  // latest admits the snapshot Team names; a later page asks for exactly that snapshot.
  assert.deepEqual((await readRunSteps(api.fetch, 'team_1', run, plan, 'latest', 0)).steps, steps);
  assert.equal((await readRunSteps(api.fetch, 'team_1', run, plan, SNAPSHOT, 0)).snapshot, SNAPSHOT);
  assert.deepEqual(api.calls.map((call) => call.path), [
    `/api/teams/team_1/routines/runs/${run}/steps/latest/0`,
    `/api/teams/team_1/routines/runs/${run}/steps/${SNAPSHOT}/0`,
  ]);
  // A stopped attempt was cut by Stop or the run's deadline; it carries its Action and inputs like a failed one.
  for (const status of ['done', 'failed', 'stopped', 'waiting']) {
    assert.ok(isRunStep({ ...RECORDED, status }, REPLAY_1, 2), status);
  }
  for (const valid of [
    { ...RECORDED, status: 'recovered', duration_ms: null },
    { ...RECORDED, inputs: null },
    { ...RECORDED, inputs: [{ member: 'api_key', source: 'literal', value: null }] },
    { ...GAP, status: 'unavailable' },
  ]) {
    assert.ok(isRunStep(valid, valid.position, 2), JSON.stringify(valid));
  }
  // A run's entries are its replay steps, each at its own position.
  assert.deepEqual([1, 2, 3].map((index) => runPosition(index)), [
    { phase: 'replay', step: 1 }, { phase: 'replay', step: 2 }, { phase: 'replay', step: 3 },
  ]);
  for (const [invalid, position] of [
    [RECORDED, { phase: 'replay', step: 2 }],
    [RECORDED, ASTRAY_POSITION],
    [ASTRAY, ASTRAY_POSITION],
    [{ ...RECORDED, position: 1 }, REPLAY_1],
    [{ ...RECORDED, status: 'running' }, REPLAY_1],
    [{ ...RECORDED, status: 'recovered' }, REPLAY_1],
    [{ ...RECORDED, duration_ms: -1 }, REPLAY_1],
    [{ ...RECORDED, duration_ms: 2 ** 53 }, REPLAY_1],
    [{ ...RECORDED, attempt: 0 }, REPLAY_1],
    [{ ...RECORDED, recorded_at: 'yesterday' }, REPLAY_1],
    [{ ...RECORDED, inputs: [{ member: 'page', source: 'secret', value: '1' }] }, REPLAY_1],
    [{ ...RECORDED, inputs: [{ member: 'page', source: 'literal', value: 'a‮b' }] }, REPLAY_1],
    [{ ...RECORDED, inputs: [{ member: 'b', source: 'literal', value: '1' }, { member: 'a', source: 'literal', value: '1' }] }, REPLAY_1],
    [{ ...RECORDED, raw_input: 'x' }, REPLAY_1],
    [{ ...GAP, attempt: 1 }, GAP.position],
    [{ ...GAP, status: 'skipped' }, GAP.position],
  ]) {
    assert.equal(isRunStep(invalid, position, 2), false, JSON.stringify(invalid));
  }
  for (const [body, snapshot, offset] of [
    [{ ...runPage(0, steps), extra: null }, 'latest', 0],
    // A run of no steps has no page.
    [runPage(0, [], { total: 0 }), 'latest', 0],
    [{ ...runPage(0, steps), team_id: 'team_2' }, 'latest', 0],
    [{ ...runPage(0, steps), run_id: 'd'.repeat(32) }, 'latest', 0],
    [{ ...runPage(0, steps), revision: 2 }, 'latest', 0],
    [{ ...runPage(0, steps), routine_id: 'c'.repeat(32) }, 'latest', 0],
    [{ ...runPage(0, steps), plan_digest: `sha256:${'e'.repeat(64)}` }, 'latest', 0],
    [{ ...runPage(0, steps, { total: 3 }), next: null }, 'latest', 0],
    [runPage(0, [RECORDED, ASTRAY], { total: 2 }), 'latest', 0],
    [runPage(0, steps, { snapshot: 'e'.repeat(32) }), SNAPSHOT, 0],
    [runPage(0, steps, { snapshot: 'latest' }), 'latest', 0],
    [{ ...runPage(0, steps), ended: 'yes' }, 'latest', 0],
    [runPage(0, steps), 'latest', 1],
    [runPage(0, [GAP, RECORDED]), 'latest', 0],
  ]) {
    await assert.rejects(
      readRunSteps(fetcher([[200, body]]).fetch, 'team_1', run, plan, snapshot, offset),
      (error) => error.code === 'routine-response-invalid',
      JSON.stringify(body).slice(-700),
    );
  }
  // Records that changed since a page was read are refused, so the reader starts again from the newest.
  await assert.rejects(
    readRunSteps(fetcher([[409, { code: 'routine-run-changed' }]]).fetch, 'team_1', run, plan, SNAPSHOT, 1),
    (error) => error.code === 'routine-run-changed' && error.status === 409,
  );
  for (const refused of [
    () => readRunSteps(fetcher([]).fetch, 'team_1', 'x', plan, 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, plan, 'LATEST', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, plan, null, 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, null, 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, TWO, 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, { ...plan, total: null }, 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, (({ total: _total, ...rest }) => ({ ...rest, replay: 2 }))(plan), 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, runBinding('x'), 'latest', 0),
    () => readRunSteps(fetcher([]).fetch, 'team_1', run, plan, 'latest', 256),
  ]) {
    await assert.rejects(refused(), (error) => error.code === 'routine-request-invalid');
  }
});

test("a run whose notice names no plan binds its records to the run its first page names, for every later page", async () => {
  const run = RUN_ENTRY.run_id;
  const unknown = runBinding(ROUTINE.routine_id);
  assert.deepEqual(unknown, { routine_id: ROUTINE.routine_id, revision: null, plan_digest: null, total: null });
  const steps = Array.from({ length: 70 }, (_, index) => ({ ...RECORDED, position: { phase: 'replay', step: index + 1 } }));
  const first = runPage(0, steps.slice(0, 64), { total: 70 });
  const page = await readRunSteps(fetcher([[200, first]]).fetch, 'team_1', run, unknown, 'latest', 0);
  const bound = pageBinding(page);
  assert.deepEqual(bound, { routine_id: ROUTINE.routine_id, revision: 1, plan_digest: DIGEST, total: 70 });
  const second = runPage(64, steps.slice(64), { total: 70 });
  assert.equal((await readRunSteps(fetcher([[200, second]]).fetch, 'team_1', run, bound, SNAPSHOT, 64)).next, null);
  // A later page of another revision, digest, size, or Routine never joins the first.
  for (const other of [{ revision: 2 }, { plan_digest: `sha256:${'e'.repeat(64)}` }, { routine_id: 'c'.repeat(32) }]) {
    await assert.rejects(
      readRunSteps(fetcher([[200, { ...second, ...other }]]).fetch, 'team_1', run, bound, SNAPSHOT, 64),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  await assert.rejects(
    readRunSteps(fetcher([[200, runPage(64, steps.slice(64, 69), { total: 69 })]]).fetch, 'team_1', run, bound, SNAPSHOT, 64),
    (error) => error.code === 'routine-response-invalid',
  );
  // Even before it is bound, a page must name a valid revision and digest and the run's own Routine.
  for (const other of [{ revision: 0 }, { plan_digest: 'sha256:x' }, { routine_id: 'c'.repeat(32) }]) {
    await assert.rejects(
      readRunSteps(fetcher([[200, { ...first, ...other }]]).fetch, 'team_1', run, unknown, 'latest', 0),
      (error) => error.code === 'routine-response-invalid',
    );
  }
});

test('a recovery card shows its recorded failure, offers exactly Rodar and Excluir, and answers once', async () => {
  const card = {
    team_id: 'team_1',
    incident_id: INCIDENT.incident_id,
    routine_id: ROUTINE.routine_id,
    revision: 2,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
    position: { phase: 'replay', step: 2 },
    steps: 3,
    evidence: 'recorded',
    diagnostic: { ...ATTEMPT_FAILURE, action: 'replace-dns-record', position: { phase: 'replay', step: 2 } },
    nonce: 'c'.repeat(32),
    expires_in: 300,
    choices: ['run', 'delete'],
  };
  const answered = { team_id: 'team_1', incident_id: INCIDENT.incident_id, choice: 'run', status: 'requested' };
  let api = fetcher([[200, card], [200, answered]]);
  const opened = await openRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id);
  assert.deepEqual(opened, card);
  assert.deepEqual(await answerRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id, opened, 'run'), answered);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/card`);
  assert.equal(api.calls[1].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/answer`);
  assert.deepEqual(JSON.parse(api.calls[1].init.body), { nonce: card.nonce, choice: 'run' });
  // A card outside the replay phase is refused.
  const astray = {
    ...card, position: { phase: 'other', step: 2 },
    diagnostic: { ...card.diagnostic, position: { phase: 'other', step: 2 } },
  };
  await assert.rejects(
    openRoutineCard(fetcher([[200, astray]]).fetch, 'team_1', INCIDENT.incident_id),
    (error) => error.code === 'routine-response-invalid',
  );
  // A choice the card does not offer is refused before any request.
  await assert.rejects(
    answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, card, 'other'),
    (error) => error.code === 'routine-request-invalid',
  );
  for (const evidence of ['absent', 'unavailable']) {
    const plain = { ...card, evidence, diagnostic: null };
    assert.deepEqual(await openRoutineCard(fetcher([[200, plain]]).fetch, 'team_1', INCIDENT.incident_id), plain);
  }
  for (const invalid of [
    { ...card, choices: ['run', 'other', 'delete'] },
    { ...card, choices: ['delete', 'run'] },
    { ...card, choices: ['run'] },
    { ...card, extra: 'run' },
    { ...card, incident_id: 'd'.repeat(32) },
    { ...card, team_id: 'team_2' },
    { ...card, assistant_id: null, action: null },
    { ...card, expires_in: 600 },
    { ...card, position: { phase: 'replay', step: 4 } },
    { ...card, position: { phase: 'replay', step: 0 } },
    { ...card, step: 2 },
    { ...card, diagnostic: { ...card.diagnostic, position: { phase: 'replay', step: 1 } } },
    { ...card, evidence: 'absent' },
    { ...card, diagnostic: null },
    // Never another step's error: the diagnostic must be of exactly the card's step.
    { ...card, diagnostic: { ...card.diagnostic, action: 'list-zones' } },
    { ...card, diagnostic: { ...card.diagnostic, failure: { ...card.diagnostic.failure, message: 'a\u202eb' } } },
  ]) {
    await assert.rejects(
      openRoutineCard(fetcher([[200, invalid]]).fetch, 'team_1', INCIDENT.incident_id),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  for (const [choice, body] of [
    ['run', { ...answered, status: 'other' }],
    ['run', { ...answered, choice: 'other' }],
    ['run', { ...answered, verdict: null }],
  ]) {
    await assert.rejects(
      answerRoutineCard(fetcher([[200, body]]).fetch, 'team_1', INCIDENT.incident_id, card, choice),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  await assert.rejects(
    answerRoutineCard(fetcher([[409, { code: 'routine-card-stale' }]]).fetch, 'team_1', INCIDENT.incident_id, card, 'run'),
    (error) => error.code === 'routine-card-stale' && error.status === 409,
  );
});

test('a recorded failure is explained by its likely cause and never guessed from nothing', () => {
  const failure = (changes) => ({ ...ATTEMPT_FAILURE, failure: { ...ATTEMPT_FAILURE.failure, ...changes } });
  const cases = [
    [failure({ http_status: 402, message: 'Payment Required' }), 'credits'],
    [failure({ http_status: 403, message: 'Your account has insufficient credits for this request' }), 'credits'],
    [failure({ http_status: 429, message: 'You exceeded your current quota, check your billing' }), 'credits'],
    [failure({ http_status: 429, message: 'Too Many Requests' }), 'rateLimit'],
    [failure({ http_status: 401, message: 'Unauthorized' }), 'auth'],
    [failure({ http_status: null, message: 'Invalid API token' }), 'auth'],
    [failure({ http_status: 404, message: "Client error '404 Not Found'" }), 'notFound'],
    [failure({ http_status: 504, message: 'Gateway Timeout' }), 'timeout'],
    [failure({ http_status: 422, message: 'Unprocessable' }), 'invalid'],
    [failure({ http_status: 400, message: 'zone_id must be 32 hex characters' }), 'invalid'],
    [failure({ http_status: 503, message: 'Service Unavailable' }), 'provider'],
    [failure({ http_status: null, message: 'Something odd happened' }), 'unknown'],
    [{ ...ATTEMPT_FAILURE, failure: null, condition: 'timeout' }, 'timeout'],
    [{ ...ATTEMPT_FAILURE, failure: null, condition: 'exit-status:1' }, 'assistant'],
    [null, 'unknown'],
  ];
  for (const [diagnostic, cause] of cases) {
    assert.equal(failureCause(diagnostic), cause, JSON.stringify(diagnostic?.failure ?? diagnostic));
  }
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    // Every cause has a title, or (unknown) a line; a cause states facts only, so it may add no line beyond its title.
    for (const [, cause] of cases) {
      assert.ok(cause === 'unknown' || typeof catalog.card.causeTitles[cause] === 'string', `${locale} ${cause}`);
      assert.ok(['undefined', 'string'].includes(typeof catalog.card.causes[cause]), `${locale} ${cause}`);
    }
    assert.equal(typeof catalog.card.causes.unknown, 'string', locale);
  }
});

// Team's diagnostics view (ADR-0092 section 8), as its golden vectors state it.
const ATTEMPT = Object.freeze({
  operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
  attempt: 1,
  assistant_id: 'shimpz-cloudflare',
  action: 'replace-dns-record',
  position: { phase: 'replay', step: 2 },
  recorded_at: '2026-10-05T12:00:03Z',
  failure: {
    error_type: 'httpx.HTTPStatusError',
    message: "Client error '404 Not Found' for url 'https://api.cloudflare.com/client/v4/zones/[REDACTED]'",
    provider: 'api.cloudflare.com',
    http_status: 404,
    response_excerpt: '{"success":false,"errors":[{"code":7003}]}',
    redacted: true,
    truncated: false,
  },
  condition: null,
});
const RUN_ID = 'b'.repeat(32);

test("a run's execution details admit exactly Team's diagnostics view for that run", async () => {
  const transport = { ...ATTEMPT, attempt: 2, failure: null, condition: 'exit-status:1' };
  const later = { ...ATTEMPT, attempt: 3, position: { phase: 'replay', step: 2 } };
  for (const diagnostics of [[], [ATTEMPT], [ATTEMPT, transport, later]]) {
    const api = fetcher([[200, { team_id: 'team_1', run_id: RUN_ID, diagnostics: structuredClone(diagnostics) }]]);
    assert.deepEqual(await readRunDiagnostics(api.fetch, 'team_1', RUN_ID), diagnostics);
    assert.equal(api.calls[0].path, `/api/teams/team_1/routines/runs/${RUN_ID}/diagnostics`);
  }
  const failure = ATTEMPT.failure;
  for (const diagnostic of [
    { ...ATTEMPT, condition: 'timeout' },
    { ...ATTEMPT, failure: null },
    { ...ATTEMPT, operation_id: '6f1c2b8e-3a4d-1c5e-9f60-718293a4b5c6' },
    { ...ATTEMPT, attempt: 65 },
    // Each attempt names its replay step.
    { ...ATTEMPT, position: { phase: 'replay', step: 0 } },
    { ...ATTEMPT, position: { phase: 'replay', step: 257 } },
    { ...ATTEMPT, position: { phase: 'other', step: 1 } },
    { ...ATTEMPT, position: 2 },
    { ...ATTEMPT, recorded_at: '2026-02-30T12:00:00Z' },
    { ...ATTEMPT, failure: null, condition: 'stderr: secret' },
    { ...ATTEMPT, failure: { ...failure, message: 'bidi \u202e override' } },
    { ...ATTEMPT, failure: { ...failure, message: 'x'.repeat(2049) } },
    { ...ATTEMPT, failure: { ...failure, message: 'lone \ud800' } },
    { ...ATTEMPT, failure: { ...failure, http_status: 99 } },
    { ...ATTEMPT, failure: { ...failure, provider: 'Not A Host' } },
    { ...ATTEMPT, failure: { ...failure, raw: 'output' } },
    { ...ATTEMPT, stdout: 'output' },
  ]) {
    await assert.rejects(
      readRunDiagnostics(fetcher([[200, { team_id: 'team_1', run_id: RUN_ID, diagnostics: [diagnostic] }]]).fetch, 'team_1', RUN_ID),
      (error) => error.code === 'routine-response-invalid',
      JSON.stringify(diagnostic).slice(0, 160),
    );
  }
  // Each attempt is listed once, oldest first, as Team orders them.
  const second = { ...ATTEMPT, attempt: 2 };
  for (const diagnostics of [[ATTEMPT, ATTEMPT], [second, ATTEMPT], [{ ...ATTEMPT, recorded_at: '2026-10-05T13:00:00Z' }, second]]) {
    await assert.rejects(
      readRunDiagnostics(fetcher([[200, { team_id: 'team_1', run_id: RUN_ID, diagnostics }]]).fetch, 'team_1', RUN_ID),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  for (const body of [
    { team_id: 'team_1', run_id: 'd'.repeat(32), diagnostics: [] },
    { team_id: 'team_2', run_id: RUN_ID, diagnostics: [] },
    { team_id: 'team_1', run_id: RUN_ID, diagnostics: Array(33).fill(ATTEMPT) },
  ]) {
    await assert.rejects(
      readRunDiagnostics(fetcher([[200, body]]).fetch, 'team_1', RUN_ID),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  await assert.rejects(readRunDiagnostics(fetcher([]).fetch, 'team_1', '../x'), (error) => error.code === 'routine-request-invalid');
});

test('a plan reads in words: ids, result paths, and literal previews', () => {
  assert.equal(humanizeId('list-dns-records'), 'List DNS records');
  assert.equal(humanizeId('zone_id'), 'Zone ID');
  assert.equal(humanizeId('dns'), 'DNS');
  assert.equal(humanizeId('---'), '---');
  const plan = routineMessages.pt.plan;
  assert.equal(pointerWords('/zones/0/id', plan), 'zones › primeiro › id');
  assert.equal(pointerWords('/items/2/a~1b~0c', plan), 'items › item 3 › a/b~c');
  assert.equal(literalWords('"example.com"'), 'example.com');
  assert.equal(literalWords('1'), '1');
  assert.equal(literalWords('{"a":1}'), '{"a":1}');
  assert.equal(literalWords('not json'), 'not json');
  // Decoding a preview never reverses Team's escaping: every unsafe character Team escaped is shown escaped again.
  assert.equal(literalWords('"a\\u202eb"'), 'a\\u202eb');
  assert.equal(literalWords('"\\u200b\\u2028\\ufeff\\u0007\\ud800x"'), '\\u200b\\u2028\\ufeff\\u0007\\ud800x');
  assert.equal(literalWords('"line\\nbreak"'), 'line\\u000abreak');
  // A paired surrogate is one safe character and stays as it is.
  assert.equal(literalWords('"\\ud83d\\ude00"'), '\u{1F600}');
  for (const preview of ['"a\\u202eb"', '"\\u2066x\\u2069"', '"\\u0000"']) {
    assert.doesNotMatch(literalWords(preview), /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, preview);
  }
  assert.equal(inputWords({ member: 'x', source: 'literal', value: '"a\\u202eb"' }, routineMessages.en.plan), 'a\\u202eb');
});

test("a Routine's status is its most urgent one", () => {
  const routine = { routine_id: 'a'.repeat(32), schedule: { kind: 'daily', time: '09:00' }, state: 'active', deleting: false, needs_reconfirm: false };
  const run = (status) => ({ run_id: 'b'.repeat(32), routine_id: routine.routine_id, status });
  const incident = { incident_id: 'c'.repeat(32), routine_id: routine.routine_id };
  assert.equal(routineStatus(routine), 'healthy');
  assert.equal(routineStatus({ ...routine, schedule: { kind: 'continuous', gap: 5, cap: 17280 } }), 'continuous');
  assert.equal(routineStatus(routine, [run('leased')]), 'running');
  assert.equal(routineStatus(routine, [run('frozen')]), 'waiting');
  assert.equal(routineStatus({ ...routine, state: 'paused' }, [run('frozen')]), 'paused');
  assert.equal(routineStatus({ ...routine, state: 'paused', needs_reconfirm: true }), 'reconfirm');
  assert.equal(routineStatus({ ...routine, state: 'paused' }, [], [incident]), 'recovery');
  assert.equal(routineStatus(routine, [run('held')]), 'recovery');
  assert.equal(routineStatus({ ...routine, deleting: true }, [], [incident]), 'deleting');
  assert.equal(routineStatus(routine, [{ ...run('leased'), routine_id: 'd'.repeat(32) }]), 'healthy');
});

test('a Routine shows the person only running, paused, or failed', () => {
  assert.deepEqual(
    Object.entries(STATUS_WORDS),
    [
      ['healthy', 'running'], ['continuous', 'running'], ['running', 'running'],
      ['paused', 'paused'], ['waiting', 'paused'], ['reconfirm', 'paused'],
      ['recovery', 'failed'],
    ],
  );
  assert.deepEqual(Object.keys(STATUS_TAGS), ['running', 'paused', 'failed']);
});

test('Pausar and Retomar admit only exactly that Routine in the asked state', async () => {
  const routineId = 'a'.repeat(32);
  let api = fetcher([[200, { team_id: 'team_1', routine_id: routineId, paused: true }]]);
  assert.equal(await pauseRoutine(api.fetch, 'team_1', routineId), true);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/${routineId}/pause`);
  assert.equal(api.calls[0].init.method, 'POST');
  await assert.rejects(
    pauseRoutine(fetcher([[200, { team_id: 'team_1', routine_id: routineId, paused: false }]]).fetch, 'team_1', routineId),
    (error) => error.code === 'routine-response-invalid',
  );
});

test('a Routine summary keeps each filled value apart and says how far off the next run is', () => {
  assert.deepEqual(fillParts('{request}, in {timezone} ({missing}).', { request: 'Check DNS', timezone: 'UTC' }), [
    { text: 'Check DNS', key: 'request' },
    { text: ', in ', key: '' },
    { text: 'UTC', key: 'timezone' },
    { text: ' (', key: '' },
    { text: '{missing}', key: '' },
    { text: ').', key: '' },
  ]);
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(untilWords('2026-10-02T15:00:00Z', now, 'en'), 'in 3 hours');
  assert.equal(untilWords('2026-10-02T12:00:30Z', now, 'en'), 'in 30 seconds');
  assert.equal(untilWords('2026-10-04T12:00:00Z', now, 'pt-BR'), 'depois de amanhã');
  assert.equal(untilWords('2026-10-02T12:00:00Z', now, 'en'), '');
  assert.equal(untilWords('2026-10-01T12:00:00Z', now, 'en'), '');
  assert.equal(clockWords('2026-10-03T01:29:05Z', 'pt-BR', 'America/Sao_Paulo'), '02/Outubro/2026 22:29:05');
  assert.equal(clockWords('2026-10-02T00:05:00Z', 'en', 'UTC'), '02/October/2026 00:05:00');
});

test('a Routine deletion starts with the password and admits only the factors Admin offers', async () => {
  const path = `/api/teams/team_1/routines/${ROUTINE.routine_id}/deletion`;
  let api = fetcher([[202, { methods: ['totp'] }]]);
  assert.deepEqual(await beginRoutineDeletion(api.fetch, 'team_1', ROUTINE.routine_id, 'secret words'), { passkey: null });
  assert.equal(api.calls[0].path, path);
  assert.equal(api.calls[0].init.method, 'POST');
  assert.equal(api.calls[0].init.body, JSON.stringify({ password: 'secret words' }));
  const options = { challenge: 'abc' };
  api = fetcher([[202, { methods: ['totp', 'passkey'], passkey_options: options }]]);
  assert.deepEqual(await beginRoutineDeletion(api.fetch, 'team_1', ROUTINE.routine_id, 'secret words'), { passkey: options });
  for (const body of [{ methods: ['passkey'] }, { methods: ['totp', 'passkey'] }, { methods: ['totp'], passkey_options: options }, {}]) {
    await assert.rejects(
      beginRoutineDeletion(fetcher([[202, body]]).fetch, 'team_1', ROUTINE.routine_id, 'secret words'),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  await assert.rejects(
    beginRoutineDeletion(fetcher([[429, { code: 'authentication-locked', retry_after: 42 }]]).fetch, 'team_1', ROUTINE.routine_id, 'x'),
    (error) => error.code === 'authentication-locked' && error.status === 429 && error.retryAfter === 42,
  );
  await assert.rejects(
    beginRoutineDeletion(fetcher([[429, { code: 'authentication-locked', retry_after: 1e9 }]]).fetch, 'team_1', ROUTINE.routine_id, 'x'),
    (error) => error.retryAfter === 0,
  );
});

test('a shown result is admitted only in Team\'s closed form and reads as plain words in the viewer\'s language', () => {
  assert.ok(isOutput(SHOWN_OUTPUT));
  assert.ok(isOutput(UNSHOWN));
  assert.ok(isOutput({ ...UNSHOWN, state: 'unchanged' }));
  const text = (value) => ({ kind: 'text', value, cut: false });
  const nested = (depth) => (depth === 0 ? { kind: 'null' } : { kind: 'list', items: [nested(depth - 1)], omitted: 0 });
  for (const invalid of [
    { ...SHOWN_OUTPUT, state: 'hidden' },
    { ...SHOWN_OUTPUT, value: null },
    { ...UNSHOWN, value: { kind: 'null' } },
    { ...UNSHOWN, truncated: true },
    { ...SHOWN_OUTPUT, step: 'zones' },
    { ...SHOWN_OUTPUT, step: 0 },
    { ...SHOWN_OUTPUT, step: 257 },
    { ...SHOWN_OUTPUT, extra: 1 },
    { ...SHOWN_OUTPUT, value: text('a\u202eb') },
    { ...SHOWN_OUTPUT, value: text('x'.repeat(301)) },
    { ...SHOWN_OUTPUT, value: { kind: 'text', value: 'x' } },
    { ...SHOWN_OUTPUT, value: { kind: 'number', value: Infinity } },
    { ...SHOWN_OUTPUT, value: { kind: 'number', value: 12 } },
    { ...SHOWN_OUTPUT, value: { kind: 'number', value: '012' } },
    { ...SHOWN_OUTPUT, value: { kind: 'number', value: '1'.repeat(65) } },
    { ...SHOWN_OUTPUT, value: { kind: 'bool', value: 1 } },
    { ...SHOWN_OUTPUT, value: { kind: 'script', value: 'x' } },
    { ...SHOWN_OUTPUT, value: { kind: 'toString' } },
    { ...SHOWN_OUTPUT, value: nested(5) },
    { ...SHOWN_OUTPUT, value: { kind: 'list', items: [], omitted: -1 } },
    { ...SHOWN_OUTPUT, value: { kind: 'list', items: Array(51).fill({ kind: 'null' }), omitted: 0 } },
    { ...SHOWN_OUTPUT, value: { kind: 'fields', fields: [['a', { kind: 'null' }], ['a', { kind: 'null' }]], omitted: 0 } },
    { ...SHOWN_OUTPUT, value: { kind: 'fields', fields: [['', { kind: 'null' }]], omitted: 0 } },
    { ...SHOWN_OUTPUT, value: { kind: 'fields', fields: [['a']], omitted: 0 } },
    { ...SHOWN_OUTPUT, value: { kind: 'list', items: Array(50).fill(text('é'.repeat(300))), omitted: 0 } },
    [],
    null,
  ]) assert.equal(isOutput(invalid), false, JSON.stringify(invalid)?.slice(0, 80));
  assert.ok(isOutput({ ...SHOWN_OUTPUT, value: nested(4) }));
  // A disposition names the position of one of the plan's steps exactly when it shows one.
  assert.ok(isDisposition({ mode: 'changes', step: 1 }, 1));
  assert.ok(isDisposition({ mode: 'show', step: 120 }, 120));
  assert.ok(isDisposition({ mode: 'none', step: null }, 1));
  for (const [invalid, total] of [
    [{ mode: 'show', step: 2 }, 1], [{ mode: 'show', step: 'zones' }, 1], [{ mode: 'none', step: 1 }, 1],
    [{ mode: 'loud', step: null }, 1], [{ mode: 'none', step: null }, 0], [{ mode: 'chain', step: null }, 1],
    [{ mode: 'show', step: 1, extra: null }, 1],
  ]) {
    assert.equal(isDisposition(invalid, total), false, JSON.stringify(invalid));
  }
  const copy = routineMessages.pt;
  assert.equal(dispositionWords({ mode: 'changes', step: 1 }, copy.plan), 'Mostra o resultado da etapa 1 só quando ele muda');
  // A list of field sets reads as one table, its columns in first-seen order and a missing cell empty.
  const zones = SHOWN_OUTPUT.value.fields[0][1];
  const table = outputTable(zones);
  assert.deepEqual(table.columns, ['name', 'paused', 'token']);
  assert.deepEqual(table.rows[1], [zones.items[1].fields[0][1], null, { kind: 'redacted' }]);
  assert.equal(outputTable({ kind: 'list', items: [], omitted: 0 }), null);
  assert.equal(outputTable({ kind: 'list', items: [text('a')], omitted: 0 }), null);
  assert.equal(outputTable(zones, 2), null);
  assert.equal(outputTable(SHOWN_OUTPUT.value), null);
  const words = copy.notice.output;
  assert.deepEqual(
    [text('<b>x</b>'), { kind: 'number', value: '1234.5' }, { kind: 'bool', value: true }, { kind: 'bool', value: false },
      { kind: 'redacted' }, { kind: 'elided' }, { kind: 'null' }].map((node) => outputScalarWords(node, words, 'pt')),
    ['<b>x</b>', '1.234,5', 'sim', 'não', 'oculto', '…', '—'],
  );
  assert.equal(omittedWords(words, 1, 'pt'), 'mais 1');
  // A number reads in the viewer's locale only while the browser holds it exactly; otherwise exactly as Team wrote it.
  const number = (value) => outputScalarWords({ kind: 'number', value }, words, 'pt');
  assert.deepEqual(
    ['0.0001', '1.23456', '0.000001', '-12', '0', '123456789012345', '12345678901234567890', '0.1234567890123456789',
      '1e-7', '1e-101', '5e-324', '0.00000012345', '1e15'].map(number),
    ['0,0001', '1,23456', '0,000001', '-12', '0', '123.456.789.012.345', '12345678901234567890', '0.1234567890123456789',
      '1e-7', '1e-101', '5e-324', '0.00000012345', '1e15'],
  );
  // A field set Team cut short, or one with no fields, never becomes a table row that hides it.
  const cut = { kind: 'fields', fields: [['a', text('x')]], omitted: 2 };
  assert.equal(outputTable({ kind: 'list', items: [cut], omitted: 0 }), null);
  assert.equal(outputTable({ kind: 'list', items: [{ kind: 'fields', fields: [], omitted: 0 }], omitted: 0 }), null);
  // Labels read humanized only while that keeps them distinct.
  assert.deepEqual(outputLabels(['per_page', 'name']), ['Per page', 'Name']);
  assert.deepEqual(outputLabels(['a-b', 'a_b']), ['a-b', 'a_b']);
  assert.equal(omittedWords(routineMessages.en.notice.output, 1200, 'en'), '1,200 more');
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    for (const key of ['empty', 'yes', 'no', 'redacted', 'truncated']) {
      assert.equal(typeof catalog.notice.output[key], 'string', `${locale} ${key}`);
    }
    for (const mode of ['show', 'changes', 'none']) {
      const words = dispositionWords({ mode, step: mode === 'show' || mode === 'changes' ? 1 : null }, catalog.plan);
      assert.doesNotMatch(words, /\{|undefined/, `${locale} ${mode}`);
    }
    assert.doesNotMatch(omittedWords(catalog.notice.output, 3, locale), /\{/, locale);
  }
});

test("a recorded attempt reads in words by its replay step", () => {
  const copy = routineMessages.en;
  const item = { assistant_id: 'shimpz-cloudflare', action: 'delete-dns-record', attempt: 2 };
  const names = { assistant: () => 'Cloudflare', action: humanizeId };
  assert.notEqual(
    attemptWords({ ...item, position: { phase: 'replay', step: 3 } }, copy.details.attempt, names),
    attemptWords({ ...item, position: { phase: 'replay', step: 4 } }, copy.details.attempt, names),
  );
});
