import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import {
  answerRoutineChallenge,
  browserTimezone,
  deleteRoutine,
  fillRoutineCopy,
  instantWords,
  isQuote,
  isSchedule,
  isTimezone,
  listRoutines,
  openRoutineChallenge,
  newerRoutineEntries,
  parseRoutineRunEntry,
  parseRoutineView,
  parseRunView,
  resolveRoutineRun,
  resumeRoutineIntegrations,
  RoutineError,
  routineErrorMessage,
  scheduleWords,
  stopRoutineRun,
} from '../src/lib/routine.js';
import { routineMessages } from '../src/lib/routineMessages.js';

// The same closed proposal Team's protocol vectors admit (ADR-0086).
const QUOTE = 'Toda segunda às 9h, confira o DNS';
const WEEKLY = { kind: 'weekly', weekday: 0, time: '09:00' };

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

test('a chat reply and its stored history never carry a retired Routine proposal', async () => {
  const done = {
    type: 'done',
    team_id: 'team_1',
    team_name: 'Marketing',
    reply: 'Pronto: toda segunda às 9h confiro o DNS.',
    clarification: null,
  };
  assert.equal(Object.hasOwn(parseChatEvent(done, 'team_1', 'Marketing'), 'routine_proposal'), false);
  assert.throws(() => parseChatEvent({ ...done, routine_proposal: null }, 'team_1', 'Marketing'));

  const turn = 'b'.repeat(32);
  const reply = { id: `${turn}:reply`, kind: 'message', role: 'assistant', text: done.reply, author: 'Marketing' };
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  assert.equal((await listChatHistory(page([reply]), 'marketing')).entries[0].text, done.reply);
  await assert.rejects(listChatHistory(page([{ ...reply, routine_proposal: null }]), 'marketing'));
});

const ROUTINE = {
  routine_id: 'a'.repeat(32),
  quote: QUOTE,
  schedule: WEEKLY,
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

test('Routines and runs are admitted only in their closed views', () => {
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
  let api = fetcher([[200, { team_id: 'team_1', routines: [ROUTINE], runs: [FROZEN] }]]);
  assert.deepEqual(await listRoutines(api.fetch, 'team_1'), { routines: [ROUTINE], runs: [FROZEN] });
  assert.equal(api.calls[0].init.headers['Content-Type'], undefined);

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
  assert.equal(routineErrorMessage(new RoutineError('routine-rate-limit'), errors), errors.full);
  assert.equal(routineErrorMessage(new RoutineError('team-context-unavailable'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('human-request-invalid'), errors), errors.changed);
  assert.equal(routineErrorMessage(new RoutineError('assistant-language-drift'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('other'), errors), errors.generic);
  assert.equal(routineErrorMessage(new Error('x'), errors), errors.generic);
  const zone = browserTimezone();
  assert.equal(zone === null || isTimezone(zone), true);
});

const DEFINED = {
  name: 'DNS semanal',
  actions: [['shimpz-cloudflare', 'list-dns-records']],
  schedule: WEEKLY,
  timezone: 'America/Sao_Paulo',
};
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
    version: RUN_ENTRY.version,
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
    { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: DEFINED },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: DEFINED },
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
    { ...RUN_ENTRY, outcome: 'created', detail: DEFINED },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: { ...DEFINED, actions: [] } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: { ...DEFINED, actions: Array(9).fill(DEFINED.actions[0]) } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: { ...DEFINED, name: ' padded ' } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: { ...DEFINED, name: 'x'.repeat(81) } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: { ...DEFINED, schedule: { kind: 'daily' } } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: { ...DEFINED, timezone: '../etc' } },
    { ...RUN_ENTRY, outcome: 'changed', run_id: null, detail: { ...DEFINED, input: { zone: 'example.com' } } },
  ]) {
    assert.throws(() => parseRoutineRunEntry(invalid), RoutineError);
  }
  const page = (entries) => async () => ({ ok: true, status: 200, async json() { return { entries, before: null }; } });
  const history = await listChatHistory(page([RUN_ENTRY]), 'marketing');
  assert.equal(history.entries[0].kind, 'routine-run');
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, outcome: 'run' }]), 'marketing'));
  await assert.rejects(listChatHistory(page([{ ...RUN_ENTRY, id: `${'b'.repeat(32)}:reply` }]), 'marketing'));
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
