import { routineQuestionMessages } from '../src/lib/routines/questionMessages.js';

// Routine scenarios for the owner's preview and the browser tests (ADR-0087, ADR-0092, ADR-0101): every Routine notice
// titled by the name Team froze into it, each run's active duration, a held run's recovery card with the error its
// step returned (a Cloudflare account out of credits), a paused Routine, a minute rollup, a run's execution details and
// step records, a 120-step plan read page by page, the confirmation card of the Supervisor's recorded Cloudflare
// watch, and a recording turn's refusal. Pure data and state transitions; nothing
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

/** A Routine view as Team lists it. */
export function routineView(fields, steps) {
  return {
    timezone: 'America/Sao_Paulo',
    timezone_source: 'browser',
    next_run_at: '2026-10-02T12:00:00Z',
    needs_reconfirm: false,
    deleting: false,
    state: 'active',
    ...fields,
    plan: fields.plan ?? planSummary(steps),
  };
}

// Every fixture text in the preview's interface language, so a Routine's name, the person's request, and Team's reply
// read as the Admin does.
export const ROUTINE_TEXT = Object.freeze({
  en: {
    names: ["DNS watch", "Weekly www update", "Certificate check", "Monthly DNS cleanup"],
    card: "shimpz.com DNS",
    cardDescription: "This checks the zones in your Cloudflare account and reads the DNS records of shimpz.com. It only reads; nothing is changed.",
    request: "Every 30 seconds, list the DNS records of my zone shimpz.com, up to 1,000 times a day",
    cardReply: "I listed your zones and the DNS records of shimpz.com. The Routine below repeats exactly that.",
    refusalRequest: "Every day, log in with my password hunter2 and export the DNS records",
    refusalReply: "I exported the DNS records once.",
    questionReply: "I listed your zones and the DNS records of shimpz.com.",
  },
  pt: {
    names: ["Vigia de DNS", "Atualização semanal do www", "Verificação de certificados", "Limpeza mensal de DNS"],
    card: "DNS de shimpz.com",
    cardDescription: "Confere as zonas da sua conta Cloudflare e lê os registros DNS de shimpz.com. Só lê; nada é alterado.",
    request: "A cada 30 segundos, liste os registros DNS da minha zona shimpz.com, até 1.000 vezes por dia",
    cardReply: "Listei suas zonas e os registros DNS de shimpz.com. A rotina abaixo repete exatamente isso.",
    refusalRequest: "Todo dia, entre com a minha senha hunter2 e exporte os registros DNS",
    refusalReply: "Exportei os registros DNS uma vez.",
    questionReply: "Listei suas zonas e os registros DNS de shimpz.com.",
  },
  es: {
    names: ["Vigilancia de DNS", "Actualización semanal de www", "Revisión de certificados", "Limpieza mensual de DNS"],
    card: "DNS de shimpz.com",
    cardDescription: "Revisa las zonas de tu cuenta de Cloudflare y lee los registros DNS de shimpz.com. Solo lee; no cambia nada.",
    request: "Cada 30 segundos, lista los registros DNS de mi zona shimpz.com, hasta 1.000 veces al día",
    cardReply: "Listé tus zonas y los registros DNS de shimpz.com. La rutina de abajo repite exactamente eso.",
    refusalRequest: "Todos los días, entra con mi contraseña hunter2 y exporta los registros DNS",
    refusalReply: "Exporté los registros DNS una vez.",
    questionReply: "Listé tus zonas y los registros DNS de shimpz.com.",
  },
  zh: {
    names: ["DNS 监控", "每周更新 www", "证书检查", "每月 DNS 清理"],
    card: "shimpz.com 的 DNS",
    cardDescription: "检查你 Cloudflare 账户中的区域，并读取 shimpz.com 的 DNS 记录。只读取，不做任何更改。",
    request: "每 30 秒列出我的区域 shimpz.com 的 DNS 记录，每天最多 1,000 次",
    cardReply: "我列出了你的区域和 shimpz.com 的 DNS 记录。下面的例行任务会完全重复这些操作。",
    refusalRequest: "每天用我的密码 hunter2 登录并导出 DNS 记录",
    refusalReply: "我已导出一次 DNS 记录。",
    questionReply: "我列出了你的区域和 shimpz.com 的 DNS 记录。",
  },
  fr: {
    names: ["Veille DNS", "Mise à jour hebdomadaire de www", "Vérification des certificats", "Nettoyage DNS mensuel"],
    card: "DNS de shimpz.com",
    cardDescription: "Vérifie les zones de votre compte Cloudflare et lit les enregistrements DNS de shimpz.com. Lecture seule ; rien n’est modifié.",
    request: "Toutes les 30 secondes, liste les enregistrements DNS de ma zone shimpz.com, jusqu’à 1 000 fois par jour",
    cardReply: "J’ai listé vos zones et les enregistrements DNS de shimpz.com. La routine ci-dessous refait exactement cela.",
    refusalRequest: "Chaque jour, connecte-toi avec mon mot de passe hunter2 et exporte les enregistrements DNS",
    refusalReply: "J’ai exporté les enregistrements DNS une fois.",
    questionReply: "J’ai listé vos zones et les enregistrements DNS de shimpz.com.",
  },
  de: {
    names: ["DNS-Wache", "Wöchentliches www-Update", "Zertifikatsprüfung", "Monatliche DNS-Bereinigung"],
    card: "DNS von shimpz.com",
    cardDescription: "Prüft die Zonen deines Cloudflare-Kontos und liest die DNS-Einträge von shimpz.com. Nur lesen; nichts wird geändert.",
    request: "Liste alle 30 Sekunden die DNS-Einträge meiner Zone shimpz.com auf, bis zu 1.000-mal am Tag",
    cardReply: "Ich habe deine Zonen und die DNS-Einträge von shimpz.com aufgelistet. Die Routine unten wiederholt genau das.",
    refusalRequest: "Melde dich jeden Tag mit meinem Passwort hunter2 an und exportiere die DNS-Einträge",
    refusalReply: "Ich habe die DNS-Einträge einmal exportiert.",
    questionReply: "Ich habe deine Zonen und die DNS-Einträge von shimpz.com aufgelistet.",
  },
  ja: {
    names: ["DNS 監視", "www の週次更新", "証明書チェック", "毎月の DNS 整理"],
    card: "shimpz.com の DNS",
    cardDescription: "Cloudflare アカウントのゾーンを確認し、shimpz.com の DNS レコードを読み取ります。読み取りのみで、何も変更しません。",
    request: "30 秒ごとに、私のゾーン shimpz.com の DNS レコードを一覧にして。1 日最大 1,000 回まで",
    cardReply: "ゾーンと shimpz.com の DNS レコードを一覧にしました。下のルーティンはそれをそのまま繰り返します。",
    refusalRequest: "毎日、私のパスワード hunter2 でログインして DNS レコードをエクスポートして",
    refusalReply: "DNS レコードを一度エクスポートしました。",
    questionReply: "ゾーンと shimpz.com の DNS レコードを一覧にしました。",
  },
  ar: {
    names: ["مراقبة DNS", "تحديث www الأسبوعي", "فحص الشهادات", "تنظيف DNS الشهري"],
    card: "DNS لـ shimpz.com",
    cardDescription: "يتحقق من مناطق حسابك في Cloudflare ويقرأ سجلات DNS لـ shimpz.com. للقراءة فقط؛ لا يتغير شيء.",
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
// Routine that shows the record it updated after every run and whose run is held for recovery; a daily Routine that
// shows its records only when they change, which its failures paused; and a monthly one that shows nothing, which a person paused
// from its card while its held run still waits for a decision (ADR-0092 amendment, 2026-10-05, output).
const UPDATE = step(3, 'update-dns-record', [fromStep('record_id', 2, '/records/0/id')], false);
const DELETE = step(3, 'delete-dns-record', [fromStep('record_id', 2, '/records/2/id')], false);
// Each lifecycle Routine's current steps, which its list view summarizes and its plan pages project.
const PLANS = [WATCH, [...STEPS, UPDATE], STEPS, [...STEPS, DELETE]];

function routines(locale) {
  const { names } = textFor(locale);
  return [
    { routine_id: id('1'), output: { mode: 'none', step: null }, schedule: { kind: 'continuous', gap: 5 } },
    {
      routine_id: id('2'),
      output: { mode: 'show', step: 3 },
      schedule: { kind: 'weekly', weekday: 6, time: '08:00' },
      next_run_at: '2026-10-04T11:00:00Z',
    },
    {
      routine_id: id('3'),
      output: { mode: 'changes', step: 2 },
      schedule: { kind: 'daily', time: '09:00' },
      state: 'paused',
    },
    {
      routine_id: id('4'),
      output: { mode: 'none', step: null },
      schedule: { kind: 'monthly', day: 1, time: '10:00' },
      state: 'paused',
    },
  ].map((fields, index) => routineView({ ...fields, name: names[index] }, PLANS[index]));
}

const HELD_RUN = id('5');
const PAUSED_RUN = id('6');
const FAILED_RUN = id('7');
const STREAK_PAUSE = `${'d'.repeat(31)}0`;

// A held run's incident names the call it was held at by its position among its plan's steps.
function incident(runId, routine, held) {
  return { run_id: runId, routine_id: routine.routine_id, ...held };
}

const placed = (action, position, total) => ({
  assistant_id: 'shimpz-cloudflare', action, position, steps: total,
});

// What a run used: its active duration alone, since a run asks no model. A recording turn's reply reports its model's
// tokens as any chat reply does.
const RUN_USAGE = Object.freeze({ duration_ms: 4120 });
const MODEL_USAGE = Object.freeze({
  duration_ms: 9800,
  models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 6500, output_tokens: 300 }],
});
// The outcomes of a Routine rather than of a run that Admin stores; of them only the healthy rollup sums its runs' usage.
const ROUTINE_OUTCOMES = ['skipped', 'created', 'healthy', 'streak-paused'];

// What a Routine's creation spent (ADR-0101): its recording's model usage and the Team steps of its turns.
export const CREATION_USAGE = Object.freeze({
  duration_ms: 8_400,
  models: [{ provider: 'openai', model: 'gpt-6.1-sol', input_tokens: 12_480, output_tokens: 320 }],
});
export const CREATION = Object.freeze({
  steps: [
    { seq: 1, phase: 'team-context', state: 'finished', elapsed_ms: 40 },
    { seq: 2, phase: 'model', state: 'finished', elapsed_ms: 3_100 },
    {
      seq: 3, phase: 'action', state: 'finished', elapsed_ms: 420,
      assistant_id: 'shimpz-cloudflare', index: 1, action: 'list-zones', total: 1,
    },
    { seq: 4, phase: 'model', state: 'finished', elapsed_ms: 2_800 },
  ],
});

/**
 * One Routine notice as Admin stores it: a run's notice names its run and carries its active duration; a Routine's
 * notice names no run and carries no usage, except the healthy rollup's summed duration and a creation's recording's
 * model usage.
 */

export function noticeRow(noticeId, routine, outcome, detail, { at = '2026-10-01T12:00:00Z', version = 1, usage, lost = false } = {}) {
  const run = !ROUTINE_OUTCOMES.includes(outcome);
  const created = outcome === 'created' ? structuredClone(CREATION_USAGE) : null;
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
    usage: usage ?? (run || outcome === 'healthy' ? structuredClone(RUN_USAGE) : created),
    protection_lost: lost,
  };
}

