// Routine scenarios for the owner's preview and the browser tests (ADR-0087, ADR-0092, ADR-0101): every Routine notice
// titled by the name Team froze into it, a deleted Routine's last notice, runs' usage with and without a model, a held
// run's recovery card with the error its step returned (a Cloudflare account out of credits), a paused Routine, a
// minute rollup, a run's execution details and step records, a 120-step plan read page by page, the confirmation card
// of the owner's recorded Cloudflare watch, and a recording turn's refusal. Pure data and state transitions; nothing
// here reaches a real Admin, Team, Brain, or provider.

// A projected step at its 1-based position: on the wire a step is named by position (ADR-0092 amendment, scale).
const step = (position, action, inputs, readOnly = true) => ({
  position, assistant: 'shimpz-cloudflare', action, read_only: readOnly, inputs, stored_inputs: ['api-token'],
});
const fromStep = (member, from, pointer) => ({ member, source: 'step_output', step: from, pointer, where: null, item: null });
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

// The Actions a plan may call, each once, and how many of them change something.
function permittedOf(steps) {
  const seen = new Map(steps.map((item) => [`${item.assistant}\u0000${item.action}`, item.read_only]));
  return { total: seen.size, changes: [...seen.values()].filter((readOnly) => !readOnly).length };
}

/** A Routine view as Team lists it: no decision, so no model and no allowance. */
export function routineView(fields, steps) {
  return {
    timezone: 'America/Sao_Paulo',
    timezone_source: 'browser',
    assistant_ids: ['shimpz-cloudflare'],
    next_run_at: '2026-10-02T12:00:00Z',
    needs_reconfirm: false,
    deleting: false,
    state: 'active',
    permitted: permittedOf(steps),
    permissions_revision: 0,
    model: null,
    allowance: 0,
    ...fields,
    plan: fields.plan ?? planSummary(steps),
  };
}

