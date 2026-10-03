import assert from 'node:assert/strict';
import test from 'node:test';

import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import {
  answerRoutineCard,
  answerRoutineChallenge,
  browserTimezone,
  beginRoutineDeletion,
  deleteRoutine,
  fillRoutineCopy,
  instantWords,
  minuteWords,
  isQuote,
  isSchedule,
  isTimezone,
  listRoutines,
  openRoutineCard,
  openRoutineChallenge,
  newerRoutineEntries,
  parseIncidentView,
  parseRoutineRunEntry,
  parseRoutineView,
  isSteps,
  parseRunView,
  pauseRoutine,
  pointerWords,
  humanizeId,
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
    { kind: 'continuous', gap: 5, cap: 1 },
    { kind: 'continuous', gap: 86400, cap: 1000 },
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
    { kind: 'continuous', gap: 5.5, cap: 10 },
    { kind: 'continuous', gap: 5 },
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

const PLAN = [
    {
      id: 'zones',
      assistant: 'shimpz-cloudflare',
      action: 'list-zones',
      inputs: [{ member: 'page', source: 'literal', value: '1' }],
      stored_inputs: ['api-token'],
    },
  ];
const ROUTINE = {
  routine_id: 'a'.repeat(32),
  name: 'DNS semanal',
  quote: QUOTE,
  steps: PLAN,
  schedule: WEEKLY,
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-05T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  paused: false,
};
const LEASED = {
  run_id: 'b'.repeat(32),
  routine_id: ROUTINE.routine_id,
  status: 'leased',
  scheduled_at: '2026-10-05T12:00:00Z',
  request_kind: null,
  assistant_id: null,
  action: null,
};
const FROZEN = { ...LEASED, status: 'frozen', request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'list-zones' };
const HELD = { ...LEASED, status: 'held' };
const INCIDENT = {
  incident_id: 'b'.repeat(32),
  routine_id: ROUTINE.routine_id,
  quote: QUOTE,
  created_at: '2026-10-05T12:01:07Z',
  assistant_id: 'shimpz-cloudflare',
  action: 'replace-dns-record',
};

test('Routines and runs are admitted only in their closed views', () => {
  assert.deepEqual(parseRoutineView(ROUTINE), ROUTINE);
  assert.deepEqual(parseRoutineView({ ...ROUTINE, paused: true }), { ...ROUTINE, paused: true });
  const { paused: _paused, ...unpaused } = ROUTINE;
  for (const invalid of [
    { ...ROUTINE, quote: null },
    { ...ROUTINE, deleting: 'no' },
    { ...ROUTINE, assistant_ids: [] },
    { ...ROUTINE, paused: 'no' },
    unpaused,
  ]) {
    assert.throws(() => parseRoutineView(invalid), RoutineError);
  }
  for (const run of [LEASED, FROZEN, HELD]) assert.deepEqual(parseRunView(run), run);
  for (const invalid of [
    { ...LEASED, status: 'running' },
    // The retired uncertain run and its release batch stay refused.
    { ...LEASED, status: 'uncertain' },
    { ...LEASED, batch_fingerprint: null, actions: [] },
    { ...LEASED, request_kind: 'human' },
    { ...HELD, assistant_id: 'shimpz-cloudflare' },
    { ...FROZEN, action: null },
  ]) {
    assert.throws(() => parseRunView(invalid), RoutineError);
  }
  for (const incident of [INCIDENT, { ...INCIDENT, assistant_id: null, action: null }]) {
    assert.deepEqual(parseIncidentView(incident), incident);
  }
  for (const invalid of [
    { ...INCIDENT, assistant_id: null },
    { ...INCIDENT, quote: '' },
    { ...INCIDENT, created_at: '2026-10-05' },
    { ...INCIDENT, status: 'unresolved' },
  ]) {
    assert.throws(() => parseIncidentView(invalid), RoutineError);
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

  api = fetcher([
    [200, { team_id: 'team_1', run_id: LEASED.run_id, stopped: true }],
    [200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, paused: false }],
  ]);
  assert.equal(await stopRoutineRun(api.fetch, 'team_1', LEASED.run_id), true);
  assert.equal(await resumeRoutine(api.fetch, 'team_1', ROUTINE.routine_id), false);
  assert.equal(api.calls[1].path, `/api/teams/team_1/routines/${ROUTINE.routine_id}/resume`);

  const empty = { team_id: 'team_1', routines: [], runs: [], incidents: [] };
  for (const [call, responses] of [
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, team_id: 'team_2' }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, routines: Array(9).fill(ROUTINE) }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { ...empty, incidents: Array(33).fill(INCIDENT) }]]],
    [(f) => listRoutines(f, 'team_1'), [[200, { team_id: 'team_1', routines: [], runs: [] }]]],
    [(f) => resumeRoutine(f, 'team_1', ROUTINE.routine_id), [[200, { team_id: 'team_1', routine_id: ROUTINE.routine_id, paused: true }]]],
    [(f) => stopRoutineRun(f, 'team_1', LEASED.run_id), [[200, { team_id: 'team_1', run_id: 'd'.repeat(32), stopped: true }]]],
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
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'x' }, 'skip'),
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
  const continuous = { kind: 'continuous', gap: 5, cap: 1000 };
  assert.equal(scheduleWords(continuous, words, 'en'), 'Every 5 s after each run, up to 1,000 a day');
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    assert.doesNotMatch(scheduleWords(continuous, catalog.schedule, locale), /\{/, locale);
  }
  assert.equal(instantWords('2026-10-05T12:00:00Z', 'en', 'America/Sao_Paulo'), 'Oct 5, 2026, 9:00 AM');
  assert.match(minuteWords('2026-10-05T12:01:00Z', 'en'), /:01/);
  assert.equal(fillRoutineCopy('{a} and {missing}', { a: 1 }), '1 and {missing}');
  const errors = routineMessages.en.errors;
  assert.equal(routineErrorMessage(new RoutineError('routine-rate-limit'), errors), errors.full);
  assert.equal(routineErrorMessage(new RoutineError('team-context-unavailable'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('human-request-invalid'), errors), errors.changed);
  assert.equal(routineErrorMessage(new RoutineError('assistant-language-drift'), errors), errors.unavailable);
  assert.equal(routineErrorMessage(new RoutineError('routine-card-expired'), errors), errors.expired);
  assert.equal(routineErrorMessage(new RoutineError('routine-card-stale'), errors), errors.stale);
  assert.equal(routineErrorMessage(new RoutineError('routine-incident-unavailable'), errors), errors.ended);
  assert.equal(routineErrorMessage(new RoutineError('other'), errors), errors.generic);
  assert.equal(routineErrorMessage(new Error('x'), errors), errors.generic);
  const zone = browserTimezone();
  assert.equal(zone === null || isTimezone(zone), true);
});

