// Routine scenarios for the owner's preview and the browser tests (ADR-0087, ADR-0092): every Routine notice, a held
// run's recovery card with the error its step returned (a Cloudflare account out of credits), a paused Routine, a
// minute rollup, a run's execution details and step records, a 120-step plan read page by page, and the daily-cap
// question of a continuous request. Pure data and state transitions; nothing here reaches a real Admin, Team, Brain,
// or provider.

// A projected step at its 1-based position: on the wire a step is named by position (ADR-0092 amendment, scale).
const step = (position, action, inputs) => ({
  position, assistant: 'shimpz-cloudflare', action, inputs, stored_inputs: ['api-token'],
});
const fromStep = (member, from, pointer) => ({ member, source: 'step_output', step: from, pointer });
const ZONES = step(1, 'list-zones', [{ member: 'page', source: 'literal', value: '1' }]);
const STEPS = Object.freeze([ZONES, step(2, 'list-dns-records', [fromStep('zone_id', 1, '/zones/0/id')])]);
// The continuous watch checks every zone's records: one Action, repeated as often as the person asked.
const WATCH = Object.freeze([
  ZONES,
  ...Array.from({ length: 119 }, (_, index) => step(index + 2, 'list-dns-records', [fromStep('zone_id', 1, `/zones/${index}/id`)])),
]);
const PAGE_STEPS = 64;
const MAX_SUMMARY_RUNS = 16;

/** A revision's plan summary as Team projects it: runs of consecutive equal Actions, at most 16, then a count. */
export function planSummary(steps, revision = 1) {
  const runs = [];
  for (const item of steps) {
    const last = runs.at(-1);
    if (last && last[0] === item.assistant && last[1] === item.action) last[2] += 1;
    else runs.push([item.assistant, item.action, 1]);
  }
  const actions = runs.slice(0, MAX_SUMMARY_RUNS);
  return {
    revision,
    // Each revision has its own digest.
    plan_digest: `sha256:${'0123456789abcdef'[(12 + revision) % 16].repeat(64)}`,
    steps: steps.length,
    actions,
    more: steps.length - actions.reduce((sum, run) => sum + run[2], 0),
  };
}

const ROUTINE = Object.freeze({
  name: 'DNS watch',
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-02T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
  paused: false,
});