// Every fixture text in the preview's interface language, so a Routine's name, the owner's request, and Team's reply
// read as the Admin does. `names[4]` is a Routine that was deleted; its last notice still names it.
export const ROUTINE_TEXT = Object.freeze({
  en: {
    names: ["DNS watch", "Weekly www update", "Certificate check", "Monthly DNS cleanup", "Old DNS report"],
    card: "shimpz.com DNS",
    request: "Every 30 seconds, list the DNS records of my zone shimpz.com, up to 1,000 times a day",
    cardReply: "I listed your zones and the DNS records of shimpz.com. The Routine below repeats exactly that.",
    refusalRequest: "Every day, log in with my password hunter2 and export the DNS records",
    refusalReply: "I exported the DNS records once.",
    questionReply: "I listed your zones and the DNS records of shimpz.com.",
  },
  pt: {
    names: ["Vigia de DNS", "Atualização semanal do www", "Verificação de certificados", "Limpeza mensal de DNS", "Relatório antigo de DNS"],
    card: "DNS de shimpz.com",
    request: "A cada 30 segundos, liste os registros DNS da minha zona shimpz.com, até 1.000 vezes por dia",
    cardReply: "Listei suas zonas e os registros DNS de shimpz.com. A rotina abaixo repete exatamente isso.",
    refusalRequest: "Todo dia, entre com a minha senha hunter2 e exporte os registros DNS",
    refusalReply: "Exportei os registros DNS uma vez.",
    questionReply: "Listei suas zonas e os registros DNS de shimpz.com.",
  },
  es: {
    names: ["Vigilancia de DNS", "Actualización semanal de www", "Revisión de certificados", "Limpieza mensual de DNS", "Informe antiguo de DNS"],
    card: "DNS de shimpz.com",
    request: "Cada 30 segundos, lista los registros DNS de mi zona shimpz.com, hasta 1.000 veces al día",
    cardReply: "Listé tus zonas y los registros DNS de shimpz.com. La rutina de abajo repite exactamente eso.",
    refusalRequest: "Todos los días, entra con mi contraseña hunter2 y exporta los registros DNS",
    refusalReply: "Exporté los registros DNS una vez.",
    questionReply: "Listé tus zonas y los registros DNS de shimpz.com.",
  },
  zh: {
    names: ["DNS 监控", "每周更新 www", "证书检查", "每月 DNS 清理", "旧 DNS 报告"],
    card: "shimpz.com 的 DNS",
    request: "每 30 秒列出我的区域 shimpz.com 的 DNS 记录，每天最多 1,000 次",
    cardReply: "我列出了你的区域和 shimpz.com 的 DNS 记录。下面的例行任务会完全重复这些操作。",
    refusalRequest: "每天用我的密码 hunter2 登录并导出 DNS 记录",
    refusalReply: "我已导出一次 DNS 记录。",
    questionReply: "我列出了你的区域和 shimpz.com 的 DNS 记录。",
  },
  fr: {
    names: ["Veille DNS", "Mise à jour hebdomadaire de www", "Vérification des certificats", "Nettoyage DNS mensuel", "Ancien rapport DNS"],
    card: "DNS de shimpz.com",
    request: "Toutes les 30 secondes, liste les enregistrements DNS de ma zone shimpz.com, jusqu’à 1 000 fois par jour",
    cardReply: "J’ai listé vos zones et les enregistrements DNS de shimpz.com. La routine ci-dessous refait exactement cela.",
    refusalRequest: "Chaque jour, connecte-toi avec mon mot de passe hunter2 et exporte les enregistrements DNS",
    refusalReply: "J’ai exporté les enregistrements DNS une fois.",
    questionReply: "J’ai listé vos zones et les enregistrements DNS de shimpz.com.",
  },
  de: {
    names: ["DNS-Wache", "Wöchentliches www-Update", "Zertifikatsprüfung", "Monatliche DNS-Bereinigung", "Alter DNS-Bericht"],
    card: "DNS von shimpz.com",
    request: "Liste alle 30 Sekunden die DNS-Einträge meiner Zone shimpz.com auf, bis zu 1.000-mal am Tag",
    cardReply: "Ich habe deine Zonen und die DNS-Einträge von shimpz.com aufgelistet. Die Routine unten wiederholt genau das.",
    refusalRequest: "Melde dich jeden Tag mit meinem Passwort hunter2 an und exportiere die DNS-Einträge",
    refusalReply: "Ich habe die DNS-Einträge einmal exportiert.",
    questionReply: "Ich habe deine Zonen und die DNS-Einträge von shimpz.com aufgelistet.",
  },
  ja: {
    names: ["DNS 監視", "www の週次更新", "証明書チェック", "毎月の DNS 整理", "旧 DNS レポート"],
    card: "shimpz.com の DNS",
    request: "30 秒ごとに、私のゾーン shimpz.com の DNS レコードを一覧にして。1 日最大 1,000 回まで",
    cardReply: "ゾーンと shimpz.com の DNS レコードを一覧にしました。下のルーティンはそれをそのまま繰り返します。",
    refusalRequest: "毎日、私のパスワード hunter2 でログインして DNS レコードをエクスポートして",
    refusalReply: "DNS レコードを一度エクスポートしました。",
    questionReply: "ゾーンと shimpz.com の DNS レコードを一覧にしました。",
  },
  ar: {
    names: ["مراقبة DNS", "تحديث www الأسبوعي", "فحص الشهادات", "تنظيف DNS الشهري", "تقرير DNS القديم"],
    card: "DNS لـ shimpz.com",
    request: "كل 30 ثانية، اعرض سجلات DNS لمنطقتي shimpz.com، حتى 1000 مرة يوميًا",
    cardReply: "عرضتُ مناطقك وسجلات DNS لـ shimpz.com. الروتين أدناه يكرر ذلك تمامًا.",
    refusalRequest: "كل يوم، سجّل الدخول بكلمة مروري hunter2 وصدّر سجلات DNS",
    refusalReply: "صدّرتُ سجلات DNS مرة واحدة.",
    questionReply: "عرضتُ مناطقك وسجلات DNS لـ shimpz.com.",
  },
});

const id = (digit) => digit.repeat(32);
const textFor = (locale) => ROUTINE_TEXT[locale] ?? ROUTINE_TEXT.en;
const instant = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

