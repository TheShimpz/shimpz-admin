// Routine scenarios for the owner's preview and the browser tests (ADR-0087, ADR-0092): every Routine notice, a held
// run's recovery card with the error its step returned (a Cloudflare account out of credits), a paused Routine, a
// minute rollup, a run's execution details, and the daily-cap question of a continuous request. Pure data and state
// transitions; nothing here reaches a real Admin, Team, Brain, or provider.

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

// The continuous Routine created from chat, healthy and rolling its runs up per minute; a weekly Routine whose run is
// held for recovery; a daily Routine its failures paused, which nothing holds; and a monthly one a person paused from
// its card while its held run still waits for a decision.
const UPDATE = {
  id: 'update',
  assistant: 'shimpz-cloudflare',
  action: 'update-dns-record',
  inputs: [{ member: 'record_id', source: 'step_output', step: 'records', pointer: '/records/0/id' }],
  stored_inputs: ['api-token'],
};
const DELETE = {
  id: 'delete',
  assistant: 'shimpz-cloudflare',
  action: 'delete-dns-record',
  inputs: [{ member: 'record_id', source: 'step_output', step: 'records', pointer: '/records/2/id' }],
  stored_inputs: ['api-token'],
};

function routines(locale) {
  const { names, quotes } = textFor(locale);
  return [
    { ...ROUTINE, routine_id: id('1'), schedule: { kind: 'continuous', gap: 5, cap: 500 } },
    {
      ...ROUTINE,
      routine_id: id('2'),
      steps: [...STEPS, UPDATE],
      schedule: { kind: 'weekly', weekday: 6, time: '08:00' },
      next_run_at: '2026-10-04T11:00:00Z',
    },
    { ...ROUTINE, routine_id: id('3'), schedule: { kind: 'daily', time: '09:00' }, paused: true },
    { ...ROUTINE, routine_id: id('4'), steps: [...STEPS, DELETE], schedule: { kind: 'monthly', day: 1, time: '10:00' }, paused: true },
  ].map((routine, index) => ({ ...routine, name: names[index], quote: quotes[index] }));
}

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
    row(id('c'), CONTINUOUS, 'done', { actions: ACTIONS }, { at: yesterday(-50) }),
    row(id('d'), CONTINUOUS, 'healthy', { runs: 9 }, { run: false, at: yesterday(0), version: 9 }),
    row(id('e'), HELD, 'recovered', { actions: ACTIONS }, { at: yesterday(20) }),
    row(id('f'), HELD, 'user-skipped', {
      assistant_id: 'shimpz-cloudflare', action: 'update-dns-record', choice: 'run',
    }, { at: at(-150) }),
    row(FAILED_RUN, PAUSED, 'failed', { code: 'assistant-rpc-failed', actions: [ACTIONS[0]] }, { at: at(-120), version: 1 }),
    row(HELD_RUN, HELD, 'held', { assistant_id: 'shimpz-cloudflare', action: 'update-dns-record' }, {
      at: at(-90), version: 2,
    }),
    row(PAUSED_RUN, PAUSED_HELD, 'paused', {
      assistant_id: 'shimpz-cloudflare', action: 'delete-dns-record', reason: 'exhausted',
    }, { at: at(-60), version: 3 }),
  ];
}

export function routineLifecycleStart(locale = 'en', now = Date.now()) {
  const listed = routines(locale);
  const [, HELD, , PAUSED_HELD] = listed;
  return {
    routines: listed,
    runs: [],
    incidents: [incident(HELD_RUN, HELD, 'update-dns-record'), incident(PAUSED_RUN, PAUSED_HELD, 'delete-dns-record')],
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
      detail: { assistant_id: held.assistant_id, action: held.action, choice },
      version: entry.version + 1,
    }
    : entry));
}

function card(state, incidentId) {
  const held = state.incidents.find((item) => item.incident_id === incidentId);
  if (!held) return { status: 404, json: { code: 'routine-incident-unavailable' } };
  state.cards = (state.cards ?? 0) + 1;
  const steps = state.routines.find((item) => item.routine_id === held.routine_id)?.steps ?? [];
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
      step: Math.max(1, steps.findIndex((step) => step.action === held.action) + 1),
      steps: Math.max(1, steps.length),
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
  const attempt = (number, action, failure, condition) => ({
    operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
    attempt: number,
    assistant_id: 'shimpz-cloudflare',
    action,
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

// The continuous request with no daily cap, asked as Brain asks it in the interface language: each option names its cap.
const CAP_OPTIONS = [100, 500, 1000];

export function capClarification(locale = 'en') {
  const text = textFor(locale);
  return {
    question: text.capQuestion,
    options: CAP_OPTIONS.map((cap) => ({ label: text.capLabel.replace('{cap}', String(cap)), description: '' })),
    default_index: 0,
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
  const noticeId = `7${state.sequence.toString(16)}`.padStart(32, '0');
  state.history = [...state.history, row(noticeId, routine, 'created', defined(routine), { run: false })];
  return { ...base, reply: text.capReply.replace('{cap}', String(cap)), clarification: null };
}