// Every fixture text in the preview's interface language, so a Routine's name and request read as the Admin does.
export const ROUTINE_TEXT = Object.freeze({
  en: {
    names: ["DNS watch", "Weekly www update", "Certificate check", "Monthly DNS cleanup"],
    quotes: ["Keep checking my DNS records nonstop, up to 500 times a day", "Every Sunday at 8, update the www record", "Every day at 9, check my certificates", "On the 1st of every month, clean up old DNS records"],
    capQuestion: "Which daily run limit do you prefer?",
    capLabel: "Up to {cap} runs a day",
    capReply: "Done: it runs every 5 s after each run, up to {cap} a day.",
  },
  pt: {
    names: ["Vigia de DNS", "Atualização semanal do www", "Verificação de certificados", "Limpeza mensal de DNS"],
    quotes: ["Fique conferindo meus registros DNS sem parar, até 500 vezes por dia", "Todo domingo às 8h, atualize o registro www", "Todo dia às 9h, confira meus certificados", "No dia 1 de cada mês, limpe registros DNS antigos"],
    capQuestion: "Qual limite diário de execuções você prefere?",
    capLabel: "Até {cap} execuções por dia",
    capReply: "Pronto: ela roda a cada 5 s após cada execução, até {cap} por dia.",
  },
  es: {
    names: ["Vigilancia de DNS", "Actualización semanal de www", "Revisión de certificados", "Limpieza mensual de DNS"],
    quotes: ["Sigue revisando mis registros DNS sin parar, hasta 500 veces al día", "Cada domingo a las 8, actualiza el registro www", "Todos los días a las 9, revisa mis certificados", "El día 1 de cada mes, limpia los registros DNS antiguos"],
    capQuestion: "¿Qué límite diario de ejecuciones prefieres?",
    capLabel: "Hasta {cap} ejecuciones al día",
    capReply: "Listo: se ejecuta cada 5 s tras cada ejecución, hasta {cap} al día.",
  },
  zh: {
    names: ["DNS 监控", "每周更新 www", "证书检查", "每月 DNS 清理"],
    quotes: ["不停地检查我的 DNS 记录，每天最多 500 次", "每周日 8 点，更新 www 记录", "每天 9 点，检查我的证书", "每月 1 日，清理旧的 DNS 记录"],
    capQuestion: "你希望每天最多运行多少次？",
    capLabel: "每天最多 {cap} 次",
    capReply: "好了：每次运行结束 5 秒后再次运行，每天最多 {cap} 次。",
  },
  fr: {
    names: ["Veille DNS", "Mise à jour hebdomadaire de www", "Vérification des certificats", "Nettoyage DNS mensuel"],
    quotes: ["Vérifie mes enregistrements DNS en continu, jusqu’à 500 fois par jour", "Chaque dimanche à 8 h, mets à jour l’enregistrement www", "Tous les jours à 9 h, vérifie mes certificats", "Le 1er de chaque mois, nettoie les anciens enregistrements DNS"],
    capQuestion: "Quelle limite quotidienne d’exécutions préférez-vous ?",
    capLabel: "Jusqu’à {cap} exécutions par jour",
    capReply: "C’est fait : elle s’exécute toutes les 5 s après chaque exécution, jusqu’à {cap} par jour.",
  },
  de: {
    names: ["DNS-Wache", "Wöchentliches www-Update", "Zertifikatsprüfung", "Monatliche DNS-Bereinigung"],
    quotes: ["Prüfe meine DNS-Einträge ununterbrochen, bis zu 500-mal am Tag", "Jeden Sonntag um 8 Uhr den www-Eintrag aktualisieren", "Jeden Tag um 9 Uhr meine Zertifikate prüfen", "Am 1. jedes Monats alte DNS-Einträge bereinigen"],
    capQuestion: "Welches tägliche Ausführungslimit bevorzugst du?",
    capLabel: "Bis zu {cap} Ausführungen pro Tag",
    capReply: "Erledigt: Sie läuft alle 5 s nach jeder Ausführung, bis zu {cap} pro Tag.",
  },
  ja: {
    names: ["DNS 監視", "www の週次更新", "証明書チェック", "毎月の DNS 整理"],
    quotes: ["DNS レコードを休まず確認して、1 日最大 500 回まで", "毎週日曜 8 時に www レコードを更新して", "毎日 9 時に証明書を確認して", "毎月 1 日に古い DNS レコードを整理して"],
    capQuestion: "1 日の実行上限はどれにしますか？",
    capLabel: "1 日最大 {cap} 回",
    capReply: "完了：各実行の 5 秒後に再実行し、1 日最大 {cap} 回です。",
  },
  ar: {
    names: ["مراقبة DNS", "تحديث www الأسبوعي", "فحص الشهادات", "تنظيف DNS الشهري"],
    quotes: ["واصل فحص سجلات DNS دون توقف، حتى 500 مرة يوميًا", "كل يوم أحد الساعة 8، حدّث سجل www", "كل يوم الساعة 9، افحص شهاداتي", "في اليوم الأول من كل شهر، نظّف سجلات DNS القديمة"],
    capQuestion: "ما الحد اليومي لعمليات التشغيل الذي تفضّله؟",
    capLabel: "حتى {cap} تشغيل يوميًا",
    capReply: "تم: يعمل كل 5 ث بعد كل تشغيل، حتى {cap} يوميًا.",
  },
});

const id = (digit) => digit.repeat(32);
const textFor = (locale) => ROUTINE_TEXT[locale] ?? ROUTINE_TEXT.en;