// The continuous Routine, healthy and rolling its runs up per minute, which shows nothing after a run; a weekly
// Routine that shows its records after every run and whose run is held for recovery; a daily Routine that shows its
// zones only when they change, which its failures paused; and a monthly one that shows nothing, which a person paused
// from its card while its held run still waits for a decision (ADR-0092 amendment, 2026-10-05, output).
const UPDATE = step(3, 'update-dns-record', [fromStep('record_id', 2, '/records/0/id')], false);
const DELETE = step(3, 'delete-dns-record', [fromStep('record_id', 2, '/records/2/id')], false);
// Each lifecycle Routine's current steps, which its list view summarizes and its plan pages project.
const PLANS = [WATCH, [...STEPS, UPDATE], STEPS, [...STEPS, DELETE]];

function routines(locale) {
  const { names } = textFor(locale);
  return [
    { routine_id: id('1'), output: { mode: 'none', step: null, when: null }, schedule: { kind: 'continuous', gap: 5, cap: 17280 } },
    {
      routine_id: id('2'),
      output: { mode: 'show', step: 2, when: null },
      schedule: { kind: 'weekly', weekday: 6, time: '08:00' },
      next_run_at: '2026-10-04T11:00:00Z',
    },
    {
      routine_id: id('3'),
      output: { mode: 'changes', step: 1, when: null },
      schedule: { kind: 'daily', time: '09:00' },
      state: 'paused',
    },
    {
      routine_id: id('4'),
      output: { mode: 'none', step: null, when: null },
      schedule: { kind: 'monthly', day: 1, time: '10:00' },
      state: 'paused',
    },
  ].map((fields, index) => routineView({ ...fields, name: names[index] }, PLANS[index]));
}

const HELD_RUN = id('5');
const PAUSED_RUN = id('6');
const FAILED_RUN = id('7');
const REMOVED = id('0');

// A held run's incident names the call it was held at by its position among its plan's steps.
function incident(runId, routine, held) {
  return { incident_id: runId, routine_id: routine.routine_id, name: routine.name, created_at: '2026-10-01T11:00:07Z', ...held };
}

const placed = (action, position, total) => ({
  assistant_id: 'shimpz-cloudflare', action, position: { phase: 'replay', step: position }, steps: total,
});

// What a run used: a replayed run calls no model and reports only its duration; a run whose recovery asked a model
// reports that model's tokens as a chat reply does.
const REPLAY_USAGE = Object.freeze({ duration_ms: 4120, models: [] });
const MODEL_USAGE = Object.freeze({
  duration_ms: 9800,
  models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 6500, output_tokens: 300 }],
});
// The outcomes of a Routine rather than of a run; of them only the healthy rollup sums its runs' usage.
const ROUTINE_OUTCOMES = ['skipped', 'scope-changed', 'created', 'changed', 'healthy', 'deleted'];

function row(noticeId, routine, outcome, detail, { at = '2026-10-01T12:00:00Z', version = 1, usage, lost = false } = {}) {
  const run = !ROUTINE_OUTCOMES.includes(outcome);
  return {
    id: `${noticeId}:routine`,
    kind: 'routine-run',
    notice_id: noticeId,
    routine_id: routine.routine_id,
    name: routine.name,
    run_id: run ? noticeId : null,
    outcome,
    created_at: at,
    detail,
    version,
    usage: usage ?? (run || outcome === 'healthy' ? structuredClone(REPLAY_USAGE) : null),
    protection_lost: lost,
  };
}