const text = (value) => ({ kind: 'text', value, cut: false });
const fields = (...pairs) => ({ kind: 'fields', fields: pairs, omitted: 0 });
// What a run shows of its result: Team's bounded, redacted projection of the Action's validated result, as plain data.
const number = (value) => ({ kind: 'number', value });
// Cloudflare's updated DNS record as Team projects it: its own values, a comment holding markup kept as plain text.
const SHOWN_UPDATE = Object.freeze({
  step: 3,
  state: 'shown',
  value: fields(['result', fields(
    ['comment', text('<img src=x onerror=alert(1)>')],
    ['content', text('192.0.2.20')],
    ['id', text('372e67954025e0ba6aaa6d586b9e0b59')],
    ['name', text('www.example.com')],
    ['proxied', { kind: 'bool', value: true }],
    ['ttl', number('1')],
    ['type', text('A')],
  )]),
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

// The stored history, oldest first: one row of every Routine notice Admin stores, each with only the detail its view
// renders (a Routine's change, deletion, and scope change are never stored). The chat shows only the creations among
// them and each Routine's panel its own runs. Its rows span the day before the
// preview opened and that day itself, so the transcript shows a day header for each and today's replacing yesterday's.
function history([CONTINUOUS, HELD, PAUSED, PAUSED_HELD], now) {
  const opened = Math.floor(now / 1000) * 1000;
  const at = (offset) => instant(opened + offset * 1000);
  const yesterday = (offset) => at(offset - 86_400);
  const completed = (plan, output) => ({ plan, output });
  return [
    noticeRow(id('a'), CONTINUOUS, 'created', structuredClone(CREATION), { at: yesterday(-120) }),
    noticeRow(id('c'), CONTINUOUS, 'done', completed(CONTINUOUS.plan, null), { at: yesterday(-50) }),
    noticeRow(id('d'), CONTINUOUS, 'healthy', { runs: 9 }, { at: yesterday(0), version: 9, usage: { duration_ms: 37_080 } }),
    noticeRow(id('e'), HELD, 'recovered', completed(HELD.plan, SHOWN_UPDATE), { at: yesterday(20), usage: { duration_ms: 9800 } }),
    noticeRow(id('8'), PAUSED, 'done', completed(PAUSED.plan, SHOWN_RECORDS), { at: yesterday(40) }),
    noticeRow(id('f'), HELD, 'user-skipped', {}, { at: at(-180) }),
    // A run resumed after a Team restart lost the protection of its secret values, and says so.
    noticeRow(FAILED_RUN, PAUSED, 'failed', { code: 'assistant-rpc-failed' }, {
      at: at(-150), lost: true,
    }),
    // Its consecutive failed runs paused the Routine.
    noticeRow(STREAK_PAUSE, PAUSED, 'streak-paused', { failures: 3 }, { at: at(-140) }),
    noticeRow(HELD_RUN, HELD, 'held', {}, { at: at(-120), version: 2 }),
    noticeRow(PAUSED_RUN, PAUSED_HELD, 'paused', { reason: 'exhausted' }, {
      at: at(-90), version: 3,
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

/** A person set a held run aside (Rodar, or its Routine's deletion): its row says so; nothing was undone. */
export function setAside(state, runId) {
  if (!(state.incidents ?? []).some((item) => item.run_id === runId)) return;
  state.incidents = state.incidents.filter((item) => item.run_id !== runId);
  state.history = state.history.map((entry) => (entry.run_id === runId
    ? { ...entry, outcome: 'user-skipped', detail: {}, version: entry.version + 1 }
    : entry));
}

// The entity tag of the held run's card as last opened: an answer naming another one is stale.
function cardTag(state, runId) {
  return `${runId.slice(0, 32)}${(state.cards ?? 0).toString(16).padStart(32, '0')}`;
}

function card(state, runId) {
  const held = state.incidents.find((item) => item.run_id === runId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  state.cards = (state.cards ?? 0) + 1;
  const failed = diagnostics(runId).json.diagnostics.at(-1) ?? null;
  return {
    status: 200,
    json: {
      team_id: 'marketing',
      run_id: runId,
      assistant_id: held.assistant_id,
      action: held.action,
      position: held.position,
      steps: held.steps,
      evidence: failed ? 'recorded' : 'absent',
      diagnostic: failed,
      tag: cardTag(state, runId),
    },
  };
}

// Rodar sets the held run aside and starts the Routine again; Excluir is the Routine's own confirmed deletion.
function answer(state, runId, body) {
  const held = state.incidents.find((item) => item.run_id === runId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  if (Object.keys(body ?? {}).join() !== 'tag') return { status: 422, json: { code: 'invalid-body' } };
  if (body.tag !== cardTag(state, runId)) return { status: 409, json: { code: 'routine-card-stale' } };
  setAside(state, runId);
  state.routines = state.routines.map((item) => (item.routine_id === held.routine_id ? { ...item, state: 'active' } : item));
  return { status: 200, json: { team_id: 'marketing', run_id: runId } };
}

// One recorded attempt of a Cloudflare call as Team keeps it (ADR-0092 section 8), with `changes` applied.
export function diagnostic(changes) {
  return {
    operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
    attempt: 1,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
    position: 2,
    recorded_at: '2026-10-01T12:00:03Z',
    failure: null,
    condition: null,
    ...changes,
  };
}

// Team's opening of a Marketing run frozen at a Cloudflare call's human request (ADR-0091): `request` is the
// localized request it carries.
export function routineChallenge(runId, request, { challengeId = 'b'.repeat(32), expiresIn = 300 } = {}) {
  return {
    team_id: 'marketing',
    run_id: runId,
    status: 'human-required',
    challenge: {
      type: 'human-required',
      challenge_id: challengeId,
      expires_in: expiresIn,
      assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
      action: { id: 'replace-dns-record', summary: 'Replace one reviewed DNS record.' },
      ...request,
    },
  };
}

// A Cloudflare HTTP error as Team sanitizes it, with `changes` applied.
export function httpFailure(changes) {
  return {
    error_type: 'httpx.HTTPStatusError',
    provider: 'api.cloudflare.com',
    response_excerpt: null,
    redacted: true,
    truncated: false,
    ...changes,
  };
}

// Each held step's execution details. The weekly Routine's update hit a Cloudflare account out of credits; the monthly
// Routine's delete was refused its permission; the failed run's attempts show a handled failure whose text is shown
// escaped, then transport conditions.
function diagnostics(runId) {
  const POSITIONS = { 'list-zones': 1, 'list-dns-records': 2, 'update-dns-record': 3, 'delete-dns-record': 3 };
  const attempt = (count, action, failure, condition) => diagnostic({
    attempt: count, action, position: POSITIONS[action], recorded_at: `2026-10-01T11:5${count}:03Z`, failure, condition,
  });
  const failure = (status, message, excerpt) => httpFailure({ message, http_status: status, response_excerpt: excerpt });
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

/**
 * The recovery card, its answers, and a run's execution details, for every scenario's Marketing Team, as the session
 * socket's `routines.card`, `routines.card_answer`, and `routines.diagnostics` (ADR-0114).
 */
export const ROUTINE_RECOVERY_METHODS = Object.freeze({
  'routines.card': (state, params) => {
    state.incidents ??= [];
    return card(state, params.run_id);
  },
  'routines.card_answer': (state, params) => {
    state.incidents ??= [];
    return answer(state, params.run_id, params.body);
  },
  'routines.diagnostics': (_state, params) => diagnostics(params.run_id),
});

// What lifecycle runs did, step by step: their records, kept as one snapshot each.
const SNAPSHOT = 'c'.repeat(32);
const record = (position, status, action, { attempt = 1, duration = 640 + position * 37, inputs = [] } = {}) => ({
  position,
  status,
  assistant_id: 'shimpz-cloudflare',
  action,
  attempt,
  duration_ms: status === 'recovered' ? null : duration,
  inputs,
});
const RUN_RECORDS = {
  // The recovered run's DNS record list was rate limited once, and its recovery verified it.
  [id('e')]: [
    record(1, 'done', 'list-zones', { inputs: [{ member: 'page', value: '1' }] }),
    record(2, 'recovered', 'list-dns-records', { attempt: 2, inputs: [{ member: 'zone_id', value: '"9a7806061c88ada191ed06f989cc3dac"' }] }),
    record(3, 'done', 'update-dns-record', { inputs: [{ member: 'record_id', value: null }] }),
  ],
  [id('8')]: [
    record(1, 'done', 'list-zones', { inputs: [{ member: 'page', value: '1' }] }),
    record(2, 'done', 'list-dns-records', { inputs: [{ member: 'zone_id', value: '"9a7806061c88ada191ed06f989cc3dac"' }] }),
  ],
  // The continuous watch's completed run shows nothing; each zone's records were listed.
  [id('c')]: WATCH.map((item) => record(item.position, 'done', item.action, {
    inputs: item.position === 1 ? [{ member: 'page', value: '1' }] : [{ member: 'zone_id', value: null }],
  })),
  // The failed run's zone list failed on its third attempt, so the run never started its second step.
  [FAILED_RUN]: [
    record(1, 'failed', 'list-zones', { attempt: 3, inputs: [{ member: 'page', value: '1' }] }),
    {
      position: 2, status: 'not_run', assistant_id: null, action: null, attempt: null,
      duration_ms: null, inputs: null,
    },
  ],
};

/** One page of a revision's projected steps from `offset`: whole consecutive steps, at most 64. */
export function planPage(routineId, plan, steps, offset) {
  const page = steps.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === steps.length ? null : offset + page.length;
  return { routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest, total: steps.length, offset, steps: page, next };
}

/** One page of a run's records from `offset`, of one snapshot, bound to the revision its notice summarizes. */
export function runStepsPage(runId, routineId, plan, records, { snapshot = SNAPSHOT, offset = 0 } = {}) {
  const page = records.slice(offset, offset + PAGE_STEPS);
  const next = offset + page.length === records.length ? null : offset + page.length;
  return {
    team_id: 'marketing', run_id: runId, routine_id: routineId, revision: plan.revision, plan_digest: plan.plan_digest,
    total: records.length, snapshot, offset, steps: page, next,
  };
}

// A page of a Routine's current revision, refused when the reader names another.
function planSteps(state, { routine_id: routineId, revision, offset }) {
  const routine = state.routines.find((item) => item.routine_id === routineId);
  const steps = state.plans?.[routineId];
  if (!routine || !steps) return { status: 404, json: { code: 'routine-not-found' } };
  if (Number(revision) !== routine.plan.revision) return { status: 409, json: { code: 'routine-revision-changed' } };
  if (Number(offset) >= steps.length) return { status: 404, json: { code: 'routine-steps-not-found' } };
  return { status: 200, json: planPage(routine.routine_id, routine.plan, steps, Number(offset)) };
}

/**
 * A Routine's plan pages and a run's step records (ADR-0092 amendment, 2026-10-05, scale), as the session socket's
 * `routines.plan_steps` and `routines.run_steps`: a page of the Routine's current revision, refused when the reader
 * names another, and a page of a run's one snapshot of records.
 */
export const ROUTINE_STEP_METHODS = Object.freeze({
  'routines.plan_steps': planSteps,
  'routines.run_steps': (state, { run_id: runId, snapshot, offset }) => {
    const notice = state.history.find((entry) => entry.run_id === runId);
    const records = RUN_RECORDS[runId];
    // A completed run's notice names the revision it carried out; any other run carried out its Routine's current one.
    const plan = notice?.detail.plan ?? state.routines.find((item) => item.routine_id === notice?.routine_id)?.plan;
    if (!plan || !records) return { status: 404, json: { code: 'routine-run-steps-not-found' } };
    if (snapshot !== 'latest' && snapshot !== SNAPSHOT) return { status: 409, json: { code: 'routine-run-changed' } };
    if (Number(offset) >= records.length) return { status: 404, json: { code: 'routine-run-steps-not-found' } };
    return { status: 200, json: runStepsPage(runId, notice.routine_id, plan, records, { offset: Number(offset) }) };
  },
});

// The Supervisor's recorded Cloudflare watch (ADR-0101): it listed the zones, then the DNS records of the one zone whose
// name is shimpz.com, every 30 seconds up to 1,000 times a day, showing the records after every run.
const SELECTOR = Object.freeze({ pointer: '/result', where: { member: 'name', value_json: '"shimpz.com"' }, item: '/id' });
const CARD_STEPS = Object.freeze([
  step(1, 'list-zones', []),
  step(2, 'list-dns-records', [{ member: 'zone_id', source: 'step_output', step: 1, ...SELECTOR }]),
]);
const CARD_LIFETIME_MS = 15 * 60 * 1000;

/** The confirmation card of the Supervisor's recorded watch, as a recording turn's reply carries it. */
// The questions Team may ask before a card (ADR-0101): the schedule nobody stated, what each run does with its result,
// two zones of one name to choose between, and two targets of the same digits, one a string and one an integer. Each
// target is its exact JSON text.
export const ROUTINE_QUESTIONS = Object.freeze({
  schedule: { code: 'routine-schedule-unstated', options: [], value: null },
  output: { code: 'routine-output-unstated', options: [], value: null },
  ambiguous: {
    code: 'routine-binding-ambiguous',
    options: [
      { value: '"023e105f4ecef8ad9ca31a8372d0c353"', label: 'shimpz.com' },
      { value: '"9a7806061c88ada191ed06f989cc3dac"', label: 'shimpz.com' },
    ],
    value: null,
  },
  exact: {
    code: 'routine-binding-ambiguous',
    options: [
      { value: '"12345678901234567890"', label: null },
      { value: '12345678901234567890', label: null },
    ],
    value: null,
  },
});

// When the Cloudflare watch runs, in which zone, and what each run shows, as Team read them from the person's request.
export const CARD_SETTINGS = Object.freeze({
  schedule: { kind: 'continuous', gap: 30 },
  timezone: 'America/Sao_Paulo',
  timezone_source: 'browser',
  output: 'show',
});

function cloudflareCard(proposalId, locale = 'en', now = Date.now()) {
  return {
    proposal_id: proposalId,
    expires_at: instant(now + CARD_LIFETIME_MS),
    replaces: null,
    name: textFor(locale).card,
    description: textFor(locale).cardDescription,
    ...structuredClone(CARD_SETTINGS),
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

// Each Team protocol output label in every interface language, read back as Team reads it: using the result in other
// Actions records those Actions as part of the work and shows the result.
const OUTPUT_ORDER = ['show', 'changes', 'none', 'show'];
const OUTPUT_MODES = Object.freeze(Object.fromEntries(Object.values(routineQuestionMessages)
  .flatMap((questions) => questions.output.answers.map((label, index) => [label, OUTPUT_ORDER[index]]))));

// Whether a send answers the pending question: a target question needs one option's exact JSON text, which is kept;
// an output question needs one of Team's output labels, whose choice the card then carries.
function answers(state, message) {
  if (state.question.code === 'routine-output-unstated') {
    const label = message.split('\n').at(-1).replace(/^[^:]*: /u, '');
    state.mode = OUTPUT_MODES[label];
    return state.mode !== undefined;
  }
  if (state.question.code !== 'routine-binding-ambiguous') return true;
  const last = message.split('\n').at(-1);
  const chosen = state.question.options.find((option) => last.endsWith(`: ${option.value}`));
  if (chosen) state.chosen = chosen.value;
  return chosen !== undefined;
}

/**
 * A recording turn (ADR-0101): it did the work once, then its reply carries the card of the Routine that repeats it,
 * or, in the refusal scenario, why no Routine was created (its request would hold a password). In a question scenario
 * the first reply asks Team's question instead, and the answer's reply carries the card alone. Returns Team's frame.
 */
export function recordingReply(state, message, teamName) {
  const text = textFor(state.locale);
  state.sequence += 1;
  const base = { type: 'done', team_id: 'marketing', team_name: teamName, clarification: null, usage: structuredClone(MODEL_USAGE) };
  let reply;
  if (state.recording === 'refusal') {
    reply = { ...base, reply: text.refusalReply, routine_refusal: { code: 'routine-secret-literal' } };
  } else if (state.question && (!state.asked || !answers(state, message))) {
    // Team asks first, keeping the recording: the person's answer is the next send, whose reply carries the card. A
    // target is chosen only by its exact JSON text as the answer's last line, as Team matches it; anything else asks
    // again.
    state.asked = true;
    reply = { ...base, reply: text.questionReply, routine_question: structuredClone(state.question) };
  } else {
    const proposalId = `c${state.sequence.toString(16)}`.padStart(32, '0');
    const proposal = cloudflareCard(proposalId, state.locale, Date.now());
    state.proposals = { ...state.proposals, [proposalId]: proposal };
    // A card that follows the person's answer comes with no text: the card says everything.
    reply = { ...base, reply: state.asked ? '' : text.cardReply, routine_proposal: proposal };
  }
  recordTurn(state, message, reply);
  return reply;
}

// A refinement of a listed Routine (ADR-0122): its one step kept and the zones' second page added after it. The card names
// the Routine the message's Refine entry named, else the Team's first Routine.
export const REFINEMENT_DESCRIPTION = 'Lists the first and the second page of your Cloudflare zones.';

function refinementCard(proposalId, routine, now = Date.now()) {
  return {
    proposal_id: proposalId,
    expires_at: instant(now + CARD_LIFETIME_MS),
    routine_id: routine.routine_id,
    base_revision: routine.plan.revision,
    name: routine.name,
    description: REFINEMENT_DESCRIPTION,
    schedule: structuredClone(routine.schedule),
    timezone: routine.timezone,
    timezone_source: routine.timezone_source,
    output: routine.output.mode,
    last_changed: true,
    steps: [
      { position: 1, assistant: 'shimpz-cloudflare', action: 'list-zones', read_only: true, inputs: [], change: 'kept', base: 1 },
      {
        position: 2,
        assistant: 'shimpz-cloudflare',
        action: 'list-zones',
        read_only: true,
        // A step a refinement adds takes only literals and run dates in this slice (ADR-0122).
        inputs: [{ member: 'page', origin: 'request', value: '2', step: null, pointer: null, where: null, item: null }],
        change: 'added',
        base: null,
      },
    ],
    removed: [],
  };
}

/** A refining turn's reply: the card of the refinement, which Apply confirms and Cancel revokes. */
export function refiningReply(state, message, teamName, refine) {
  state.sequence += 1;
  state.refined = [...(state.refined ?? []), refine];
  const routine = state.routines.find((item) => item.routine_id === refine) ?? state.routines[0];
  const proposalId = `d${state.sequence.toString(16)}`.padStart(32, '0');
  const card = refinementCard(proposalId, routine, Date.now());
  // A refusal says why the Routine was not changed, in place of the card.
  const answer = state.refusal ? { routine_refusal: { code: state.refusal } } : { routine_refinement: card };
  if (!state.refusal) state.proposals = { ...state.proposals, [proposalId]: { refinement: card } };
  const reply = {
    type: 'done', team_id: 'marketing', team_name: teamName, clarification: null, usage: structuredClone(MODEL_USAGE),
    reply: '', ...answer,
  };
  const turn = `${'e'.repeat(24)}${state.sequence.toString(16).padStart(8, '0')}`;
  const at = instant(Date.now());
  state.history = [
    ...state.history,
    { id: `${turn}:user`, created_at: at, kind: 'message', role: 'user', text: message },
    {
      id: `${turn}:reply`, created_at: at, kind: 'message', role: 'assistant', text: '', author: teamName,
      usage: structuredClone(MODEL_USAGE), ...structuredClone(answer),
    },
  ];
  return reply;
}

function remainingProposals(state, proposalId) {
  return Object.fromEntries(Object.entries(state.proposals ?? {}).filter(([key]) => key !== proposalId));
}

// Cancelar: revoking a card, or a card already gone, creates nothing.
// How the person answered a card, kept beside it in the transcript as Admin keeps it: the first answer only.
function answered(state, proposalId, status) {
  const id = `${proposalId}:answer`;
  const card = state.history.find((entry) => (entry.routine_proposal ?? entry.routine_refinement)?.proposal_id === proposalId);
  if (!card || state.history.some((entry) => entry.id === id)) return;
  const { name } = card.routine_proposal ?? card.routine_refinement;
  const answer = { id, kind: 'routine-answer', proposal_id: proposalId, status, name };
  state.history = [...state.history, { ...answer, created_at: instant(Date.now()) }];
}

function revokeProposal(state, { proposal_id: proposalId }) {
  state.proposals = remainingProposals(state, proposalId);
  state.revoked = [...(state.revoked ?? []), proposalId];
  answered(state, proposalId, 'revoked');
  return { status: 200, json: { team_id: 'marketing', proposal_id: proposalId, routine_id: null, status: 'revoked' } };
}

// Criar: confirming a pending card creates its Routine with its created notice. A used, revoked, or expired
// card is refused.
function confirmProposal(state, { proposal_id: proposalId }) {
  const proposal = state.proposals?.[proposalId];
  const remaining = remainingProposals(state, proposalId);
  const expires = proposal?.refinement?.expires_at ?? proposal?.expires_at;
  if (!proposal || Date.parse(expires) <= Date.now()) return { status: 409, json: { code: 'routine-proposal-expired' } };
  state.proposals = remaining;
  if (proposal.refinement) {
    // A refinement changes the Routine it names into its next revision (ADR-0122).
    const { routine_id: routineId } = proposal.refinement;
    state.routines = state.routines.map((item) => (item.routine_id === routineId
      ? { ...item, plan: { ...item.plan, revision: item.plan.revision + 1 } }
      : item));
    answered(state, proposalId, 'changed');
    return { status: 200, json: { team_id: 'marketing', proposal_id: proposalId, routine_id: routineId, status: 'changed' } };
  }
  // The Routine runs exactly as its card showed; an interval's first run starts right after confirmation.
  const routine = routineView({
    routine_id: `9${proposalId.slice(-8)}`.padStart(32, '0'),
    name: proposal.name,
    output: { mode: proposal.output, step: proposal.output === 'none' ? null : CARD_STEPS.length },
    schedule: proposal.schedule,
    timezone: proposal.timezone,
    timezone_source: proposal.timezone_source,
    next_run_at: instant(Date.now()),
  }, CARD_STEPS);
  state.routines = [...state.routines, routine];
  state.plans = { ...state.plans, [routine.routine_id]: CARD_STEPS };
  const noticeId = `7${proposalId.slice(-8)}`.padStart(32, '0');
  state.history = [...state.history, noticeRow(noticeId, routine, 'created', structuredClone(CREATION), { at: instant(Date.now()) })];
  answered(state, proposalId, 'created');
  return { status: 200, json: { team_id: 'marketing', proposal_id: proposalId, routine_id: routine.routine_id, status: 'created' } };
}

/** Criar and Cancelar for a card (ADR-0101), as the session socket's proposal operations. */
export const ROUTINE_PROPOSAL_METHODS = Object.freeze({
  'routines.proposal_confirm': confirmProposal,
  'routines.proposal_revoke': revokeProposal,
});