const DEFINED = {
  name: 'DNS semanal',
  steps: PLAN,
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
  detail: { actions: [['shimpz-cloudflare', 'list-zones']] },
  version: 2,
};
const STEP = { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' };

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
    { ...RUN_ENTRY, outcome: 'recovered', detail: { actions: [['shimpz-cloudflare', 'replace-dns-record']] } },
    { ...RUN_ENTRY, outcome: 'held', detail: STEP },
    { ...RUN_ENTRY, outcome: 'held', detail: { assistant_id: null, action: null } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'exhausted' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'policy' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { assistant_id: null, action: null, reason: 'evidence' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: STEP },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, notice_id: 'f'.repeat(32), id: `${'f'.repeat(32)}:routine`, detail: { missed: 3 } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, detail: { assistants: ['shimpz-cloudflare'] } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 12 } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'list-zones' } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']] } },
    { ...RUN_ENTRY, outcome: 'denied', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'stopped', detail: { actions: [] } },
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
    // A done row names the Actions it carried out, never a reply or a result.
    { ...RUN_ENTRY, detail: { reply: 'Done.' } },
    { ...RUN_ENTRY, detail: { actions: [] } },
    { ...RUN_ENTRY, detail: { actions: [['shimpz-cloudflare', 'list-zones']], result: { ip: '1.2.3.4' } } },
    { ...RUN_ENTRY, outcome: 'uncertain', detail: { actions: [] } },
    { ...RUN_ENTRY, outcome: 'needs-input', detail: { question: 'Which zone?' } },
    { ...RUN_ENTRY, outcome: 'held', detail: { assistant_id: 'shimpz-cloudflare', action: null } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'approve' } },
    // A person's skip is a run outcome; it never stands in for the missed-schedule skip.
    { ...RUN_ENTRY, outcome: 'user-skipped', run_id: null, detail: STEP },
    // A minute's healthy rollup belongs to the Routine, counts at most what its gaps allow, and names no Actions.
    { ...RUN_ENTRY, outcome: 'healthy', detail: { runs: 2 } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 13 } },
    { ...RUN_ENTRY, outcome: 'healthy', run_id: null, detail: { runs: 2, actions: [] } },
    { ...RUN_ENTRY, outcome: 'frozen', detail: { request_kind: 'email', assistant_id: 'x', action: 'y' } },
    { ...RUN_ENTRY, outcome: 'failed', detail: { code: 'Bad Code', actions: [] } },
    { ...RUN_ENTRY, outcome: 'scope-changed', run_id: null, detail: { assistants: [] } },
    { ...RUN_ENTRY, outcome: 'skipped', run_id: null, detail: { missed: 0 } },
    { ...RUN_ENTRY, outcome: 'created', detail: DEFINED },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: { ...DEFINED, steps: [] } },
    { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: { ...DEFINED, actions: [] } },
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

