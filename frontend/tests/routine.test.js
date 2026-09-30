import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import {
  answerRoutineChallenge,
  browserTimezone,
  confirmRoutine,
  deleteRoutine,
  fillRoutineCopy,
  instantWords,
  isQuote,
  isSchedule,
  isTimezone,
  listRoutines,
  openRoutineChallenge,
  parseRoutinePreview,
  previewMatches,
  parseRoutineProposal,
  parseRoutineRunEntry,
  parseRoutineView,
  parseRunView,
  previewRoutine,
  resolveRoutineRun,
  resumeRoutineIntegrations,
  RoutineError,
  routineErrorMessage,
  scheduleWords,
  stopRoutineRun,
} from '../src/lib/routine.js';
import { routineMessages } from '../src/lib/routineMessages.js';

// The same closed proposal Team's protocol vectors admit (ADR-0086).
const PROPOSAL = {
  proposal_id: 'c'.repeat(32),
  op: 'propose',
  quote: 'Toda segunda às 9h, confira o DNS',
  schedule: { kind: 'weekly', weekday: 0, time: '09:00' },
  timezone: null,
  routine_id: null,
  assistant_ids: ['shimpz-cloudflare'],
  expires_in: 900,
};
const CANCEL = {
  proposal_id: 'd'.repeat(32),
  op: 'cancel',
  quote: 'pode parar o resumo diário',
  schedule: null,
  timezone: null,
  routine_id: 'a'.repeat(32),
  assistant_ids: [],
  expires_in: 0,
};

test('admits exactly the closed proposal and cancel forms', () => {
  assert.equal(parseRoutineProposal(null), null);
  assert.deepEqual(parseRoutineProposal(PROPOSAL), PROPOSAL);
  assert.deepEqual(parseRoutineProposal({ ...PROPOSAL, timezone: 'Europe/Lisbon' }).timezone, 'Europe/Lisbon');
  assert.deepEqual(parseRoutineProposal(CANCEL), CANCEL);
  const parsed = parseRoutineProposal(PROPOSAL);
  parsed.schedule.time = '10:00';
  assert.equal(PROPOSAL.schedule.time, '09:00');
  for (const invalid of [
    [],
    { ...PROPOSAL, extra: 1 },
    { ...PROPOSAL, proposal_id: 'x' },
    { ...PROPOSAL, expires_in: 901 },
    { ...PROPOSAL, expires_in: 1.5 },
    { ...PROPOSAL, quote: ' padded ' },
    { ...PROPOSAL, assistant_ids: [] },
    { ...PROPOSAL, assistant_ids: ['b-x', 'a-x'] },
    { ...PROPOSAL, assistant_ids: ['Bad'] },
    { ...PROPOSAL, routine_id: 'a'.repeat(32) },
    { ...PROPOSAL, timezone: '../etc' },
    { ...PROPOSAL, schedule: { kind: 'daily' } },
    { ...PROPOSAL, op: 'run' },
    { ...CANCEL, schedule: { kind: 'daily', time: '09:00' } },
    { ...CANCEL, routine_id: null },
  ]) {
    assert.throws(() => parseRoutineProposal(invalid), TypeError);
  }
});

test('mirrors the schedule, quote, and timezone grammar', () => {
  for (const schedule of [
    { kind: 'hourly', every: 1 },
    { kind: 'hourly', every: 24 },
    { kind: 'daily', time: '23:59' },
    { kind: 'weekly', weekday: 6, time: '00:00' },
    { kind: 'monthly', day: 28, time: '12:30' },
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
  ]) {
    assert.equal(isSchedule(schedule), false, JSON.stringify(schedule));
  }
  assert.equal(isQuote('a'.repeat(500)), true);
  assert.equal(isQuote('😀'.repeat(500)), true);
  for (const quote of ['', 'a'.repeat(501), 'line\nbreak', 'é', 'x y', 7]) {
    assert.equal(isQuote(quote), false, JSON.stringify(quote));
  }
  assert.equal(isTimezone('America/Argentina/Buenos_Aires'), true);
  assert.equal(isTimezone('UTC'), true);
  assert.equal(isTimezone('../etc'), false);
  assert.equal(isTimezone(null), false);
});