// The continuous Routine created from chat, healthy and rolling its runs up per minute as it hands each result on; a
// weekly Routine that shows its records after every run and whose run is held for recovery; a daily Routine that shows
// its zones only when they change, which its failures paused; and a monthly one that shows nothing, which a person
// paused from its card while its held run still waits for a decision (ADR-0092 amendment, 2026-10-05, output).
const UPDATE = step(3, 'update-dns-record', [fromStep('record_id', 2, '/records/0/id')]);
const DELETE = step(3, 'delete-dns-record', [fromStep('record_id', 2, '/records/2/id')]);
// Each lifecycle Routine's current steps, which its list view summarizes and its plan pages project.
const PLANS = [WATCH, [...STEPS, UPDATE], STEPS, [...STEPS, DELETE]];

function routines(locale) {
  const { names, quotes } = textFor(locale);
  return [
    { ...ROUTINE, routine_id: id('1'), output: { mode: 'chain', step: null }, schedule: { kind: 'continuous', gap: 5, cap: 500 } },
    {
      ...ROUTINE,
      routine_id: id('2'),
      output: { mode: 'show', step: 2 },
      schedule: { kind: 'weekly', weekday: 6, time: '08:00' },
      next_run_at: '2026-10-04T11:00:00Z',
    },
    {
      ...ROUTINE,
      routine_id: id('3'),
      output: { mode: 'changes', step: 1 },
      schedule: { kind: 'daily', time: '09:00' },
      paused: true,
    },
    {
      ...ROUTINE,
      routine_id: id('4'),
      output: { mode: 'none', step: null },
      schedule: { kind: 'monthly', day: 1, time: '10:00' },
      paused: true,
    },
  ].map((routine, index) => ({ ...routine, plan: planSummary(PLANS[index]), name: names[index], quote: quotes[index] }));
}

const HELD_RUN = id('5');
const PAUSED_RUN = id('6');
const FAILED_RUN = id('7');

// A held run's incident names the step it was held at by position among its plan's steps.
function incident(runId, routine, held) {
  return {
    incident_id: runId,
    routine_id: routine.routine_id,
    quote: routine.quote,
    created_at: '2026-10-01T11:00:07Z',
    ...held,
  };
}

const placed = (action, position, total) => ({ assistant_id: 'shimpz-cloudflare', action, step: position, steps: total });

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
  return {
    name: routine.name, plan: routine.plan, output: routine.output, schedule: routine.schedule, timezone: routine.timezone,
  };
}

const text = (value) => ({ kind: 'text', value, cut: false });
const fields = (...pairs) => ({ kind: 'fields', fields: pairs, omitted: 0 });
// What a run shows of its result: Team's bounded, redacted projection of the Action's validated result, as plain data.
const number = (value) => ({ kind: 'number', value });
const account = { kind: 'fields', fields: [['id', text('023e105f4ecef8ad9ca31a8372d0c353')], ['name', text('Shimpz Marketing')]], omitted: 0 };
const zone = (zoneId, name, paused, status, type) => fields(
  ['account', account],
  ['id', text(zoneId)],
  ['name', text(name)],
  ['paused', { kind: 'bool', value: paused }],
  ['status', text(status)],
  ['type', text(type)],
);
// Cloudflare's zone list as Team projects it: its paging as single values, then each zone with its nested account.
export const SHOWN_ZONES = Object.freeze({
  step: 1,
  state: 'shown',
  value: fields(
    ['page', number('1')],
    ['per_page', number('20')],
    ['total_count', number('3')],
    ['total_pages', number('1')],
    ['zones', {
      kind: 'list',
      items: [
        zone('9a7806061c88ada191ed06f989cc3dac', 'example.com', false, 'active', 'full'),
        zone('4b2b5b3e9d0c4f0aa1b7c6d5e4f30211', 'example.org', true, 'pending', 'full'),
        zone('c5d1f0e2a3b44c6d8e9f0a1b2c3d4e5f', '<img src=x onerror=alert(1)>.dev', false, 'active', 'partial'),
      ],
      omitted: 0,
    }],
  ),
  truncated: false,
});
const SHOWN_RECORDS = Object.freeze({
  step: 2,
  state: 'shown',
  value: fields(['records', {
    kind: 'list',
    items: [
      fields(['content', text('192.0.2.10')], ['name', text('example.com')], ['type', text('A')]),
      fields(['content', { kind: 'redacted' }], ['name', text('_token.example.com')], ['type', text('TXT')]),
    ],
    omitted: 4,
  }]),
  truncated: true,
});

