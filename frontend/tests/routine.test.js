import assert from 'node:assert/strict';
import test from 'node:test';

import { clockTime } from '../src/lib/chatDays.js';
import { listChatHistory } from '../src/lib/chatHistory.js';
import { parseChatEvent } from '../src/lib/localChat.js';
import {
  answerRoutineCard,
  failureCause,
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
  isDisposition,
  isOutput,
  dispositionWords,
  omittedWords,
  outputScalarWords,
  outputLabels,
  outputTable,
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
  routineNotice,
  scheduleWords,
  stepChain,
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
  output: { mode: 'show', step: 'zones' },
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
// One recorded handled failure of a held step, in Team's sanitized diagnostic view (ADR-0092 section 8).
const ATTEMPT_FAILURE = Object.freeze({
  operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
  attempt: 1,
  assistant_id: 'shimpz-cloudflare',
  action: 'list-zones',
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
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'x' }, 'run'),
    // Excluir is the confirmed deletion, never a card answer; the retired choices are refused before any request.
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'delete'),
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'verify'),
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'skip'),
    () => answerRoutineCard(fetcher([]).fetch, 'team_1', INCIDENT.incident_id, { nonce: 'c'.repeat(32) }, 'pause'),
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
  for (const [code, key] of [
    ['routine-busy', 'busy'],
    ['routine-workload-unquiesced', 'stillRunning'],
    ['routine-contracts-changed', 'contractsChanged'],
    ['routine-source-unavailable', 'sourceUnavailable'],
    ['routine-recreate-refused', 'recreateRefused'],
    ['routine-recreate-unavailable', 'recreateUnavailable'],
    ['routine-recovery-stopped', 'stopped'],
    ['model-credential-missing', 'credentialMissing'],
    ['routine-receipts-full', 'unavailable'],
    ['notices-full', 'unavailable'],
  ]) {
    assert.equal(routineErrorMessage(new RoutineError(code), errors), errors[key], code);
  }
  assert.equal(routineErrorMessage(new RoutineError('other'), errors), errors.generic);
  assert.equal(routineErrorMessage(new Error('x'), errors), errors.generic);
  const zone = browserTimezone();
  assert.equal(zone === null || isTimezone(zone), true);
});