test('a Routine plan projection is admitted only in its closed, bounded form', () => {
  const step = PLAN[0];
  const later = {
    id: 'records',
    assistant: 'shimpz-cloudflare',
    action: 'list-dns-records',
    inputs: [
      { member: 'day', source: 'run_clock', value: 'date' },
      { member: 'zone_id', source: 'step_output', step: 'zones', pointer: '/zones/0/id' },
    ],
    stored_inputs: [],
  };
  assert.equal(isSteps([step, later]), true);
  for (const steps of [
    [],
    'zones',
    [null],
    Array(9).fill(step).map((item, index) => ({ ...item, id: `s${index}` })),
    [step, step],
    [{ ...step, id: 'Bad' }],
    [{ ...step, assistant: 'Bad' }],
    [{ ...step, action: 'Bad action' }],
    [{ ...step, inputs: 'none' }],
    [{ ...step, inputs: [null] }],
    [{ ...step, inputs: [{ member: 'page', source: 'secret', value: '1' }] }],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: '1', extra: true }] }],
    [{ ...step, inputs: [{ member: '', source: 'literal', value: '1' }] }],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: 'x'.repeat(121) }] }],
    [{ ...step, inputs: [{ member: 'page', source: 'literal', value: 'a‮b' }] }],
    [{ ...step, inputs: [{ member: 'b', source: 'literal', value: '1' }, { member: 'a', source: 'literal', value: '1' }] }],
    [step, { ...later, inputs: [{ member: 'day', source: 'run_clock', value: 'weekday' }] }],
    [step, { ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'records', pointer: '/x' }] }],
    [step, { ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: 'x' }] }],
    [step, { ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: 7 }] }],
    [step, { ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: '/'.repeat(257) }] }],
    [step, { ...later, inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: '/​' }] }],
    [{ ...step, stored_inputs: 'api-token' }],
    [{ ...step, stored_inputs: Array(9).fill('a') }],
    [{ ...step, stored_inputs: ['API token'] }],
    [{ ...step, stored_inputs: [7] }],
    [{ ...step, stored_inputs: ['b', 'a'] }],
  ]) {
    assert.equal(isSteps(steps), false, JSON.stringify(steps));
  }
  for (const invalid of [{ ...ROUTINE, steps: [] }, { ...ROUTINE, name: ' padded ' }, { ...ROUTINE, name: 'é' }]) {
    assert.throws(() => parseRoutineView(invalid), RoutineError);
  }
});