// The transcript, oldest first: one row of every Routine notice the owner validates. Its rows span the day before the
// preview opened and that day itself, so the transcript shows a day header for each and today's replacing yesterday's.
function history([CONTINUOUS, HELD, PAUSED, PAUSED_HELD], now) {
  const second = 1_000;
  const opened = Math.floor(now / second) * second;
  const at = (offset) => new Date(opened + offset * second).toISOString().replace('.000Z', 'Z');
  const yesterday = (offset) => at(offset - 86_400);
  return [
    row(id('a'), CONTINUOUS, 'created', defined(CONTINUOUS), { run: false, at: yesterday(-120) }),
    row(id('b'), HELD, 'changed', defined(HELD), { run: false, at: yesterday(-90) }),
    row(id('c'), CONTINUOUS, 'done', { plan: CONTINUOUS.plan, output: null }, { at: yesterday(-50) }),
    row(id('d'), CONTINUOUS, 'healthy', { runs: 9 }, { run: false, at: yesterday(0), version: 9 }),
    row(id('e'), HELD, 'recovered', { plan: HELD.plan, output: SHOWN_RECORDS }, { at: yesterday(20) }),
    row(id('8'), PAUSED, 'done', { plan: PAUSED.plan, output: SHOWN_ZONES }, { at: yesterday(40) }),
    row(id('f'), HELD, 'user-skipped', { ...placed('update-dns-record', 3, 3), choice: 'run' }, { at: at(-150) }),
    row(FAILED_RUN, PAUSED, 'failed', { code: 'assistant-rpc-failed', actions: [], step: 1, steps: 2 }, {
      at: at(-120), version: 1,
    }),
    row(HELD_RUN, HELD, 'held', placed('update-dns-record', 3, 3), { at: at(-90), version: 2 }),
    row(PAUSED_RUN, PAUSED_HELD, 'paused', { ...placed('delete-dns-record', 3, 3), reason: 'exhausted' }, {
      at: at(-60), version: 3,
    }),
  ];
}

export function routineLifecycleStart(locale = 'en', now = Date.now()) {
  const listed = routines(locale);
  const [, HELD, , PAUSED_HELD] = listed;
  return {
    routines: listed,
    plans: Object.fromEntries(listed.map((routine, index) => [routine.routine_id, PLANS[index]])),
    runs: [],
    incidents: [
      incident(HELD_RUN, HELD, placed('update-dns-record', 3, 3)),
      incident(PAUSED_RUN, PAUSED_HELD, placed('delete-dns-record', 3, 3)),
    ],
    history: history(listed, now),
  };
}

/** A person set a held run aside (Rodar, Recriar, or its Routine's deletion): its row says how; nothing was undone. */
export function setAside(state, incidentId, choice) {
  const held = (state.incidents ?? []).find((item) => item.incident_id === incidentId);
  if (!held) return;
  state.incidents = state.incidents.filter((item) => item.incident_id !== incidentId);
  state.history = state.history.map((entry) => (entry.run_id === incidentId
    ? {
      ...entry,
      outcome: 'user-skipped',
      detail: { assistant_id: held.assistant_id, action: held.action, step: held.step, steps: held.steps, choice },
      version: entry.version + 1,
    }
    : entry));
}

