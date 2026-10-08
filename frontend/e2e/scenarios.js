// Admin API scenarios shared by the browser tests and the preview (ADR-0087). A scenario is a pure factory: each call
// returns fresh state, answers only the requests it declares, and returns null for anything else so the caller fails
// closed. Nothing here reaches a real Admin, Team, Brain, or provider.
import modelCatalog from '../src/lib/modelCatalog.json' with { type: 'json' };
import { attachmentReply, fileApprovalChallenge, recordAttachedTurn, uploadFile } from './attachmentScenarios.js';
import { localizedChallenge } from './localizedRequest.js';
import {
  recordDeletion,
  recordingReply,
  ROUTINE_QUESTIONS,
  routineLifecycleStart,
  routineProposalRoutes,
  routineRecoveryRoutes,
  routineStepRoutes,
  routineView,
  setAside,
} from './routineScenarios.js';

export const TEAM = { team_id: 'marketing', team_name: 'Marketing', status: 'running' };

// The Local sidebar as the owner sees it: newest first, Marketing (the Team the chat scenarios talk to) on top.
export const TEAMS = Object.freeze([
  TEAM,
  ...['Trinity', 'Cypher', 'Morpheus', 'Neo', 'Smith'].map((name) => ({
    team_id: name.toLowerCase(),
    team_name: name,
    status: 'running',
  })),
]);
const MAX_TEAMS = 128;
const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;