test('a chat reply and its stored history carry the proposal for the card', async () => {
  const done = {
    type: 'done',
    team_id: 'team_1',
    team_name: 'Marketing',
    reply: 'Posso agendar isso; confirme no cartão.',
    clarification: null,
    routine_proposal: PROPOSAL,
  };
  assert.deepEqual(parseChatEvent(done, 'team_1', 'Marketing').routine_proposal, PROPOSAL);
  assert.throws(() => parseChatEvent({ ...done, routine_proposal: { ...PROPOSAL, op: 'run' } }, 'team_1', 'Marketing'));
  const { routine_proposal: _omitted, ...withoutProposal } = done;
  assert.throws(() => parseChatEvent(withoutProposal, 'team_1', 'Marketing'));

  const turn = 'b'.repeat(32);
  const reply = {
    id: `${turn}:reply`,
    kind: 'message',
    role: 'assistant',
    text: done.reply,
    author: 'Marketing',
    routine_proposal: PROPOSAL,
  };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([reply]), 'marketing');
  assert.deepEqual(history.entries[0].routineProposal, PROPOSAL);
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: null }]), 'marketing'));
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: { ...PROPOSAL, expires_in: -1 } }]), 'marketing'));
  await assert.rejects(
    listChatHistory(page([{ id: `${turn}:user`, kind: 'message', role: 'user', text: 'Oi', routine_proposal: PROPOSAL }]), 'marketing'),
  );
});

const PREVIEW = {
  ...PROPOSAL,
  timezone: 'America/Sao_Paulo',
  next_runs: ['2026-10-05T12:00:00Z', '2026-10-12T12:00:00Z', '2026-10-19T12:00:00Z'],
  daily_runs: '1/7',
  max_daily_runs: 24,
  fits: true,
};
const CANCEL_PREVIEW = { ...CANCEL, timezone: null, next_runs: [], daily_runs: null, max_daily_runs: null, fits: true };
const ROUTINE = {
  routine_id: 'a'.repeat(32),
  quote: PROPOSAL.quote,
  schedule: PROPOSAL.schedule,
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-05T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
};
const LEASED = {
  run_id: 'b'.repeat(32),
  routine_id: ROUTINE.routine_id,
  status: 'leased',
  scheduled_at: '2026-10-05T12:00:00Z',
  request_kind: null,
  assistant_id: null,
  action: null,
  batch_fingerprint: null,
  actions: [],
};
const FROZEN = { ...LEASED, status: 'frozen', request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'list-zones' };
const UNCERTAIN = {
  ...LEASED,
  status: 'uncertain',
  batch_fingerprint: 'e'.repeat(64),
  actions: [['shimpz-cloudflare', 'replace-dns-record']],
};

test('a card confirms only a live preview of exactly its saved proposal', () => {
  assert.equal(previewMatches(PROPOSAL, PREVIEW), true);
  assert.equal(previewMatches({ ...PROPOSAL, timezone: 'America/Sao_Paulo' }, PREVIEW), true);
  assert.equal(previewMatches(CANCEL, CANCEL_PREVIEW), true);
  for (const drifted of [
    { ...PREVIEW, proposal_id: 'f'.repeat(32) },
    { ...PREVIEW, quote: 'Every hour, delete my DNS zones' },
    { ...PREVIEW, schedule: { kind: 'hourly', every: 1 } },
    { ...PREVIEW, assistant_ids: ['other-assistant'] },
    { ...PREVIEW, op: 'cancel' },
    { ...PREVIEW, routine_id: 'a'.repeat(32) },
  ]) {
    assert.equal(previewMatches(PROPOSAL, drifted), false);
  }
  assert.equal(previewMatches({ ...PROPOSAL, timezone: 'Europe/Lisbon' }, PREVIEW), false);
});