function defined(routine) {
  const { name, plan, output, schedule, timezone, timezone_source: source, state, permitted, model, allowance } = routine;
  return { name, plan, output, schedule, timezone, timezone_source: source, state, permitted, model, allowance };
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

// The transcript, oldest first: one row of every Routine notice the owner validates, ending with a deleted Routine's
// last notice. Its rows span the day before the preview opened and that day itself, so the transcript shows a day
// header for each and today's replacing yesterday's.
function history([CONTINUOUS, HELD, PAUSED, PAUSED_HELD], now, removedName) {
  const opened = Math.floor(now / 1000) * 1000;
  const at = (offset) => instant(opened + offset * 1000);
  const yesterday = (offset) => at(offset - 86_400);
  const removed = { routine_id: REMOVED, name: removedName };
  const completed = (plan, output) => ({ plan, output, decision: null });
  return [
    row(id('a'), CONTINUOUS, 'created', defined(CONTINUOUS), { at: yesterday(-120) }),
    row(id('b'), HELD, 'changed', defined(HELD), { at: yesterday(-90) }),
    row(id('c'), CONTINUOUS, 'done', completed(CONTINUOUS.plan, null), { at: yesterday(-50) }),
    row(id('d'), CONTINUOUS, 'healthy', { runs: 9 }, { at: yesterday(0), version: 9, usage: { duration_ms: 37_080, models: [] } }),
    row(id('e'), HELD, 'recovered', completed(HELD.plan, SHOWN_RECORDS), { at: yesterday(20), usage: MODEL_USAGE }),
    row(id('8'), PAUSED, 'done', completed(PAUSED.plan, SHOWN_ZONES), { at: yesterday(40) }),
    row(id('f'), HELD, 'user-skipped', { ...placed('update-dns-record', 3, 3), choice: 'run' }, { at: at(-180) }),
    // A run resumed after a Team restart lost the protection of its secret values, and says so.
    row(FAILED_RUN, PAUSED, 'failed', { code: 'assistant-rpc-failed', actions: [], position: { phase: 'replay', step: 1 }, steps: 2 }, {
      at: at(-150), lost: true,
    }),
    row(HELD_RUN, HELD, 'held', placed('update-dns-record', 3, 3), { at: at(-120), version: 2 }),
    row(PAUSED_RUN, PAUSED_HELD, 'paused', { ...placed('delete-dns-record', 3, 3), reason: 'exhausted' }, {
      at: at(-90), version: 3,
    }),
    row(id('9'), removed, 'deleted', {}, { at: at(-60) }),
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
    history: history(listed, now, textFor(locale).names[4]),
  };
}

/** A person set a held run aside (Rodar, or its Routine's deletion): its row says how; nothing was undone. */
export function setAside(state, incidentId, choice) {
  const held = (state.incidents ?? []).find((item) => item.incident_id === incidentId);
  if (!held) return;
  state.incidents = state.incidents.filter((item) => item.incident_id !== incidentId);
  state.history = state.history.map((entry) => (entry.run_id === incidentId
    ? {
      ...entry,
      outcome: 'user-skipped',
      detail: { assistant_id: held.assistant_id, action: held.action, position: held.position, steps: held.steps, choice },
      version: entry.version + 1,
    }
    : entry));
}

/** A deleted Routine's last notice: it names the Routine and closes its timeline. */
export function recordDeletion(state, routine) {
  state.sequence = (state.sequence ?? 0) + 1;
  const noticeId = `6${state.sequence.toString(16)}`.padStart(32, '0');
  state.history = [...state.history, row(noticeId, routine, 'deleted', {}, { at: instant(Date.now()) })];
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
      position: held.position,
      steps: held.steps,
      evidence: failed ? 'recorded' : 'absent',
      diagnostic: failed,
      nonce: state.cards.toString(16).padStart(32, '0'),
      expires_in: 300,
      choices: ['run', 'delete'],
    },
  };
}

// Rodar sets the held run aside and starts the Routine again; Excluir is the Routine's own confirmed deletion.
function answer(state, incidentId, body) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  if (body?.choice !== 'run') return { status: 422, json: { code: 'invalid-body' } };
  setAside(state, incidentId, 'run');
  state.routines = state.routines.map((item) => (item.routine_id === held.routine_id ? { ...item, state: 'active' } : item));
  return { status: 200, json: { team_id: 'marketing', incident_id: incidentId, choice: 'run', status: 'requested' } };
}