export const ASSISTANTS = [
  { id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare' },
  { id: 'whatsapp', title: 'WhatsApp' },
];

export const ROUTINE_PLAN = [
    {
      position: 1,
      assistant: 'shimpz-cloudflare',
      action: 'list-zones',
      read_only: true,
      inputs: [{ member: 'page', source: 'literal', value: '1' }],
      stored_inputs: ['api-token'],
    },
  ];

export const ROUTINE_VIEW = routineView({
  routine_id: 'a'.repeat(32),
  name: 'Daily DNS zones',
  output: { mode: 'show', step: 1 },
  schedule: { kind: 'daily', time: '09:00' },
  next_run_at: '2026-10-01T12:00:00Z',
}, ROUTINE_PLAN);

const WEEKLY_ROUTINE = {
  ...ROUTINE_VIEW,
  routine_id: 'd'.repeat(32),
  name: 'Weekly certificates',
  schedule: { kind: 'weekly', weekday: 0, time: '08:00' },
  next_run_at: '2026-10-05T11:00:00Z',
};

// A held run's unresolved incident (ADR-0092): its Routine is paused until a recovery card settles it.
const HELD_INCIDENT = {
  incident_id: 'b'.repeat(32),
  routine_id: ROUTINE_VIEW.routine_id,
  name: ROUTINE_VIEW.name,
  created_at: '2026-09-30T12:01:07Z',
  assistant_id: 'shimpz-cloudflare',
  action: 'replace-dns-record',
  position: { phase: 'replay', step: 1 },
  steps: 1,
};

const FROZEN_RUN = {
  run_id: 'f'.repeat(32),
  routine_id: WEEKLY_ROUTINE.routine_id,
  status: 'frozen',
  scheduled_at: '2026-09-29T11:00:00Z',
  request_kind: 'human',
  assistant_id: 'shimpz-cloudflare',
  action: 'list-zones',
  position: { phase: 'replay', step: 1 },
  steps: 1,
};

export function authenticatedLocalSession(overrides = {}) {
  return {
    profile: 'local',
    authenticated: true,
    initialized: true,
    authentication_state: 'configured',
    authentication_method: 'webauthn',
    origin_admitted: true,
    oauth_completion_mode: 'automatic',
    passkey_enrollment_available: true,
    passkey_registered: true,
    ...overrides,
  };
}

// Responses are deep copies, so neither a caller nor another scenario can mutate a scenario's state.
const ok = (json) => ({ status: 200, json: structuredClone(json) });

// Each scenario names its starting state; `ready` is the Local chat with its Team list and no Routines.
const STARTS = {
  ready: () => ({ session: authenticatedLocalSession(), teams: [...TEAMS], routines: [], runs: [] }),
  // The next Team order save finds the membership changed: a Team created elsewhere appears, and Admin answers 409.
  'reorder-conflict': () => ({
    session: authenticatedLocalSession(),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    reorder: 'conflict-once',
  }),
  // The next Team order save fails the way an unavailable Admin does.
  'reorder-unavailable': () => ({
    session: authenticatedLocalSession(),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    reorder: 'unavailable-once',
  }),
  routines: () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [{ ...ROUTINE_VIEW, state: 'paused' }, WEEKLY_ROUTINE],
    plans: { [ROUTINE_VIEW.routine_id]: ROUTINE_PLAN, [WEEKLY_ROUTINE.routine_id]: ROUTINE_PLAN },
    runs: [FROZEN_RUN],
    incidents: [HELD_INCIDENT],
  }),
  // Every Routine notice in the stored history (the chat shows the creations, each panel its Routine's runs), runs'
  // usage with and without a model, a held run's recovery card, a paused Routine, a minute rollup, and a run's
  // execution details (ADR-0092, ADR-0101).
  'routine-lifecycle': (locale) => ({ session: authenticatedLocalSession(), teams: [TEAM], ...routineLifecycleStart(locale) }),
  // Any message is a recording turn whose reply carries the owner's Cloudflare watch card: Criar rotina creates it,
  // Cancelar revokes it (ADR-0101).
  'routine-card': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
  }),
  // Any message is a recording turn whose request would hold a password, so its reply says no Routine was created.
  'routine-refusal': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'refusal',
  }),
  // Any message is a recording turn whose reply asks Team's question first (ADR-0101): when the Routine should run,
  // which of two zones named shimpz.com it uses, or that no interval fits the Team's budget. The answer gets the card.
  'routine-question': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
    question: ROUTINE_QUESTIONS.schedule,
  }),
  'routine-output': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
    question: ROUTINE_QUESTIONS.output,
  }),
  'routine-ambiguous': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
    question: ROUTINE_QUESTIONS.ambiguous,
  }),
  'routine-exact-target': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
    question: ROUTINE_QUESTIONS.exact,
  }),
  clarify: () => ({ session: authenticatedLocalSession(), teams: [TEAM], routines: [], runs: [], clarify: 'ok' }),
  'clarify-error': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    clarify: 'fail-once',
  }),
  'human-request': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    human: 'stored-input',
  }),
  'human-approval': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    human: 'approval',
  }),
  // A plain approval whose kicker names the Assistant while the Creator's own title stays.
  'human-confirm': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    human: 'confirm',
  }),
  // Chat attachments (ADR-0093): files upload to the Team, and a reply to a message with files names the Actions
  // Team withheld for them; an install request with files gets the attachment-free guidance.
  attachments: () => ({ session: authenticatedLocalSession(), teams: [TEAM], routines: [], runs: [] }),
  // Every upload finds the Team's storage full.
  'attachments-full': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    uploads: 'full',
  }),
  // An Action asks to receive the attached original; the approval names the file and its embedded metadata.
  'attachment-approval': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    human: 'file',
  }),
  empty: () => ({ session: authenticatedLocalSession(), teams: [], routines: [], runs: [] }),
  setup: () => ({
    session: { profile: 'local', authenticated: false, initialized: false, authentication_state: 'uninitialized' },
    teams: [],
    routines: [],
    runs: [],
  }),
};

export const SCENARIOS = Object.freeze(Object.keys(STARTS));

function providers() {
  return modelCatalog.providers.map(({ credential_validation: _validation, ...provider }) => ({
    ...provider,
    configured: true,
    masked: '••••1234',
  }));
}

// Deleting a Routine (ADR-0051): any password but `wrong password` is the Supervisor's, then any six-digit code but
// `000000` confirms it. The preview offers only the code, since it cannot answer a real passkey.
function routineDeletion(method, path, body) {
  const begin = path.match(/^\/api\/teams\/marketing\/routines\/([0-9a-f]{32})\/deletion$/);
  if (begin && method === 'POST') {
    if (typeof body?.password !== 'string' || !body.password) return { status: 400, json: { detail: 'invalid' } };
    if (body.password === 'wrong password') return { status: 401, json: { code: 'password-incorrect' } };
    return { status: 202, json: { methods: ['totp'] } };
  }
  const routine = path.match(/^\/api\/teams\/marketing\/routines\/([0-9a-f]{32})$/);
  if (routine && method === 'DELETE' && body?.code === '000000') return { status: 401, json: { code: 'code-incorrect' } };
  if (routine && method === 'DELETE' && !/^[0-9]{6}$/.test(body?.code ?? '')) {
    return { status: 401, json: { code: 'authentication-expired' } };
  }
  return null;
}