function card(state, incidentId) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  state.cards = (state.cards ?? 0) + 1;
  const failed = diagnostics(incidentId).json.diagnostics.at(-1) ?? null;
  return {
    status: 200,
    json: {
      team_id: 'marketing',
      incident_id: incidentId,
      routine_id: held.routine_id,
      revision: 1,
      assistant_id: held.assistant_id,
      action: held.action,
      step: held.step,
      steps: held.steps,
      evidence: failed ? 'recorded' : 'absent',
      diagnostic: failed,
      nonce: state.cards.toString(16).padStart(32, '0'),
      expires_in: 300,
      choices: ['run', 'recreate', 'delete'],
    },
  };
}

// Rodar sets the held run aside and starts the Routine again; Recriar rebuilds it from its original request. The
// monthly Routine's original request no longer compiles, so its Recriar is refused and nothing changes.
function answer(state, incidentId, body) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  const choice = body?.choice;
  if (choice !== 'run' && choice !== 'recreate') return { status: 400, json: { code: 'invalid-body' } };
  if (choice === 'recreate' && incidentId === PAUSED_RUN) {
    return { status: 422, json: { code: 'routine-recreate-refused' } };
  }
  setAside(state, incidentId, choice);
  state.routines = state.routines.map((item) => (item.routine_id === held.routine_id ? { ...item, paused: false } : item));
  if (choice === 'recreate') {
    // Recreating compiles the Routine again: a new revision of the same steps.
    state.routines = state.routines.map((item) => (item.routine_id === held.routine_id
      ? { ...item, plan: planSummary(state.plans[item.routine_id], item.plan.revision + 1) }
      : item));
    const routine = state.routines.find((item) => item.routine_id === held.routine_id);
    state.sequence = (state.sequence ?? 0) + 1;
    const noticeId = `8${state.sequence.toString(16)}`.padStart(32, '0');
    state.history = [...state.history, row(noticeId, routine, 'changed', defined(routine), { run: false })];
  }
  const status = choice === 'run' ? 'requested' : 'recreated';
  return { status: 200, json: { team_id: 'marketing', incident_id: incidentId, choice, status } };
}