test('previews, Routines, and runs are admitted only in their closed views', () => {
  assert.deepEqual(parseRoutinePreview(PREVIEW), PREVIEW);
  assert.deepEqual(parseRoutinePreview(CANCEL_PREVIEW), CANCEL_PREVIEW);
  for (const invalid of [
    null,
    { ...PROPOSAL },
    { ...PREVIEW, next_runs: [] },
    { ...PREVIEW, next_runs: [PREVIEW.next_runs[1], PREVIEW.next_runs[0]] },
    { ...PREVIEW, next_runs: ['2026-02-30T12:00:00Z'] },
    { ...PREVIEW, daily_runs: '1.5' },
    { ...PREVIEW, max_daily_runs: 25 },
    { ...PREVIEW, fits: 1 },
    { ...PREVIEW, extra: 1 },
    { ...PREVIEW, op: 'run' },
    { ...CANCEL_PREVIEW, fits: false },
  ]) {
    assert.throws(() => parseRoutinePreview(invalid), RoutineError);
  }
  assert.deepEqual(parseRoutineView(ROUTINE), ROUTINE);
  for (const invalid of [{ ...ROUTINE, quote: null }, { ...ROUTINE, deleting: 'no' }, { ...ROUTINE, assistant_ids: [] }]) {
    assert.throws(() => parseRoutineView(invalid), RoutineError);
  }
  for (const run of [LEASED, FROZEN, UNCERTAIN]) assert.deepEqual(parseRunView(run), run);
  for (const invalid of [
    { ...LEASED, status: 'running' },
    { ...LEASED, request_kind: 'human' },
    { ...FROZEN, action: null },
    { ...UNCERTAIN, batch_fingerprint: null },
    { ...LEASED, batch_fingerprint: 'e'.repeat(64) },
    { ...LEASED, actions: [['shimpz-cloudflare', 'list-zones']] },
    { ...UNCERTAIN, actions: [['Bad', 'x']] },
    { ...UNCERTAIN, actions: [['shimpz-cloudflare']] },
    { ...UNCERTAIN, actions: 'x' },
  ]) {
    assert.throws(() => parseRunView(invalid), RoutineError);
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
  let api = fetcher([[200, PREVIEW]]);
  assert.deepEqual(await previewRoutine(api.fetch, 'team_1', PROPOSAL.proposal_id, 'UTC'), PREVIEW);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/proposals/${PROPOSAL.proposal_id}/preview`);
  assert.deepEqual(JSON.parse(api.calls[0].init.body), { timezone: 'UTC' });
  assert.equal(api.calls[0].init.headers['Content-Type'], 'application/json');

  api = fetcher([[200, { team_id: 'team_1', routine: ROUTINE }], [200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, deleted: false }]]);
  assert.deepEqual(await confirmRoutine(api.fetch, 'team_1', PROPOSAL.proposal_id, 'UTC'), { routine: ROUTINE });
  assert.deepEqual(await confirmRoutine(api.fetch, 'team_1', CANCEL.proposal_id, 'UTC'), { deleted: false });

  api = fetcher([[200, { team_id: 'team_1', routines: [ROUTINE], runs: [FROZEN] }]]);
  assert.deepEqual(await listRoutines(api.fetch, 'team_1'), { routines: [ROUTINE], runs: [FROZEN] });
  assert.equal(api.calls[0].init.headers['Content-Type'], undefined);

  await assert.rejects(
    previewRoutine(fetcher([[200, { ...PREVIEW, proposal_id: 'f'.repeat(32) }]]).fetch, 'team_1', PROPOSAL.proposal_id, 'UTC'),
    (error) => error.code === 'routine-response-invalid',
  );
  api = fetcher([[200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, deleted: true }]]);
  assert.deepEqual(await deleteRoutine(api.fetch, 'team_1', ROUTINE.routine_id), { deleted: true });
  await assert.rejects(
    deleteRoutine(fetcher([[200, { team_id: 'team_1', routine_id: 'f'.repeat(32), deleted: true }]]).fetch, 'team_1', ROUTINE.routine_id),
    (error) => error.code === 'routine-response-invalid',
  );
  assert.equal(api.calls[0].init.method, 'DELETE');

  api = fetcher([[200, { team_id: 'team_1', run_id: LEASED.run_id, stopped: true }], [200, { team_id: 'team_1', run_id: UNCERTAIN.run_id, resolved: true }]]);
  assert.equal(await stopRoutineRun(api.fetch, 'team_1', LEASED.run_id), true);
  assert.equal(await resolveRoutineRun(api.fetch, 'team_1', UNCERTAIN.run_id, 'e'.repeat(64)), true);
  assert.deepEqual(JSON.parse(api.calls[1].init.body), { batch_fingerprint: 'e'.repeat(64) });

  for (const [call, responses] of [
    [(f) => listRoutines(f, 'team_1'), [[200, { team_id: 'team_2', routines: [], runs: [] }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { team_id: 'team_1', routines: Array(9).fill(ROUTINE), runs: [] }]]],
    [(f) => confirmRoutine(f, 'team_1', PROPOSAL.proposal_id, 'UTC'), [[200, { team_id: 'team_1', deleted: 'yes', routine_id: ROUTINE.routine_id }]]],
    [(f) => stopRoutineRun(f, 'team_1', LEASED.run_id), [[200, { team_id: 'team_1', run_id: 'd'.repeat(32), stopped: true }]]],
  ]) {
    await assert.rejects(call(fetcher(responses).fetch), (error) => error.code === 'routine-response-invalid');
  }
  await assert.rejects(
    deleteRoutine(fetcher([[409, { code: 'routine-run-uncertain' }]]).fetch, 'team_1', ROUTINE.routine_id),
    (error) => error.code === 'routine-run-uncertain' && error.status === 409,
  );
  await assert.rejects(
    deleteRoutine(fetcher([[500, { code: 'Not Safe' }]]).fetch, 'team_1', ROUTINE.routine_id),
    (error) => error.code === 'routine-request-failed',
  );
  for (const refused of [
    () => listRoutines(null, 'team_1'),
    () => listRoutines(fetcher([]).fetch, 'Team 1'),
    () => deleteRoutine(fetcher([]).fetch, 'team_1', '../x'),
    () => resolveRoutineRun(fetcher([]).fetch, 'team_1', UNCERTAIN.run_id, 'x'),
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
  assert.equal(scheduleWords({ kind: 'weekly', weekday: 6, time: '09:00' }, routineMessages.pt.schedule, 'pt'), 'Toda domingo às 09:00');
  assert.equal(scheduleWords({ kind: 'monthly', day: 28, time: '18:30' }, words, 'en'), 'On day 28 of every month at 18:30');
  assert.equal(instantWords('2026-10-05T12:00:00Z', 'en', 'America/Sao_Paulo'), 'Oct 5, 2026, 9:00 AM');
  assert.equal(fillRoutineCopy('{a} and {missing}', { a: 1 }), '1 and {missing}');
  const errors = routineMessages.en.errors;
  assert.equal(routineErrorMessage(new RoutineError('routine-proposal-unavailable'), errors), errors.gone);
  assert.equal(routineErrorMessage(new RoutineError('routine-rate-limit'), errors), errors.full);
  assert.equal(routineErrorMessage(new RoutineError('other'), errors), errors.generic);
  assert.equal(routineErrorMessage(new Error('x'), errors), errors.generic);
  assert.equal(isTimezone(browserTimezone()), true);
});

const RUN_ENTRY = {
  id: `${'b'.repeat(32)}:routine`,
  kind: 'routine-run',
  notice_id: 'b'.repeat(32),
  routine_id: 'a'.repeat(32),
  quote: 'Toda segunda às 9h, confira o DNS',
  run_id: 'b'.repeat(32),
  outcome: 'done',
  created_at: '2026-10-05T12:01:07Z',
  detail: { reply: 'Nenhuma mudança de DNS.' },
  version: 2,
};

test('a Routine transcript row is admitted only in its closed form', async () => {
  assert.deepEqual(parseRoutineRunEntry(RUN_ENTRY), {
    id: RUN_ENTRY.id,
    kind: 'routine-run',
    runId: RUN_ENTRY.run_id,
    routineId: RUN_ENTRY.routine_id,
    quote: RUN_ENTRY.quote,
    outcome: 'done',
    createdAt: RUN_ENTRY.created_at,
    detail: RUN_ENTRY.detail,
  });
  const valid = [
    { ...RUN_ENTRY, outcome: 'needs-input', detail: { question: 'Which zone?' } },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, notice_id: 'f'.repeat(32), id: `${'f'.repeat(32)}:routine`, detail: { missed: 3 } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, detail: { assistants: ['shimpz-cloudflare'] } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'list-zones' } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']] } },
    { ...RUN_ENTRY, outcome: 'denied', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'stopped', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'uncertain', detail: { actions: [] } },
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
    { ...RUN_ENTRY, quote: ' padded ' },
    { ...RUN_ENTRY, created_at: '2026-02-30T12:00:00Z' },
    { ...RUN_ENTRY, version: 0 },
    { ...RUN_ENTRY, detail: { reply: '' } },
    { ...RUN_ENTRY, detail: { reply: 'x', result: { ip: '1.2.3.4' } } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'email', assistant_id: 'x', action: 'y' } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'Bad Code', actions: [] } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, detail: { assistants: [] } },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, detail: { missed: 0 } },
  ]) {
    assert.throws(() => parseRoutineRunEntry(invalid), RoutineError);
  }
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([RUN_ENTRY]), 'marketing');
  assert.equal(history.entries[0].kind, 'routine-run');
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, outcome: 'run' }]), 'marketing'));
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, id: `${'b'.repeat(32)}:reply` }]), 'marketing'));
});

test('a frozen run is opened, answered, and resumed only through exact answers', async () => {
  const run = 'd'.repeat(32);
  const challenge = { type: 'human-required', challenge_id: 'b'.repeat(32) };
  let api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'human-required', challenge }]]);
  assert.deepEqual(await openRoutineChallenge(api.fetch, 'team_1', run, (value) => ({ parsed: value })), {
    status: 'human-required',
    challenge: { parsed: challenge },
  });
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/runs/${run}/challenge`);
  api = fetcher([[200, { team_id: 'team_1', run_id: run, status: 'integrations-required' }]]);
  assert.deepEqual(await openRoutineChallenge(api.fetch, 'team_1', run, () => null), { status: 'integrations-required' });
  for (const [body, parse] of [
    [{ team_id: 'team_1', run_id: 'e'.repeat(32), status: 'integrations-required' }, () => null],
    [{ team_id: 'team_1', run_id: run, status: 'human-required', challenge }, () => { throw new Error('x'); }],
    [{ team_id: 'team_1', run_id: run, status: 'done' }, () => null],
  ]) {
    await assert.rejects(openRoutineChallenge(fetcher([[200, body]]).fetch, 'team_1', run, parse), RoutineError);
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