function routineRoutes(state, method, path, body) {
  const deletion = routineDeletion(method, path, body);
  if (deletion) return deletion;
  const base = '/api/teams/marketing/routines';
  if (path === base && method === 'GET') {
    return ok({ team_id: 'marketing', routines: state.routines, runs: state.runs, incidents: state.incidents ?? [] });
  }
  const resume = path.match(/^\/api\/teams\/marketing\/routines\/([0-9a-f]{32})\/resume$/);
  if (resume && method === 'POST') {
    state.routines = state.routines.map((item) => (item.routine_id === resume[1] ? { ...item, state: 'active' } : item));
    return ok({ team_id: 'marketing', routine_id: resume[1], paused: false });
  }
  const routine = path.match(/^\/api\/teams\/marketing\/routines\/([0-9a-f]{32})$/);
  if (routine && method === 'DELETE') {
    // Deleting a Routine sets each of its held runs aside, as Team does.
    for (const held of (state.incidents ?? []).filter((item) => item.routine_id === routine[1])) {
      setAside(state, held.incident_id, 'delete');
    }
    // Its last notice names it and closes its timeline.
    const deleted = state.routines.find((item) => item.routine_id === routine[1]);
    if (deleted) recordDeletion(state, deleted);
    state.routines = state.routines.filter((item) => item.routine_id !== routine[1]);
    state.runs = state.runs.filter((run) => run.routine_id !== routine[1]);
    return ok({ team_id: 'marketing', routine_id: routine[1], deleted: true });
  }
  return null;
}

// PUT /api/teams/order: exactly `{ team_ids }`, an exact permutation of the current Team ids. A malformed body is 400;
// a body naming another set of Teams is 409, so the page reloads the list.
function reorderTeams(state, body) {
  const ids = body?.team_ids;
  if (
    !body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !Array.isArray(ids) || ids.length > MAX_TEAMS ||
    !ids.every((id) => typeof id === 'string' && TEAM_ID_RE.test(id)) || new Set(ids).size !== ids.length
  ) {
    return { status: 400, json: { detail: 'Invalid Team order.' } };
  }
  if (state.reorder === 'unavailable-once') {
    state.reorder = null;
    return { status: 503, json: { detail: 'The Team order is unavailable.' } };
  }
  if (state.reorder === 'conflict-once') {
    state.reorder = null;
    state.teams = [{ team_id: 'oracle', team_name: 'Oracle', status: 'running' }, ...state.teams];
  }
  const byId = new Map(state.teams.map((team) => [team.team_id, team]));
  if (ids.length !== byId.size || !ids.every((id) => byId.has(id))) {
    return { status: 409, json: { detail: 'The Teams changed. Reload the list.' } };
  }
  state.teams = ids.map((id) => byId.get(id));
  return ok({ teams: state.teams });
}