// Each held step's execution details. The weekly Routine's update hit a Cloudflare account out of credits; the monthly
// Routine's delete was refused its permission; the failed run's attempts show a handled failure whose text is shown
// escaped, then transport conditions.
function diagnostics(runId) {
  const POSITIONS = { 'list-zones': 1, 'list-dns-records': 2, 'update-dns-record': 3, 'delete-dns-record': 3 };
  const attempt = (number, action, failure, condition) => ({
    operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
    attempt: number,
    assistant_id: 'shimpz-cloudflare',
    action,
    step: POSITIONS[action],
    recorded_at: `2026-10-01T11:5${number}:03Z`,
    failure,
    condition,
  });
  const failure = (status, message, excerpt) => ({
    error_type: 'httpx.HTTPStatusError',
    message,
    provider: 'api.cloudflare.com',
    http_status: status,
    response_excerpt: excerpt,
    redacted: true,
    truncated: false,
  });
  const url = 'https://api.cloudflare.com/client/v4/zones/[REDACTED]/dns_records/[REDACTED]';
  const items = {
    // The recovered run's DNS record list was refused once before its recovery completed it.
    [id('e')]: [
      attempt(1, 'list-dns-records', failure(
        429,
        `Client error '429 Too Many Requests' for url '${url}'`,
        '{"success":false,"errors":[{"code":10429,"message":"Rate limited"}]}',
      ), null),
    ],
    [HELD_RUN]: [
      attempt(1, 'update-dns-record', failure(
        402,
        `Client error '402 Payment Required' for url '${url}'`,
        '{"success":false,"errors":[{"code":10402,"message":"Insufficient account credits: add credits to continue"}]}',
      ), null),
    ],
    [PAUSED_RUN]: [
      attempt(1, 'delete-dns-record', failure(
        403,
        `Client error '403 Forbidden' for url '${url}'`,
        '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
      ), null),
    ],
    [FAILED_RUN]: [
      attempt(1, 'list-zones', failure(
        404,
        "Client error '404 Not Found' for url 'https://api.cloudflare.com/client/v4/zones/[REDACTED]' <b>escaped</b>",
        '{"success":false,"errors":[{"code":7003,"message":"Could not route"}]}',
      ), null),
      attempt(2, 'list-zones', null, 'exit-status:1'),
      attempt(3, 'list-zones', null, 'timeout'),
    ],
  }[runId] ?? [];
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

// What lifecycle runs did, step by step: their records, kept as one snapshot each.
const SNAPSHOT = 'c'.repeat(32);
const record = (position, status, action, { attempt = 1, duration = 640 + position * 37, inputs = [] } = {}) => ({
  position,
  status,
  assistant_id: 'shimpz-cloudflare',
  action,
  attempt,
  duration_ms: status === 'recovered' ? null : duration,
  recorded_at: new Date(Date.UTC(2026, 8, 30, 12, 0, 10 + position)).toISOString().replace('.000Z', 'Z'),
  inputs,
});
const RUN_RECORDS = {
  // The recovered run's DNS record list was rate limited once, and its recovery verified it.
  [id('e')]: [
    record(1, 'done', 'list-zones', { inputs: [{ member: 'page', source: 'literal', value: '1' }] }),
    record(2, 'recovered', 'list-dns-records', { attempt: 2, inputs: [{ member: 'zone_id', source: 'step_output', value: '"9a7806061c88ada191ed06f989cc3dac"' }] }),
    record(3, 'done', 'update-dns-record', { inputs: [{ member: 'record_id', source: 'step_output', value: null }] }),
  ],
  [id('8')]: [
    record(1, 'done', 'list-zones', { inputs: [{ member: 'page', source: 'literal', value: '1' }] }),
    record(2, 'done', 'list-dns-records', { inputs: [{ member: 'zone_id', source: 'step_output', value: '"9a7806061c88ada191ed06f989cc3dac"' }] }),
  ],
  // The continuous watch's completed run hands its result on and shows none; each zone's records were listed.
  [id('c')]: WATCH.map((item) => record(item.position, 'done', item.action, {
    inputs: item.position === 1 ? [{ member: 'page', source: 'literal', value: '1' }] : [{ member: 'zone_id', source: 'step_output', value: null }],
  })),
  // The failed run's zone list failed on its third attempt, so the run never started its second step.
  [FAILED_RUN]: [
    record(1, 'failed', 'list-zones', { attempt: 3, inputs: [{ member: 'page', source: 'literal', value: '1' }] }),
    { position: 2, status: 'not_run', assistant_id: null, action: null, attempt: null, duration_ms: null, recorded_at: null, inputs: null },
  ],
};

/** One page of a revision's projected steps from `offset`: whole consecutive steps, at most 64. */
export function planPage(routineId, plan, steps, offset) {
  const page = steps.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === steps.length ? null : offset + page.length;
  return { routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest, total: steps.length, offset, steps: page, next };
}

/** One page of a run's step records from `offset`, of one snapshot, bound to the revision its notice summarizes. */
export function runStepsPage(runId, routineId, plan, records, { snapshot = SNAPSHOT, offset = 0, ended = true } = {}) {
  const page = records.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === records.length ? null : offset + page.length;
  return {
    team_id: 'marketing', run_id: runId, routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest,
    total: plan.steps, snapshot, ended, offset, steps: page, next,
  };
}

/**
 * A Routine's plan pages and a run's step records (ADR-0092 amendment, 2026-10-05, scale): a page of the Routine's
 * current revision, refused when the reader names another, and a page of a run's one snapshot of records.
 */
export function routineStepRoutes(state, method, path) {
  if (method !== 'GET') return null;
  const base = '/api/teams/marketing/routines';
  const plan = path.match(new RegExp(`^${base}/([0-9a-f]{32})/revisions/([0-9]+)/steps/([0-9]+)$`));
  if (plan) {
    const routine = state.routines.find((item) => item.routine_id === plan[1]);
    const steps = state.plans?.[plan[1]];
    if (!routine || !steps) return { status: 404, json: { code: 'routine-not-found' } };
    if (Number(plan[2]) !== routine.plan.revision) return { status: 409, json: { code: 'routine-revision-changed' } };
    if (Number(plan[3]) >= steps.length) return { status: 404, json: { code: 'routine-steps-not-found' } };
    return { status: 200, json: planPage(routine.routine_id, routine.plan, steps, Number(plan[3])) };
  }
  const run = path.match(new RegExp(`^${base}/runs/([0-9a-f]{32})/steps/(latest|[0-9a-f]{32})/([0-9]+)$`));
  if (run) {
    const notice = state.history.find((entry) => entry.run_id === run[1]);
    const records = RUN_RECORDS[run[1]];
    // A completed run's notice names the revision it carried out; any other run carried out its Routine's current one.
    const plan = notice?.detail.plan ?? state.routines.find((item) => item.routine_id === notice?.routine_id)?.plan;
    if (!plan || !records) return { status: 404, json: { code: 'routine-run-steps-not-found' } };
    if (run[2] !== 'latest' && run[2] !== SNAPSHOT) return { status: 409, json: { code: 'routine-run-changed' } };
    if (Number(run[3]) >= records.length) return { status: 404, json: { code: 'routine-run-steps-not-found' } };
    return { status: 200, json: runStepsPage(run[1], notice.routine_id, plan, records, { offset: Number(run[3]) }) };
  }
  return null;
}

// The continuous request with no daily cap, asked as Brain asks it in the interface language: each option names its cap.
const CAP_OPTIONS = [100, 500, 1000];

export function capClarification(locale = 'en') {
  const text = textFor(locale);
  return {
    question: text.capQuestion,
    options: CAP_OPTIONS.map((cap) => ({ label: text.capLabel.replace('{cap}', String(cap)), description: '' })),
    // A Routine question recommends none of its options (ADR-0092 amendment, 2026-10-05).
    default_index: null,
  };
}

/**
 * The daily-cap question of a continuous request, then the Routine its answer creates with its created notice; any
 * other answer is asked again. Returns the chat frame Team would send.
 */
export function capReply(state, message, teamName) {
  const text = textFor(state.locale);
  const asked = capClarification(state.locale);
  const base = { type: 'done', team_id: 'marketing', team_name: teamName };
  const chosen = asked.options.findIndex((option) => message.endsWith(`: ${option.label}`));
  if (chosen < 0) {
    return {
      ...base,
      reply: `${asked.question}\n\n${asked.options
        .map((option, index) => `${index + 1}. ${option.label}${index === asked.default_index ? ' ✓' : ''}`)
        .join('\n')}`,
      clarification: asked,
    };
  }
  const cap = CAP_OPTIONS[chosen];
  state.sequence += 1;
  const routine = {
    ...routines(state.locale)[0],
    routine_id: `9${state.sequence.toString(16)}`.padStart(32, '0'),
    quote: message.split('\n')[0].slice(0, 200),
    schedule: { kind: 'continuous', gap: 5, cap },
  };
  state.routines = [...state.routines, routine];
  state.plans = { ...state.plans, [routine.routine_id]: WATCH };
  const noticeId = `7${state.sequence.toString(16)}`.padStart(32, '0');
  state.history = [...state.history, row(noticeId, routine, 'created', defined(routine), { run: false })];
  return { ...base, reply: text.capReply.replace('{cap}', String(cap)), clarification: null };
}