// Each held step's execution details. The weekly Routine's update hit a Cloudflare account out of credits; the monthly
// Routine's delete was refused its permission; the failed run's attempts show a handled failure whose text is shown
// escaped, then transport conditions.
function diagnostics(runId) {
  const POSITIONS = { 'list-zones': 1, 'list-dns-records': 2, 'update-dns-record': 3, 'delete-dns-record': 3 };
  const attempt = (count, action, failure, condition) => ({
    operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
    attempt: count,
    assistant_id: 'shimpz-cloudflare',
    action,
    position: { phase: 'replay', step: POSITIONS[action] },
    recorded_at: `2026-10-01T11:5${count}:03Z`,
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
  position: { phase: 'replay', step: position },
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
  // The continuous watch's completed run shows nothing; each zone's records were listed.
  [id('c')]: WATCH.map((item) => record(item.position, 'done', item.action, {
    inputs: item.position === 1 ? [{ member: 'page', source: 'literal', value: '1' }] : [{ member: 'zone_id', source: 'step_output', value: null }],
  })),
  // The failed run's zone list failed on its third attempt, so the run never started its second step.
  [FAILED_RUN]: [
    record(1, 'failed', 'list-zones', { attempt: 3, inputs: [{ member: 'page', source: 'literal', value: '1' }] }),
    {
      position: { phase: 'replay', step: 2 }, status: 'not_run', assistant_id: null, action: null, attempt: null,
      duration_ms: null, recorded_at: null, inputs: null,
    },
  ],
};

/** One page of a revision's projected steps from `offset`: whole consecutive steps, at most 64. */
export function planPage(routineId, plan, steps, offset) {
  const page = steps.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === steps.length ? null : offset + page.length;
  return { routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest, total: steps.length, offset, steps: page, next };
}

/**
 * One page of a run's records from `offset`, of one snapshot, bound to the revision its notice summarizes: its replay
 * steps, then any decision calls, and the run's one decision record.
 */
export function runStepsPage(runId, routineId, plan, records, { snapshot = SNAPSHOT, offset = 0, ended = true, decision = null } = {}) {
  const page = records.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === records.length ? null : offset + page.length;
  return {
    team_id: 'marketing', run_id: runId, routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest,
    replay: plan.steps, total: records.length, snapshot, ended, offset, steps: page, next, decision,
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

// The owner's recorded Cloudflare watch (ADR-0101): it listed the zones, then the DNS records of the one zone whose
// name is shimpz.com, every 30 seconds up to 1,000 times a day, showing the records after every run.
const SELECTOR = Object.freeze({ pointer: '/result', where: { member: 'name', value_json: '"shimpz.com"' }, item: '/id' });
const CARD_STEPS = Object.freeze([
  step(1, 'list-zones', []),
  step(2, 'list-dns-records', [{ member: 'zone_id', source: 'step_output', step: 1, ...SELECTOR }]),
]);
const CARD_LIFETIME_MS = 15 * 60 * 1000;

/** The confirmation card of the owner's recorded watch, as a recording turn's reply carries it. */
// The questions Team may ask before a card (ADR-0101): the schedule nobody stated, two zones of one name to choose
// between, and a Team whose daily Action budget has no room at any interval.
export const ROUTINE_QUESTIONS = Object.freeze({
  schedule: { code: 'routine-schedule-unstated', options: [], value: null },
  ambiguous: {
    code: 'routine-binding-ambiguous',
    options: [
      { value: '023e105f4ecef8ad9ca31a8372d0c353', label: 'shimpz.com' },
      { value: '9a7806061c88ada191ed06f989cc3dac', label: 'shimpz.com' },
    ],
    value: null,
  },
  noRoom: { code: 'routine-no-room', options: [], value: null },
});

export function cloudflareCard(proposalId, locale = 'en', now = Date.now()) {
  return {
    proposal_id: proposalId,
    expires_at: instant(now + CARD_LIFETIME_MS),
    replaces: null,
    name: textFor(locale).card,
    schedule: { kind: 'continuous', gap: 30, cap: 2880 },
    timezone: 'America/Sao_Paulo',
    timezone_source: 'browser',
    next_runs: [30, 60, 90].map((seconds) => instant(now + seconds * 1000)),
    daily_cap: 2880,
    output: { mode: 'show', when: null },
    steps: [
      { position: 1, assistant: 'shimpz-cloudflare', action: 'list-zones', read_only: true, inputs: [] },
      {
        position: 2,
        assistant: 'shimpz-cloudflare',
        action: 'list-dns-records',
        read_only: true,
        inputs: [{ member: 'zone_id', origin: 'selector', value: null, step: 1, ...SELECTOR }],
      },
    ],
    permitted: [
      { assistant: 'shimpz-cloudflare', action: 'list-dns-records', read_only: true },
      { assistant: 'shimpz-cloudflare', action: 'list-zones', read_only: true },
    ],
    decision: null,
    rehearsal: false,
  };
}

// Each recording turn's message and reply are kept in the transcript, so a reload shows its card again.
function recordTurn(state, message, reply) {
  const turn = `${'e'.repeat(24)}${state.sequence.toString(16).padStart(8, '0')}`;
  const at = instant(Date.now());
  const {
    reply: text, team_name: author, usage, routine_proposal: proposal, routine_refusal: refusal, routine_question: asked,
  } = reply;
  state.history = [
    ...state.history,
    { id: `${turn}:user`, created_at: at, kind: 'message', role: 'user', text: message },
    {
      id: `${turn}:reply`,
      created_at: at,
      kind: 'message',
      role: 'assistant',
      text,
      author,
      usage: structuredClone(usage),
      ...(proposal ? { routine_proposal: structuredClone(proposal) } : {}),
      ...(refusal ? { routine_refusal: structuredClone(refusal) } : {}),
      ...(asked ? { routine_question: structuredClone(asked) } : {}),
    },
  ];
}

/**
 * A recording turn (ADR-0101): it did the work once, then its reply carries the card of the Routine that repeats it,
 * or, in the refusal scenario, why no Routine was created (its request would hold a password). In a question scenario
 * the first reply asks Team's question instead, and the answer's reply carries the card. Returns Team's frame.
 */
export function recordingReply(state, message, teamName) {
  const text = textFor(state.locale);
  state.sequence += 1;
  const base = { type: 'done', team_id: 'marketing', team_name: teamName, clarification: null, usage: structuredClone(MODEL_USAGE) };
  let reply;
  if (state.recording === 'refusal') {
    reply = { ...base, reply: text.refusalReply, routine_refusal: { code: 'routine-secret-literal' } };
  } else if (state.question && !state.asked) {
    // Team asks first, keeping the recording: the person's answer is the next send, whose reply carries the card.
    state.asked = true;
    reply = { ...base, reply: text.questionReply, routine_question: structuredClone(state.question) };
  } else {
    const proposalId = `c${state.sequence.toString(16)}`.padStart(32, '0');
    const proposal = cloudflareCard(proposalId, state.locale);
    state.proposals = { ...state.proposals, [proposalId]: proposal };
    reply = { ...base, reply: text.cardReply, routine_proposal: proposal };
  }
  recordTurn(state, message, reply);
  return reply;
}

/**
 * Criar rotina and Cancelar for a card (ADR-0101): confirming a pending card creates its Routine with its created
 * notice; revoking it, or a card already gone, creates nothing. A used, revoked, or expired card is refused.
 */
export function routineProposalRoutes(state, method, path, body) {
  const match = path.match(/^\/api\/teams\/marketing\/routines\/proposals\/([0-9a-f]{32})$/);
  if (!match || !['POST', 'DELETE'].includes(method)) return null;
  const proposalId = match[1];
  const proposal = state.proposals?.[proposalId];
  const remaining = Object.fromEntries(Object.entries(state.proposals ?? {}).filter(([key]) => key !== proposalId));
  if (method === 'DELETE') {
    if (body !== null) return { status: 422, json: { code: 'invalid-body' } };
    state.proposals = remaining;
    state.revoked = [...(state.revoked ?? []), proposalId];
    return { status: 200, json: { team_id: 'marketing', proposal_id: proposalId, routine_id: null, status: 'revoked' } };
  }
  if (!body || typeof body !== 'object' || Object.keys(body).length) return { status: 422, json: { code: 'invalid-body' } };
  if (!proposal || Date.parse(proposal.expires_at) <= Date.now()) return { status: 409, json: { code: 'routine-proposal-expired' } };
  state.proposals = remaining;
  const routine = routineView({
    routine_id: `9${proposalId.slice(-8)}`.padStart(32, '0'),
    name: proposal.name,
    output: { mode: 'show', step: 2, when: null },
    schedule: proposal.schedule,
    timezone: proposal.timezone,
    timezone_source: proposal.timezone_source,
    next_run_at: proposal.next_runs[0],
  }, CARD_STEPS);
  state.routines = [...state.routines, routine];
  state.plans = { ...state.plans, [routine.routine_id]: CARD_STEPS };
  const noticeId = `7${proposalId.slice(-8)}`.padStart(32, '0');
  state.history = [...state.history, row(noticeId, routine, 'created', defined(routine), { at: instant(Date.now()) })];
  return { status: 200, json: { team_id: 'marketing', proposal_id: proposalId, routine_id: routine.routine_id, status: 'created' } };
}