// Every listed Team other than Marketing answers its read-only views empty, so selecting one in the preview works.
function otherTeamRoutes(state, method, path) {
  const match = path.match(/^\/api\/teams\/([a-z0-9_]{1,40})\/(.+)$/);
  if (method !== 'GET' || !match || !state.teams.some((team) => team.team_id === match[1])) return null;
  const [, teamId, view] = match;
  return {
    assistants: () => ok({ assistants: [] }),
    files: () => ok({ files: [] }),
    'chat/history': () => ok({ entries: [], before: null }),
    inference: () => ok({ team_id: teamId, provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' }),
    'assistant-integrations': () => ok({ integrations: [] }),
    'assistant-stored-inputs': () => ok({ stored_inputs: [] }),
    routines: () => ok({ team_id: teamId, routines: [], runs: [], incidents: [] }),
  }[view]?.() ?? null;
}

// A recurring request creates its Routine directly from the user's own message (ADR-0092), with a created notice.
export const CLARIFICATION = Object.freeze({
  question: '“Todas as opções do mercado” é amplo demais para validar literalmente. Qual escopo de comparação você quer?',
  options: [
    {
      label: 'Principais APIs gerenciadas',
      description: 'Comparar plataformas prontas de agentes de voz em tempo real, custos, idiomas, latência e recursos.',
    },
    {
      label: 'Stack montável',
      description: 'Comparar frameworks e provedores de STT, LLM, TTS e telefonia para montar uma solução própria.',
    },
    {
      label: 'Shortlist ampla',
      description: 'Mapear as principais APIs e frameworks, com foco em conversação em português e custo total.',
    },
  ],
  default_index: 2,
});

// The clarify scenarios ask one question for a first request and answer the composed reply; `fail-once` fails the
// first answer the way an Assistant Action failure does, so the retry can be seen.
function clarifyReply(state, message) {
  const answer = message.match(/\n(?:Resposta|Answer): (.+)$/u)?.[1];
  if (!answer) {
    return {
      type: 'done',
      team_id: 'marketing',
      team_name: state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name,
      reply: `${CLARIFICATION.question}\n\n${CLARIFICATION.options
        .map((option, index) => `${index + 1}. ${option.label}${index === CLARIFICATION.default_index ? ' ✓' : ''} — ${option.description}`)
        .join('\n')}`,
      clarification: structuredClone(CLARIFICATION),
    };
  }
  if (state.clarify === 'fail-once') {
    state.clarify = 'ok';
    return { type: 'error', status: 502, detail: 'local chat request failed' };
  }
  return {
    type: 'done',
    team_id: 'marketing',
    team_name: state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name,
    reply: `Certo — sigo com **${answer}**. Preview reply for the chosen scope.`,
    clarification: null,
  };
}

// The human-request scenario pauses an Action for a Stored Input the Team does not hold yet (ADR-0090). Its purpose is
// written in Portuguese, so Team projects it only in a Portuguese challenge (ADR-0091).
const STORED_INPUT_REQUEST = Object.freeze({
  kind: 'input:password',
  ordinal: 0,
  title: 'Exa API key',
  description: 'Exa search uses your Exa API key. It is stored encrypted for this Team and reused.',
  fingerprint: 'c'.repeat(64),
  label: 'Exa API key',
  required: true,
  placeholder: 'Paste your Exa API key',
  min_length: 1,
  max_length: 128,
  stored_input: 'exa-api-key',
});

function storedInputChallenge(locale) {
  return {
    type: 'human-required',
    challenge_id: 'b'.repeat(32),
    expires_in: 180,
    assistant: { id: 'shimpz-exa', name: 'Exa', version: '0.1.1' },
    action: { id: 'search-web', summary: 'Search the web with Exa.' },
    ...(locale === 'pt' ? { purpose: 'Para trazer as notícias de IA de hoje, preciso pesquisar na web com o Exa.' } : {}),
    help_url: 'https://dashboard.exa.ai/api-keys',
    ...localizedChallenge(STORED_INPUT_REQUEST, { locale }),
  };
}

// The human-approval scenario asks to choose how a DNS change is published. Team renders the Assistant's English copy
// in the requested interface language (ADR-0091); this preview carries Portuguese text and English text otherwise.
const APPROVAL_REQUEST = Object.freeze({
  kind: 'input:choice',
  ordinal: 0,
  title: 'DNS changes to publish: 3. Zone: example.com.',
  description: 'Choose how Shimpz Cloudflare publishes the reviewed records for example.com.',
  fingerprint: 'c'.repeat(64),
  label: 'Publishing mode',
  required: true,
  options: [
    { value: 'proxied', label: 'Proxied', description: 'Route traffic through Cloudflare.' },
    { value: 'dns-only', label: 'DNS only', description: null },
  ],
});
const APPROVAL_COPY = Object.freeze({
  pt: {
    title: 'Alterações de DNS a publicar: 3. Zona: example.com.',
    description: 'Escolha como o Shimpz Cloudflare publica os registros revisados de example.com.',
    label: 'Modo de publicação',
    options: [
      { label: 'Com proxy', description: 'Encaminhar o tráfego pela Cloudflare.' },
      { label: 'Somente DNS', description: null },
    ],
  },
});

function approvalChallenge(locale) {
  return {
    type: 'human-required',
    challenge_id: 'b'.repeat(32),
    expires_in: 180,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'publish-dns', summary: 'Publish reviewed DNS changes.' },
    ...localizedChallenge(APPROVAL_REQUEST, { locale, shown: APPROVAL_COPY[locale] ?? {} }),
  };
}

// A plain approval request, where the Creator's own title stays and the kicker names the Assistant.
const CONFIRM_REQUEST = Object.freeze({
  kind: 'approval',
  ordinal: 0,
  title: 'Publish reviewed DNS changes?',
  description: 'Cloudflare will update the A record for www.example.com.',
  fingerprint: 'e'.repeat(64),
});

function confirmChallenge(locale) {
  return {
    type: 'human-required',
    challenge_id: 'd'.repeat(32),
    expires_in: 180,
    assistant: { id: 'shimpz-cloudflare', name: 'Cloudflare', version: '0.4.4' },
    action: { id: 'update-dns-record', summary: 'Update one DNS record.' },
    // The purpose was written in English, so Team projects it only in an English challenge (ADR-0091).
    ...(locale === 'en'
      ? { purpose: 'To point your domain at the new server, I need to change one DNS record in Cloudflare.' }
      : {}),
    ...localizedChallenge(CONFIRM_REQUEST, { locale }),
  };
}

const HUMAN_CHALLENGES = Object.freeze({
  approval: approvalChallenge,
  confirm: confirmChallenge,
  file: fileApprovalChallenge,
  'stored-input': storedInputChallenge,
});

// The pending request in the language a chat or sync frame names, as Team reopens it.
function humanChallenge(state, frame) {
  return HUMAN_CHALLENGES[state.human](frame.locale ?? 'en');
}

// Every preview reply reports what its task used, like Team does: tokens per model and the turn's duration.
const PREVIEW_USAGE = Object.freeze({
  duration_ms: 6240,
  models: [
    { provider: 'openai', model: 'gpt-6-luna', input_tokens: 11_900, output_tokens: 580 },
  ],
});

function chatReply(state, frame) {
  const message = typeof frame.message === 'string' ? frame.message : '';
  if (state.clarify) return clarifyReply(state, message);
  const teamName = state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name;
  if (state.recording) return recordingReply(state, message, teamName);
  return {
    type: 'done',
    team_id: 'marketing',
    team_name: teamName,
    reply: `Preview reply to: ${message}`,
    clarification: null,
    usage: structuredClone(PREVIEW_USAGE),
  };
}

/**
 * The rows of a Team's history in the view Admin reads: the chat's view holds, of the Routine notices, only each
 * Routine's creation; a Routine's own view (`routine`, its id) holds only its runs, healthy rollups, and missed runs.
 */
export function historyView(entries, routine = null) {
  return entries.filter((entry) => (routine === null
    ? entry.kind !== 'routine-run' || entry.outcome === 'created'
    : entry.kind === 'routine-run' && entry.routine_id === routine &&
      (entry.run_id !== null || entry.outcome === 'healthy' || entry.outcome === 'skipped')));
}

/**
 * A fresh scenario; `respond` returns `{ status, json }` or null for a request this scenario does not answer. `query`
 * holds the request's search parameters.
 */
export function createScenario(name = 'ready', locale = 'en') {
  const start = STARTS[name];
  if (!start) throw new Error(`unknown scenario: ${name}`);
  // A scenario's own texts, such as a Routine's name and request, are written in the interface language it starts in.
  const state = { history: [], sequence: 0, locale, ...structuredClone(start(locale)) };
  return {
    name,
    respond({ method = 'GET', path, query = new URLSearchParams(), body = null }) {
      if (path === '/api/session' && method === 'POST') return ok(state.session);
      if (!state.session.authenticated) return null;
      if (path === '/api/teams' && method === 'GET') return ok({ teams: state.teams });
      if (path === '/api/teams/order' && method === 'PUT') return reorderTeams(state, body);
      if (path === '/api/assistants' && method === 'GET') return ok({ assistants: ASSISTANTS });
      if (path === '/api/model-providers' && method === 'GET') return ok({ providers: providers() });
      if (path === '/api/decision-provider' && method === 'GET') {
        return ok({ provider: 'typesafe', configured: false, masked: null });
      }
      if (path === '/api/teams/marketing' && method === 'PATCH' && state.teams.length) {
        const name = typeof body?.team_name === 'string' ? body.team_name.trim() : '';
        if (!name || name.length > 80) return { status: 400, json: { detail: 'Enter a valid Team name.' } };
        state.teams = state.teams.map((team) => (team.team_id === 'marketing' ? { ...team, team_name: name } : team));
        return ok({ team_id: 'marketing', team_name: name });
      }
      if (!state.teams.length) return null;
      if (!path.startsWith('/api/teams/marketing/')) return otherTeamRoutes(state, method, path);
      if (path === '/api/teams/marketing/assistants' && method === 'GET') {
        return ok({
          assistants: [
            { assistant: 'shimpz-cloudflare', assistant_version: '0.4.1', status: 'running', provenance: 'published' },
            // A human request names an installed Assistant; Admin refuses one the Team inventory does not list.
            ...(state.human === 'stored-input'
              ? [{ assistant: 'shimpz-exa', assistant_version: '0.1.1', status: 'running', provenance: 'published' }]
              : []),
          ],
        });
      }
      if (path === '/api/teams/marketing/files' && method === 'GET') return ok({ files: [] });
      if (path === '/api/teams/marketing/files' && method === 'POST') return uploadFile(state, body);
      if (path === '/api/teams/marketing/chat/history' && method === 'GET') {
        return ok({ entries: historyView(state.history, query.get('routine')), before: null });
      }
      if (path === '/api/teams/marketing/inference' && method === 'GET') {
        return ok({ team_id: 'marketing', provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' });
      }
      if (path === '/api/teams/marketing/inference' && method === 'PUT') return ok({ team_id: 'marketing', ...body });
      if (path === '/api/teams/marketing/assistant-integrations' && method === 'GET') return ok({ integrations: [] });
      if (path === '/api/teams/marketing/assistant-stored-inputs' && method === 'GET') return ok({ stored_inputs: [] });
      return routineRecoveryRoutes(state, method, path, body) ?? routineStepRoutes(state, method, path) ??
        routineProposalRoutes(state, method, path, body) ?? routineRoutes(state, method, path, body);
    },
    // The chat socket: `open` and `message` return the frames to send back, in order.
    chat: {
      path: '/api/teams/marketing/chat/ws',
      // The listed Team a chat socket path belongs to, or null; the preview answers every listed Team's chat.
      team(path) {
        const teamId = path.match(/^\/api\/teams\/([a-z0-9_]{1,40})\/chat\/ws$/)?.[1];
        return teamId && state.teams.some((team) => team.team_id === teamId) ? teamId : null;
      },
      message(frame, teamId = 'marketing') {
        // Any Team but Marketing just echoes, so a Team picked in the preview chats without a scenario of its own.
        if (teamId !== 'marketing') {
          if (frame?.type === 'sync') return [{ type: 'sync-empty' }];
          if (frame?.type !== 'chat') return [];
          return [{
            type: 'done',
            team_id: teamId,
            team_name: state.teams.find((team) => team.team_id === teamId)?.team_name ?? teamId,
            reply: `Preview reply to: ${typeof frame.message === 'string' ? frame.message : ''}`,
            clarification: null,
            usage: structuredClone(PREVIEW_USAGE),
          }];
        }
        if (frame?.type === 'sync') return state.humanPending ? [humanChallenge(state, frame)] : [{ type: 'sync-empty' }];
        if (frame?.type === 'chat' && state.human) {
          state.humanPending = true;
          return [humanChallenge(state, frame)];
        }
        if (frame?.type === 'human-response') {
          state.humanPending = false;
          return [{
            type: 'done',
            team_id: 'marketing',
            team_name: state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name,
            reply: frame.decision === 'deny'
              ? 'Ok — I stopped that Action.'
              : {
                approval: `Done — published with ${frame.value}.`,
                confirm: 'Done — the DNS record was updated.',
                file: 'Done — Contract.pdf is in the R2 bucket “contracts”.',
              }[state.human] ?? 'Done — the search ran with your key.',
            clarification: null,
          }];
        }
        if (frame?.type === 'chat' && Array.isArray(frame.files) && frame.files.length) {
          const reply = attachmentReply(state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name, frame);
          recordAttachedTurn(state, frame, reply);
          return [reply];
        }
        if (frame?.type === 'chat') return [structuredClone(chatReply(state, frame))];
        return [];
      },
    },
  };
}