test('a recovery card offers exactly Verificar, Pular, and Pausar and is answered once through exact answers', async () => {
  const card = {
    team_id: 'team_1',
    incident_id: INCIDENT.incident_id,
    routine_id: ROUTINE.routine_id,
    revision: 2,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
    nonce: 'c'.repeat(32),
    expires_in: 300,
    choices: ['verify', 'skip', 'pause'],
    recommended: 'verify',
  };
  const answered = { team_id: 'team_1', incident_id: INCIDENT.incident_id, choice: 'verify', verdict: 'occurred', status: 'recovered' };
  let api = fetcher([[200, card], [200, answered]]);
  const opened = await openRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id);
  assert.deepEqual(opened, card);
  assert.deepEqual(await answerRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id, opened, 'verify'), answered);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/card`);
  assert.equal(api.calls[1].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/answer`);
  assert.deepEqual(JSON.parse(api.calls[1].init.body), { nonce: card.nonce, choice: 'verify' });
  const pausing = { ...card, choices: ['pause', 'verify', 'skip'], recommended: 'pause' };
  assert.deepEqual(await openRoutineCard(fetcher([[200, pausing]]).fetch, 'team_1', INCIDENT.incident_id), pausing);
  for (const [choice, body] of [
    ['skip', { ...answered, choice: 'skip', verdict: null, status: 'skipped' }],
    ['pause', { ...answered, choice: 'pause', verdict: null, status: 'paused' }],
    ['verify', { ...answered, verdict: 'inconclusive', status: null }],
    ['verify', { ...answered, verdict: 'policy', status: null }],
    ['verify', { ...answered, verdict: 'unquiesced', status: null }],
    ['verify', { ...answered, verdict: 'unclassified', status: null }],
  ]) {
    api = fetcher([[200, body]]);
    assert.deepEqual(await answerRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id, card, choice), body);
  }
  for (const invalid of [
    { ...card, choices: ['verify', 'skip', 'pause', 'other'] },
    { ...card, choices: ['verify', 'approve', 'pause'] },
    { ...card, choices: ['skip', 'verify', 'pause'] },
    { ...card, incident_id: 'd'.repeat(32) },
    { ...card, team_id: 'team_2' },
    { ...card, assistant_id: null, action: null },
    { ...card, expires_in: 600 },
  ]) {
    await assert.rejects(
      openRoutineCard(fetcher([[200, invalid]]).fetch, 'team_1', INCIDENT.incident_id),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  for (const [choice, body] of [
    ['verify', { ...answered, status: 'skipped' }],
    ['skip', { ...answered, choice: 'skip', verdict: null, status: 'paused' }],
    ['pause', { ...answered, choice: 'skip', verdict: null, status: 'skipped' }],
    ['verify', { ...answered, verdict: 'maybe' }],
  ]) {
    await assert.rejects(
      answerRoutineCard(fetcher([[200, body]]).fetch, 'team_1', INCIDENT.incident_id, card, choice),
      (error) => error.code === 'routine-response-invalid',
    );
  }
  await assert.rejects(
    answerRoutineCard(fetcher([[409, { code: 'routine-card-stale' }]]).fetch, 'team_1', INCIDENT.incident_id, card, 'skip'),
    (error) => error.code === 'routine-card-stale' && error.status === 409,
  );
});

// Team's diagnostics view (ADR-0092 section 8), as its golden vectors state it.
const ATTEMPT = Object.freeze({
  operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
  attempt: 1,
  assistant_id: 'shimpz-cloudflare',
  action: 'replace-dns-record',
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
  for (const diagnostics of [[], [ATTEMPT], [ATTEMPT, transport]]) {
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
});

test("a Routine's status is its most urgent one", () => {
  const routine = { routine_id: 'a'.repeat(32), schedule: { kind: 'daily', time: '09:00' }, paused: false, deleting: false, needs_reconfirm: false };
  const run = (status) => ({ run_id: 'b'.repeat(32), routine_id: routine.routine_id, status });
  const incident = { incident_id: 'c'.repeat(32), routine_id: routine.routine_id };
  assert.equal(routineStatus(routine), 'healthy');
  assert.equal(routineStatus({ ...routine, schedule: { kind: 'continuous', gap: 5, cap: 10 } }), 'continuous');
  assert.equal(routineStatus(routine, [run('leased')]), 'running');
  assert.equal(routineStatus(routine, [run('frozen')]), 'waiting');
  assert.equal(routineStatus({ ...routine, paused: true }, [run('frozen')]), 'paused');
  assert.equal(routineStatus({ ...routine, paused: true, needs_reconfirm: true }), 'reconfirm');
  assert.equal(routineStatus({ ...routine, paused: true }, [], [incident]), 'recovery');
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
  assert.equal(STATUS_WORDS.deleting, undefined);
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
