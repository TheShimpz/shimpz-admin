// Routine scenarios for the owner's preview and the browser tests (ADR-0087, ADR-0092): every Routine notice, a held
// run's recovery card, a paused Routine, a minute rollup, a run's execution details, and the daily-cap question of a
// continuous request. Pure data and state transitions; nothing here reaches a real Admin, Team, Brain, or provider.

const STEPS = Object.freeze([
  {
    id: 'zones',
    assistant: 'shimpz-cloudflare',
    action: 'list-zones',
    inputs: [{ member: 'page', source: 'literal', value: '1' }],
    stored_inputs: ['api-token'],
  },
  {
    id: 'records',
    assistant: 'shimpz-cloudflare',
    action: 'list-dns-records',
    inputs: [{ member: 'zone_id', source: 'step_output', step: 'zones', pointer: '/zones/0/id' }],
    stored_inputs: ['api-token'],
  },
]);

const ROUTINE = Object.freeze({
  name: 'DNS watch',
  steps: STEPS,
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-02T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  paused: false,
});

const id = (digit) => digit.repeat(32);

// The continuous Routine created from chat, healthy and rolling its runs up per minute.
const CONTINUOUS = Object.freeze({
  ...ROUTINE,
  routine_id: id('1'),
  quote: 'Fique conferindo meus registros DNS sem parar, até 500 vezes por dia',
  schedule: { kind: 'continuous', gap: 5, cap: 500 },
});
// A weekly Routine whose run is held for recovery.
const HELD = Object.freeze({
  ...ROUTINE,
  routine_id: id('2'),
  name: 'Weekly DNS update',
  quote: 'Todo domingo às 8h, atualize o registro www',
  schedule: { kind: 'weekly', weekday: 6, time: '08:00' },
  next_run_at: '2026-10-04T11:00:00Z',
});
// A daily Routine its failures paused; nothing holds it, so it resumes from the sidebar or its last row.
const PAUSED = Object.freeze({
  ...ROUTINE,
  routine_id: id('3'),
  name: 'Daily certificates',
  quote: 'Todo dia às 9h, confira meus certificados',
  schedule: { kind: 'daily', time: '09:00' },
  paused: true,
});
// A Routine a person paused from its card; its held run still waits for a decision.
const PAUSED_HELD = Object.freeze({
  ...ROUTINE,
  routine_id: id('4'),
  name: 'Monthly cleanup',
  quote: 'No dia 1 de cada mês, limpe registros antigos',
  schedule: { kind: 'monthly', day: 1, time: '10:00' },
  paused: true,
});

const HELD_RUN = id('5');
const PAUSED_RUN = id('6');
const FAILED_RUN = id('7');

function incident(runId, routine, action) {
  return {
    incident_id: runId,
    routine_id: routine.routine_id,
    quote: routine.quote,
    created_at: '2026-10-01T11:00:07Z',
    assistant_id: 'shimpz-cloudflare',
    action,
  };
}

function row(noticeId, routine, outcome, detail, { run = true, at = '2026-10-01T12:00:00Z', version = 1 } = {}) {
  return {
    id: `${noticeId}:routine`,
    kind: 'routine-run',
    notice_id: noticeId,
    routine_id: routine.routine_id,
    quote: routine.quote,
    run_id: run ? noticeId : null,
    outcome,
    created_at: at,
    detail,
    version,
  };
}

function defined(routine) {
  return { name: routine.name, steps: routine.steps, schedule: routine.schedule, timezone: routine.timezone };
}

const ACTIONS = [['shimpz-cloudflare', 'list-zones'], ['shimpz-cloudflare', 'list-dns-records']];

// The transcript, oldest first: one row of every Routine notice the owner validates.
function history() {
  return [
    row(id('a'), CONTINUOUS, 'created', defined(CONTINUOUS), { run: false, at: '2026-10-01T11:58:00Z' }),
    row(id('b'), HELD, 'changed', defined(HELD), { run: false, at: '2026-10-01T11:58:30Z' }),
    row(id('c'), CONTINUOUS, 'done', { actions: ACTIONS }, { at: '2026-10-01T11:59:10Z' }),
    row(id('d'), CONTINUOUS, 'healthy', { runs: 9 }, { run: false, at: '2026-10-01T12:00:00Z', version: 9 }),
    row(id('e'), HELD, 'recovered', { actions: ACTIONS }, { at: '2026-10-01T12:00:20Z' }),
    row(id('f'), HELD, 'user-skipped', { assistant_id: 'shimpz-cloudflare', action: 'update-dns-record' }),
    row(FAILED_RUN, PAUSED, 'failed', { code: 'assistant-rpc-failed', actions: [ACTIONS[0]] }, { version: 1 }),
    row(HELD_RUN, HELD, 'held', { assistant_id: 'shimpz-cloudflare', action: 'update-dns-record' }, { version: 2 }),
    row(PAUSED_RUN, PAUSED_HELD, 'paused', {
      assistant_id: 'shimpz-cloudflare', action: 'delete-dns-record', reason: 'exhausted',
    }, { version: 3 }),
  ];
}

export function routineLifecycleStart() {
  return {
    routines: [CONTINUOUS, HELD, PAUSED, PAUSED_HELD],
    runs: [],
    incidents: [incident(HELD_RUN, HELD, 'update-dns-record'), incident(PAUSED_RUN, PAUSED_HELD, 'delete-dns-record')],
    history: history(),
  };
}

// Verificar walks through every unresolved verdict, so each of its explanations can be seen in turn.
const VERDICTS = ['inconclusive', 'policy', 'unquiesced', 'unclassified', 'exhausted'];