const DEFINED = {
  name: 'DNS semanal',
  steps: PLAN,
  output: { mode: 'show', step: 'zones' },
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
  detail: { actions: [['shimpz-cloudflare', 'list-zones']], output: null },
  version: 2,
};
const STEP = { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' };
// A run's shown result: Team's bounded projection of the zones it listed, one cut, and a value Team redacted.
const SHOWN_OUTPUT = Object.freeze({
  step: 'zones',
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
const UNSHOWN = Object.freeze({ step: 'zones', state: 'unavailable', value: null, truncated: false });

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
    { ...RUN_ENTRY, outcome: 'recovered', detail: { actions: [['shimpz-cloudflare', 'replace-dns-record']], output: null } },
    { ...RUN_ENTRY, outcome: 'held', detail: STEP },
    { ...RUN_ENTRY, outcome: 'held', detail: { assistant_id: null, action: null } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'exhausted' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { ...STEP, reason: 'policy' } },
    { ...RUN_ENTRY, outcome: 'paused', detail: { assistant_id: null, action: null, reason: 'evidence' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { ...STEP, choice: 'run' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { ...STEP, choice: 'recreate' } },
    { ...RUN_ENTRY, outcome: 'user-skipped', detail: { assistant_id: null, action: null, choice: 'delete' } },
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

// A notice as the transcript's timeline shows it, in Portuguese.
function noticeShown(entry, options) {
  return routineNotice(parseRoutineRunEntry(entry), {
    copy: routineMessages.pt, locale: 'pt', assistantName: () => 'Shimpz Cloudflare', ...options,
  });
}

test('every Routine notice reads as a status phrase colored by meaning, its time, and one quiet detail line', () => {
  const chain = 'Shimpz Cloudflare · List zones › List DNS records';
  const zones = [['shimpz-cloudflare', 'list-zones']];
  const cases = [
    // A Routine that shows its result carries Team's projection apart from its words (ADR-0092, 2026-10-05).
    [{ outcome: 'done', detail: { actions: zones, output: SHOWN_OUTPUT } },
      ['healthy', 'concluída', ['Shimpz Cloudflare · List zones'], '', SHOWN_OUTPUT]],
    [{ outcome: 'done', detail: { actions: zones, output: { ...UNSHOWN, state: 'unchanged' } } },
      ['healthy', 'concluída', ['Shimpz Cloudflare · List zones', 'Nada mudou desde o último resultado mostrado.'], '']],
    [{ outcome: 'recovered', detail: { actions: zones, output: UNSHOWN } },
      ['healthy', 'concluída após recuperação', ['Shimpz Cloudflare · List zones', 'Não foi possível mostrar o resultado.'], '']],
    [{ outcome: 'done', detail: { actions: [['shimpz-cloudflare', 'list-zones'], ['shimpz-cloudflare', 'list-dns-records']], output: null } },
      ['healthy', 'concluída', [chain], '']],
    [{ outcome: 'recovered', detail: { actions: [['shimpz-cloudflare', 'list-zones']], output: null } },
      ['healthy', 'concluída após recuperação', ['Shimpz Cloudflare · List zones'], '']],
    [{ outcome: 'healthy', run_id: null, detail: { runs: 9 } },
      ['healthy', 'em execução', [`9 execuções concluídas no minuto das ${minuteWords(RUN_ENTRY.created_at, 'pt')}`], '']],
    [{ outcome: 'failed', detail: { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']] } },
      ['danger', 'falhou', ['Shimpz Cloudflare · List zones'], 'assistant-rpc-failed']],
    [{ outcome: 'failed', detail: { code: 'assistant-rpc-failed', actions: [] } }, ['danger', 'falhou', [], 'assistant-rpc-failed']],
    [{ outcome: 'denied', detail: { actions: [] } }, ['danger', 'negada', [], '']],
    [{ outcome: 'held', detail: STEP }, ['danger', 'parou com erro', ['Shimpz Cloudflare · Replace DNS record'], '']],
    // A held step the listed Routine holds exactly once is placed among its steps.
    [{ outcome: 'held', detail: STEP }, ['danger', 'parou com erro', ['Etapa 2 de 2: Shimpz Cloudflare · Replace DNS record'], ''],
      { steps: [PLAN[0], { ...PLAN[0], id: 'replace', action: 'replace-dns-record' }] }],
    [{ outcome: 'paused', detail: { ...STEP, reason: 'exhausted' } }, ['waiting', 'pausada', ['O limite de recuperação acabou.'], '']],
    [{ outcome: 'frozen', detail: { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' } },
      ['waiting', 'aguardando aprovação', ['Shimpz Cloudflare · Replace DNS record'], '']],
    [{ outcome: 'frozen', detail: { request_kind: 'integrations', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' } },
      ['waiting', 'aguardando conexão', ['Shimpz Cloudflare · Replace DNS record'], '']],
    [{ outcome: 'scope-changed', run_id: null, detail: { assistants: ['shimpz-cloudflare'] } },
      ['waiting', 'pausada', ['Seus Assistants mudaram (Shimpz Cloudflare). Peça de novo no chat para atualizá-la.'], '']],
    [{ outcome: 'stopped', detail: { actions: [['shimpz-cloudflare', 'list-zones']] } },
      ['neutral', 'interrompida', ['Shimpz Cloudflare · List zones'], '']],
    [{ outcome: 'user-skipped', detail: { ...STEP, choice: 'recreate' } },
      ['neutral', 'deixada de lado', ['A rotina foi recriada. O que essa execução pode ter alterado não foi conferido.'], '']],
    [{ outcome: 'skipped', run_id: null, detail: { missed: 1 } }, ['neutral', 'execuções perdidas', ['1 execução agendada não aconteceu'], '']],
    [{ outcome: 'skipped', run_id: null, detail: { missed: 3 } }, ['neutral', 'execuções perdidas', ['3 execuções agendadas não aconteceram'], '']],
    [{ outcome: 'created', run_id: null, detail: { ...DEFINED, schedule: { kind: 'continuous', gap: 5, cap: 500 }, steps: [...PLAN, { ...PLAN[0], id: 'records', action: 'list-dns-records', inputs: [] }] } },
      ['neutral', 'criada', ['A cada 5 s após cada execução, até 500 por dia · America/Sao_Paulo', chain, 'Mostra o resultado da etapa 1 a cada execução'], '']],
    [{ outcome: 'changed', run_id: null, detail: { ...DEFINED, output: { mode: 'none', step: null } } },
      ['neutral', 'atualizada', ['Toda segunda-feira às 09:00 · America/Sao_Paulo', 'Shimpz Cloudflare · List zones', 'Não mostra nada após uma execução'], '']],
  ];
  const time = clockTime(Date.parse(RUN_ENTRY.created_at), 'pt');
  // The notice keeps its seconds (created at 12:01:07 UTC).
  assert.match(time, /^\d{2}:01:07$/);
  for (const [change, [tone, status, lines, code, output = null], options] of cases) {
    assert.deepEqual(noticeShown({ ...RUN_ENTRY, ...change }, options), { tone, status, time, lines, code, output }, change.outcome);
  }
  // Every outcome has its status and detail words in every Admin language.
  for (const [locale, catalog] of Object.entries(routineMessages)) {
    assert.equal(typeof catalog.notice.waiting, 'string', locale);
    for (const [change] of cases) {
      const shown = routineNotice(parseRoutineRunEntry({ ...RUN_ENTRY, ...change }), { copy: catalog, locale, assistantName: (id) => id });
      assert.ok(shown.status, `${locale} ${change.outcome}`);
      assert.ok(shown.lines.every((line) => line && !/\{\w+\}/u.test(line)), `${locale} ${change.outcome}`);
    }
  }
});

test('a notice names its Assistant once for steps that share it and again only where it changes', () => {
  const name = (id) => ({ a: 'Alpha', b: 'Beta' })[id];
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
  const literal = (value) => [{ ...PLAN[0], inputs: [{ member: 'page', source: 'literal', value }] }];
  // Each bound counts the whole string: a preview's JSON quotes, and a pointer's leading slash.
  assert.equal(isSteps(literal(JSON.stringify(emoji.repeat(118)))), true);
  const step = { ...PLAN[0], inputs: [{ member: emoji.repeat(128), source: 'literal', value: preview }] };
  const later = {
    id: 'records',
    assistant: 'shimpz-cloudflare',
    action: 'list-dns-records',
    inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: `/${emoji.repeat(255)}` }],
    stored_inputs: [],
  };
  assert.equal(isSteps([step, later]), true);
  assert.equal(parseRoutineView({ ...ROUTINE, steps: [step, later] }).steps[0].inputs[0].value, preview);
  const created = { ...RUN_ENTRY, outcome: 'created', run_id: null, detail: { ...DEFINED, steps: [step, later] } };
  assert.equal(parseRoutineRunEntry(created).outcome, 'created');
  for (const steps of [
    literal(JSON.stringify(emoji.repeat(119))),
    [{ ...step, inputs: [{ member: emoji.repeat(129), source: 'literal', value: '1' }] }],
    [step, { ...later, inputs: [{ ...later.inputs[0], pointer: `/${emoji.repeat(256)}` }] }],
  ]) {
    assert.equal(isSteps(steps), false, JSON.stringify(steps));
  }
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

test('a recovery card shows its recorded failure, offers exactly Rodar, Recriar, and Excluir, and answers once', async () => {
  const card = {
    team_id: 'team_1',
    incident_id: INCIDENT.incident_id,
    routine_id: ROUTINE.routine_id,
    revision: 2,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
    step: 2,
    steps: 3,
    evidence: 'recorded',
    diagnostic: { ...ATTEMPT_FAILURE, action: 'replace-dns-record' },
    nonce: 'c'.repeat(32),
    expires_in: 300,
    choices: ['run', 'recreate', 'delete'],
  };
  const answered = { team_id: 'team_1', incident_id: INCIDENT.incident_id, choice: 'run', status: 'requested' };
  let api = fetcher([[200, card], [200, answered]]);
  const opened = await openRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id);
  assert.deepEqual(opened, card);
  assert.deepEqual(await answerRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id, opened, 'run'), answered);
  assert.equal(api.calls[0].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/card`);
  assert.equal(api.calls[1].path, `/api/teams/team_1/routines/incidents/${INCIDENT.incident_id}/answer`);
  assert.deepEqual(JSON.parse(api.calls[1].init.body), { nonce: card.nonce, choice: 'run' });
  const recreated = { ...answered, choice: 'recreate', status: 'recreated' };
  api = fetcher([[200, recreated]]);
  assert.deepEqual(await answerRoutineCard(api.fetch, 'team_1', INCIDENT.incident_id, card, 'recreate'), recreated);
  for (const evidence of ['absent', 'unavailable']) {
    const plain = { ...card, evidence, diagnostic: null };
    assert.deepEqual(await openRoutineCard(fetcher([[200, plain]]).fetch, 'team_1', INCIDENT.incident_id), plain);
  }
  for (const invalid of [
    { ...card, choices: ['recreate', 'run', 'delete'] },
    { ...card, choices: ['run', 'recreate'] },
    { ...card, choices: ['verify', 'skip', 'pause'] },
    { ...card, recommended: 'run' },
    { ...card, incident_id: 'd'.repeat(32) },
    { ...card, team_id: 'team_2' },
    { ...card, assistant_id: null, action: null },
    { ...card, expires_in: 600 },
    { ...card, step: 4 },
    { ...card, step: 0 },
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
    ['run', { ...answered, status: 'recreated' }],
    ['recreate', { ...recreated, status: 'requested' }],
    ['run', { ...answered, choice: 'recreate' }],
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
    for (const choice of ['run', 'recreate', 'delete']) assert.equal(typeof catalog.notice.setAside[choice], 'string', locale);
  }
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
    { ...SHOWN_OUTPUT, step: 'Zones' },
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
  // A disposition names one of the plan's steps exactly when it shows one.
  assert.ok(isDisposition({ mode: 'changes', step: 'zones' }, PLAN));
  assert.ok(isDisposition({ mode: 'chain', step: null }, PLAN));
  for (const invalid of [{ mode: 'show', step: 'other' }, { mode: 'none', step: 'zones' }, { mode: 'loud', step: null }, { mode: 'show' }]) {
    assert.equal(isDisposition(invalid, PLAN), false);
  }
  const copy = routineMessages.pt;
  assert.equal(dispositionWords({ mode: 'changes', step: 'zones' }, PLAN, copy.plan), 'Mostra o resultado da etapa 1 só quando ele muda');
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
    ['0.0001', '1.23456', '1e-7', '-12', '123456789012345', '12345678901234567890', '0.1234567890123456789'].map(number),
    ['0,0001', '1,23456', '0,0000001', '-12', '123.456.789.012.345', '12345678901234567890', '0.1234567890123456789'],
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
    for (const key of ['label', 'unchanged', 'unavailable', 'empty', 'yes', 'no', 'redacted', 'truncated']) {
      assert.equal(typeof catalog.notice.output[key], 'string', `${locale} ${key}`);
    }
    for (const mode of ['show', 'changes', 'chain', 'none']) {
      assert.doesNotMatch(dispositionWords({ mode, step: mode === 'show' || mode === 'changes' ? 'zones' : null }, PLAN, catalog.plan), /\{/, locale);
    }
    assert.doesNotMatch(omittedWords(catalog.notice.output, 3, locale), /\{/, locale);
  }
});