function card(state, incidentId) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  state.cards = (state.cards ?? 0) + 1;
  // The paused run's step has no verifier, so Team recommends Pausar and puts it first.
  const recommended = incidentId === PAUSED_RUN ? 'pause' : 'verify';
  return {
    status: 200,
    json: {
      team_id: 'marketing',
      incident_id: incidentId,
      routine_id: held.routine_id,
      revision: 1,
      assistant_id: held.assistant_id,
      action: held.action,
      nonce: state.cards.toString(16).padStart(32, '0'),
      expires_in: 300,
      choices: recommended === 'pause' ? ['pause', 'verify', 'skip'] : ['verify', 'skip', 'pause'],
      recommended,
    },
  };
}

function answer(state, incidentId, body) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  const choice = body?.choice;
  const base = { team_id: 'marketing', incident_id: incidentId, choice };
  if (choice === 'verify') {
    state.verified = (state.verified ?? -1) + 1;
    return { status: 200, json: { ...base, verdict: VERDICTS[state.verified % VERDICTS.length], status: null } };
  }
  if (choice === 'skip') {
    state.incidents = state.incidents.filter((item) => item.incident_id !== incidentId);
    return { status: 200, json: { ...base, verdict: null, status: 'skipped' } };
  }
  if (choice === 'pause') {
    state.routines = state.routines.map((item) => (item.routine_id === held.routine_id ? { ...item, paused: true } : item));
    return { status: 200, json: { ...base, verdict: null, status: 'paused' } };
  }
  return { status: 400, json: { code: 'invalid-body' } };
}

// The failed run's execution details: a handled failure whose text is shown escaped, then a transport condition.
function diagnostics(runId) {
  const attempt = (number, failure, condition) => ({
    operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
    attempt: number,
    assistant_id: 'shimpz-cloudflare',
    action: runId === FAILED_RUN ? 'list-zones' : 'update-dns-record',
    recorded_at: `2026-10-01T11:5${number}:03Z`,
    failure,
    condition,
  });
  const items = runId === FAILED_RUN || runId === HELD_RUN
    ? [
      attempt(1, {
        error_type: 'httpx.HTTPStatusError',
        message: "Client error '404 Not Found' for url 'https://api.cloudflare.com/client/v4/zones/[REDACTED]' <b>escaped</b>",
        provider: 'api.cloudflare.com',
        http_status: 404,
        response_excerpt: '{"success":false,"errors":[{"code":7003,"message":"Could not route"}]}',
        redacted: true,
        truncated: false,
      }, null),
      attempt(2, null, 'exit-status:1'),
      attempt(3, null, 'timeout'),
    ]
    : [];
  return { status: 200, json: { team_id: 'marketing', run_id: runId, diagnostics: items } };
}

/** The recovery card, its answers, and a run's execution details, for every scenario's Marketing Team. */
export function routineRecoveryRoutes(state, method, path, body) {
  const base = '/api/teams/marketing/routines';
  const opened = path.match(new RegExp(`^${base}/incidents/([0-9a-f]{32})/(card|answer)$`));
  if (opened && method === 'POST') {
    state.incidents ??= [];
    return opened[2] === 'card' ? card(state, opened[1]) : answer(state, opened[1], body);
  }
  const details = path.match(new RegExp(`^${base}/runs/([0-9a-f]{32})/diagnostics$`));
  if (details && method === 'GET') return diagnostics(details[1]);
  return null;
}

// The continuous request with no daily cap, asked as Brain asks it: each option names its daily cap.
export const CAP_CLARIFICATION = Object.freeze({
  question: 'Qual limite diário de execuções você prefere?',
  options: [
    { label: 'Até 100 execuções por dia', description: '' },
    { label: 'Até 500 execuções por dia', description: '' },
    { label: 'Até 1000 execuções por dia', description: '' },
  ],
  default_index: 0,
});

const CAPS = { 'Até 100 execuções por dia': 100, 'Até 500 execuções por dia': 500, 'Até 1000 execuções por dia': 1000 };

/**
 * The daily-cap question of a continuous request, then the Routine its answer creates with its created notice; any
 * other answer is asked again. Returns the chat frame Team would send.
 */
export function capReply(state, message, teamName) {
  const answer = message.match(/\n(?:Resposta|Answer): (.+)$/u)?.[1];
  const base = { type: 'done', team_id: 'marketing', team_name: teamName };
  const cap = CAPS[answer];
  if (!cap) {
    return {
      ...base,
      reply: `${CAP_CLARIFICATION.question}\n\n${CAP_CLARIFICATION.options
        .map((option, index) => `${index + 1}. ${option.label}${index === CAP_CLARIFICATION.default_index ? ' ✓' : ''}`)
        .join('\n')}`,
      clarification: structuredClone(CAP_CLARIFICATION),
    };
  }
  state.sequence += 1;
  const routine = {
    ...CONTINUOUS,
    routine_id: `9${state.sequence.toString(16)}`.padStart(32, '0'),
    quote: message.split('\n')[0].slice(0, 200),
    schedule: { kind: 'continuous', gap: 5, cap },
  };
  state.routines = [...state.routines, routine];
  const noticeId = `7${state.sequence.toString(16)}`.padStart(32, '0');
  state.history = [...state.history, row(noticeId, routine, 'created', defined(routine), { run: false })];
  return { ...base, reply: `Pronto: a rotina roda a cada 5 s após cada execução, até ${cap} por dia.`, clarification: null };
}
