// Admin API scenarios shared by the browser tests and the preview (ADR-0087). A scenario is a pure factory: each call
// returns fresh state, answers only the requests it declares, and returns null for anything else so the caller fails
// closed. Nothing here reaches a real Admin, Team, Brain, or provider.
import modelCatalog from '../src/lib/brain/catalog.json' with { type: 'json' };
import {
  attachmentReply,
  fileApprovalChallenge,
  recordAttachedTurn,
  manyImagesHistory,
  sentImagesHistory,
  uploadFile,
} from './attachmentScenarios.js';
import { catalogBindingAnswer, catalogImageAnswer, catalogInventory, catalogSnapshots } from './catalogScenario.js';
import { localizedChallenge } from './localizedRequest.js';
import {
  recordDeletion,
  recordingReply,
  ROUTINE_QUESTIONS,
  routineLifecycleStart,
  ROUTINE_PROPOSAL_METHODS,
  ROUTINE_RECOVERY_METHODS,
  ROUTINE_STEP_METHODS,
  routineView,
  setAside,
} from './routineScenarios.js';
import { recoveryCodeSet, SECURITY_METHODS, securityRoutes, securityStart, securitySummary } from './securityScenarios.js';

const TEAM = { team_id: 'marketing', team_name: 'Marketing', status: 'running' };

// The Local sidebar as the owner sees it: newest first, Marketing (the Team the chat scenarios talk to) on top.
const TEAMS = Object.freeze([
  TEAM,
  ...['Trinity', 'Cypher', 'Morpheus', 'Neo', 'Smith'].map((name) => ({
    team_id: name.toLowerCase(),
    team_name: name,
    status: 'running',
  })),
]);
const MAX_TEAMS = 128;
const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;

const ASSISTANTS = [
  { id: 'shimpz-cloudflare', title: 'Cloudflare' },
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
  position: 1,
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
  position: 1,
  steps: 1,
};

/** Admin's session answer before any sign-in; `overrides` sets the fields a test changes. */
export function localSession(overrides = {}) {
  return {
    profile: 'local',
    authenticated: false,
    initialized: false,
    authentication_state: 'uninitialized',
    ...overrides,
  };
}

/** Admin's session answer for a Supervisor signed in with a passkey at a loopback origin. */
export function authenticatedLocalSession(overrides = {}) {
  return localSession({
    authenticated: true,
    initialized: true,
    authentication_state: 'configured',
    authentication_method: 'webauthn',
    origin_admitted: true,
    oauth_completion_mode: 'automatic',
    passkey_enrollment_available: true,
    passkey_registered: true,
    ...overrides,
  });
}

// Responses are deep copies, so neither a caller nor another scenario can mutate a scenario's state.
const ok = (json) => ({ status: 200, json: structuredClone(json) });
// Each scenario names its starting state; `ready` is the Local chat with its Team list and no Routines.
const STARTS = {
  ready: () => ({ session: authenticatedLocalSession(), teams: [...TEAMS], routines: [], runs: [] }),
  // The owner's Assistants catalog: four staged Assistants, two installed in Marketing, each with its own page.
  catalog: () => ({ session: authenticatedLocalSession(), teams: [...TEAMS], routines: [], runs: [], catalog: true }),
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
  // Every reply lists the Team steps of its turn under its usage line, and the history keeps them with the reply as
  // Admin does, so a reload opens the same steps (ADR-0082).
  'chat-receipt': () => ({
    session: authenticatedLocalSession(),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    receipt: true,
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
  // Any message is a recording turn whose reply carries the owner's Cloudflare watch card: Criar creates it,
  // Cancelar revokes it (ADR-0101).
  // The card's Assistants open their own pages, so the installed catalog answers them.
  'routine-card': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    recording: 'card',
    catalog: true,
  }),
  // The same card in a Space of several Teams, so a page can move to another Team while the card is answered.
  'routine-card-teams': () => ({
    session: authenticatedLocalSession(),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    recording: 'card',
    catalog: true,
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
  // An Action's declared approval lists the Action's input as Team rendered it (ADR-0115), with one shortened row and
  // the count of fields past the sixteenth.
  'approval-input': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    human: 'input',
  }),
  // Chat attachments (ADR-0093): files upload to the Team, and a reply to a message with files names the Actions
  // Team withheld for them; an install request with files gets the attachment-free guidance.
  attachments: () => ({ session: authenticatedLocalSession(), teams: [TEAM], routines: [], runs: [] }),
  // A sent message that carried images shows their thumbnails, each opening its image over the chat; a PDF and an image
  // Team no longer holds keep their cards (ADR-0093).
  'attachment-images': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    history: sentImagesHistory(),
  }),
  // More sent images than the session keeps thumbnails of, one per message down a long chat.
  'attachment-many-images': () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [],
    runs: [],
    history: manyImagesHistory(),
  }),
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
  // The Supervisor signs in again: with an authenticator code, or with a recovery code and the authenticator's
  // re-enrollment it begins, which shows a new set of codes once (ADR-0051).
  'sign-in': () => ({
    session: localSession({ initialized: true, authentication_state: 'configured' }),
    teams: [...TEAMS],
    routines: [],
    runs: [],
  }),
  // The signed-in Supervisor with two recovery codes left: Security replaces them all after the password and a code.
  'recovery-codes': () => ({
    session: authenticatedLocalSession({
      authentication_method: 'totp',
      passkey_enrollment_available: false,
      passkey_registered: false,
    }),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    security: securityStart({ used: recoveryCodeSet(0).slice(0, 8) }),
  }),
  // The sign-in after three refused authenticator codes: the report stays on every page until acknowledged, and Security
  // names the previous sign-in, its address, and the four refused attempts since it (ADR-0051).
  'security-alert': () => ({
    session: authenticatedLocalSession({ authentication_method: 'totp' }),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    security: securityStart({
      failedAttempts: 3,
      signIns: { previous: { at: '2026-10-08T21:14:00Z', origin: 'https://admin.example.com' }, failures_since: 4 },
    }),
  }),
  // Security replaces the Supervisor signing key after the password and a code, and Team pins the new key (ADR-0051).
  'supervisor-key': () => ({
    session: authenticatedLocalSession({
      authentication_method: 'totp',
      passkey_enrollment_available: false,
      passkey_registered: false,
    }),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    security: securityStart(),
  }),
  // The same replacement while Team cannot be reached: the new key is kept and Admin keeps asking Team.
  'supervisor-key-pending': () => ({
    session: authenticatedLocalSession({
      authentication_method: 'totp',
      passkey_enrollment_available: false,
      passkey_registered: false,
    }),
    teams: [...TEAMS],
    routines: [],
    runs: [],
    security: securityStart({ keyRotation: 'pending' }),
  }),
  // First setup: the password, the authenticator, then the recovery codes shown once (ADR-0051).
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
function beginRoutineDeletion(_state, { body }) {
  if (typeof body?.password !== 'string' || !body.password) return { status: 400, json: { detail: 'invalid' } };
  if (body.password === 'wrong password') return { status: 401, json: { code: 'password-incorrect' } };
  return { status: 202, json: { methods: ['totp'] } };
}

function deleteRoutine(state, { routine_id: routineId, body }) {
  if (body?.code === '000000') return { status: 401, json: { code: 'code-incorrect' } };
  if (!/^[0-9]{6}$/.test(body?.code ?? '')) return { status: 401, json: { code: 'authentication-expired' } };
  // Deleting a Routine sets each of its held runs aside, as Team does.
  for (const held of (state.incidents ?? []).filter((item) => item.routine_id === routineId)) {
    setAside(state, held.incident_id, 'delete');
  }
  // Its last notice names it and closes its timeline.
  const deleted = state.routines.find((item) => item.routine_id === routineId);
  if (deleted) recordDeletion(state, deleted);
  state.routines = state.routines.filter((item) => item.routine_id !== routineId);
  state.runs = state.runs.filter((run) => run.routine_id !== routineId);
  return ok({ team_id: 'marketing', routine_id: routineId, deleted: true });
}

// Pause and Resume turn a Routine's dispatch off and on again.
function pauseRoutine(paused) {
  return (state, { routine_id: routineId }) => {
    state.routines = state.routines.map((item) => (
      item.routine_id === routineId ? { ...item, state: paused ? 'paused' : 'active' } : item
    ));
    return ok({ team_id: 'marketing', routine_id: routineId, paused });
  };
}

// Marketing's Routine operations over the session socket (ADR-0114); every other listed Team has no Routine.
const MARKETING_ROUTINE_METHODS = Object.freeze({
  ...ROUTINE_RECOVERY_METHODS,
  ...ROUTINE_STEP_METHODS,
  ...ROUTINE_PROPOSAL_METHODS,
  'routines.deletion': beginRoutineDeletion,
  'routines.delete': deleteRoutine,
  'routines.pause': pauseRoutine(true),
  'routines.resume': pauseRoutine(false),
});

// `routines.list`: Marketing's Routines, runs, and held incidents; every other listed Team has none.
function routinesList(state, teamId) {
  return teamId === 'marketing'
    ? ok({ team_id: 'marketing', routines: state.routines, runs: state.runs, incidents: state.incidents ?? [] })
    : ok({ team_id: teamId, routines: [], runs: [], incidents: [] });
}

// `teams.rename`: a listed Team takes a bounded name.
function renameTeam(state, { team_id: teamId, body }) {
  const name = typeof body?.team_name === 'string' ? body.team_name.trim() : '';
  if (!name || name.length > 80) return { status: 400, json: { detail: 'Enter a valid Team name.' } };
  state.teams = state.teams.map((team) => (team.team_id === teamId ? { ...team, team_name: name } : team));
  return ok({ team_id: teamId, team_name: name });
}

// `teams.reorder`: exactly `{ team_ids }`, an exact permutation of the current Team ids. A malformed body is 400;
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
    help: locale === 'pt'
      ? 'Uma chave que permite a este Assistente pesquisar na internet com a Exa. Entre no painel da Exa, crie uma nova chave de API e copie-a.'
      : 'A key that lets this Assistant search the web with Exa. Sign in to the Exa dashboard, create a new API key, and copy it.',
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

// An approval card's input rows: escaped canonical JSON text per argument, in name order (ADR-0115).
const APPROVAL_INPUT = Object.freeze({
  fields: [
    { name: 'comment', value: '"<b>Set by Shimpz</b>"', truncated: false },
    { name: 'content', value: `"v=spf1 include:_spf.example.com \\u202e ${'x'.repeat(340)}`, truncated: true },
    ...Array.from({ length: 13 }, (_, index) => ({
      name: `label_${String(index).padStart(2, '0')}`,
      value: `"team-${index}"`,
      truncated: false,
    })),
    { name: 'ttl', value: '300', truncated: false },
  ],
  omitted: 3,
});
const INPUT_REQUEST = Object.freeze({
  kind: 'approval',
  ordinal: 0,
  title: 'Create the SPF record?',
  description: 'Cloudflare will add one TXT record to example.com.',
  fingerprint: 'a'.repeat(64),
});

function inputApprovalChallenge(locale) {
  return {
    type: 'human-required',
    challenge_id: 'f'.repeat(32),
    expires_in: 180,
    assistant: { id: 'shimpz-cloudflare', name: 'Cloudflare', version: '0.4.4' },
    action: { id: 'create-dns-record', summary: 'Create one DNS record.' },
    ...localizedChallenge(INPUT_REQUEST, { locale }),
    input: structuredClone(APPROVAL_INPUT),
  };
}

const HUMAN_CHALLENGES = Object.freeze({
  approval: approvalChallenge,
  confirm: confirmChallenge,
  file: fileApprovalChallenge,
  'stored-input': storedInputChallenge,
  input: inputApprovalChallenge,
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

// The progress frames of a receipt scenario's turn: Admin prepares the request, Team gathers its context, calls its
// model, runs one Action, and calls its model again, then Admin validates the reply.
const ZONES_ACTION = Object.freeze({ assistant_id: 'shimpz-cloudflare', action: 'list-zones', index: 1, total: 1 });
const RECEIPT_STEPS = Object.freeze([
  { origin: 'admin', phase: 'admin-preparation', state: 'started' },
  { origin: 'admin', phase: 'admin-preparation', state: 'finished', elapsed_ms: 20 },
  { origin: 'team', phase: 'team-context', state: 'started' },
  { origin: 'team', phase: 'team-context', state: 'finished', elapsed_ms: 9 },
  { origin: 'team', phase: 'model', state: 'started' },
  { origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 1240 },
  { origin: 'team', phase: 'action', state: 'started', ...ZONES_ACTION },
  { origin: 'team', phase: 'action', state: 'finished', elapsed_ms: 70, ...ZONES_ACTION },
  { origin: 'team', phase: 'model', state: 'started' },
  { origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 800 },
  { origin: 'admin', phase: 'reply-validation', state: 'started' },
  { origin: 'admin', phase: 'reply-validation', state: 'finished', elapsed_ms: 5 },
]);

// One receipt turn's frames, its reply last; its rows join the history as Admin writes them: the reply keeps the Team
// steps the browser received, each with the delivery it came in, and Admin's own steps stay out (ADR-0082).
function receiptTurn(state, frame) {
  const progress = RECEIPT_STEPS.map((step, index) => ({ type: 'progress', seq: index + 1, ...step }));
  const reply = structuredClone(chatReply(state, frame));
  state.sequence += 1;
  const turn = `${'c'.repeat(24)}${state.sequence.toString(16).padStart(8, '0')}`;
  const at = '2026-10-03T12:00:00Z';
  const receipt = progress
    .filter((event) => event.origin === 'team')
    .map(({ type: _type, ...event }) => ({ segment: 0, ...event }));
  state.history = [
    ...state.history,
    { id: `${turn}:user`, created_at: at, kind: 'message', role: 'user', text: frame.message },
    {
      id: `${turn}:reply`,
      created_at: at,
      kind: 'message',
      role: 'assistant',
      text: reply.reply,
      author: reply.team_name,
      usage: structuredClone(reply.usage),
      receipt,
    },
  ];
  return [...progress, reply];
}

/**
 * The rows of a Team's history in the view Admin reads: the chat's view holds, of the Routine notices, only each
 * Routine's creation; a Routine's own view (`routine`, its id) holds only its runs, healthy rollups, missed runs, and
 * the pauses its failure streaks caused.
 */
export function historyView(entries, routine = null) {
  return entries.filter((entry) => (routine === null
    ? entry.kind !== 'routine-run' || entry.outcome === 'created'
    : entry.kind === 'routine-run' && entry.routine_id === routine &&
      (entry.run_id !== null || ['healthy', 'skipped', 'streak-paused'].includes(entry.outcome))));
}

// Marketing's installed Assistants as Team lists them: the catalog scenario's bindings, or the chat's Cloudflare and,
// for a Stored Input request, the Exa Assistant that request names (Admin refuses one the inventory does not list).
function marketingInventory(state) {
  if (state.catalog) return catalogInventory();
  return [
    { assistant: 'shimpz-cloudflare', assistant_version: '0.4.1', status: 'running', provenance: 'published' },
    ...(state.human === 'stored-input'
      ? [{ assistant: 'shimpz-exa', assistant_version: '0.1.1', status: 'running', provenance: 'published' }]
      : []),
  ];
}

// Every operation Admin serves over the session socket (ADR-0114), answered from the scenario's own state by method
// and params. A Team-scoped operation answers only for a listed Team; one the scenario does not declare is unanswered.
const SPACE_METHODS = Object.freeze({
  'teams.list': (state) => ok({ teams: state.teams }),
  'teams.reorder': (state, params) => reorderTeams(state, params.body),
  'security.summary': (state) => securitySummary(state),
  ...SECURITY_METHODS,
  'assistants.registry': () => ok({ assistants: ASSISTANTS }),
  'models.list': () => ok({ providers: providers() }),
  'decision.read': () => ok({ provider: 'typesafe', configured: false, masked: null }),
  // The catalog scenario stages four Assistants and finds no public ones in any interface language.
  'store.catalog': (state, params) => (state.catalog
    ? ok({ version: 1, locale: params.locale, assistants: [], next: null })
    : null),
  'snapshots.list': (state) => (state.catalog ? ok({ assistants: catalogSnapshots(), trace_id: 'c'.repeat(32) }) : null),
  'snapshots.summary': (state, params) => snapshotAnswer(state, params, 'summary'),
  'snapshots.details': (state, params) => snapshotAnswer(state, params, 'details'),
});

function snapshotAnswer(state, params, kind) {
  const answer = state.catalog ? catalogImageAnswer(params.image_id, kind, params.locale) : null;
  return answer ? ok(answer) : null;
}

const TEAM_METHODS = Object.freeze({
  'teams.rename': renameTeam,
  'history.page': (state, params) => ok({
    entries: params.team_id === 'marketing' ? historyView(state.history, params.routine ?? null) : [],
    before: null,
  }),
  'routines.list': (state, params) => routinesList(state, params.team_id),
  'inference.read': (_state, params) => ok({ team_id: params.team_id, provider: 'openai', model: 'gpt-6.1-sol' }),
  'inference.save': (_state, params) => ok({ team_id: params.team_id, ...params.body }),
  'assistants.list': (state, params) => ok({ assistants: params.team_id === 'marketing' ? marketingInventory(state) : [] }),
  'assistants.details': (state, params) => {
    const answer = state.catalog && params.team_id === 'marketing'
      ? catalogBindingAnswer(params.assistant_id, params.locale)
      : null;
    return answer ? ok(answer) : null;
  },
  'integrations.list': () => ok({ integrations: [] }),
  'stored_inputs.list': () => ok({ stored_inputs: [] }),
});

/**
 * A fresh scenario; `respond` returns `{ status, json }` or null for an HTTP request this scenario does not answer, and
 * `call` the same for a session socket call by its method and params.
 */
export function createScenario(name = 'ready', locale = 'en') {
  const start = STARTS[name];
  if (!start) throw new Error(`unknown scenario: ${name}`);
  // A scenario's own texts, such as a Routine's name and request, are written in the interface language it starts in.
  const state = { history: [], sequence: 0, locale, security: securityStart(), ...structuredClone(start(locale)) };
  const scenario = {
    name,
    // One session socket call, or null when the scenario does not answer it.
    call(method, params = {}) {
      if (!state.session.authenticated) return null;
      if (Object.hasOwn(SPACE_METHODS, method)) return SPACE_METHODS[method](state, params);
      const listed = state.teams.some((team) => team.team_id === params.team_id);
      if (listed && params.team_id === 'marketing' && Object.hasOwn(MARKETING_ROUTINE_METHODS, method)) {
        return MARKETING_ROUTINE_METHODS[method](state, params);
      }
      return listed && Object.hasOwn(TEAM_METHODS, method) ? TEAM_METHODS[method](state, params) : null;
    },
    // Whether the chat channel of this Team can attach: the preview answers every listed Team's chat.
    attachable(teamId) {
      return state.session.authenticated && state.teams.some((team) => team.team_id === teamId);
    },
    // One HTTP request Admin still serves (the session and sign-in family and file uploads), or null.
    respond({ method = 'GET', path, body = null }) {
      if (path === '/api/session' && method === 'POST') return ok(state.session);
      const security = securityRoutes(state, method, path, body);
      if (security) return security;
      if (!state.session.authenticated || !state.teams.length) return null;
      if (path === '/api/teams/marketing/files' && method === 'POST') return uploadFile(state, body);
      return null;
    },
    // The chat channel: `message` returns the v7 frames to send back, in order.
    chat: {
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
                input: 'Done — the DNS record was created.',
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
        if (frame?.type === 'chat' && state.receipt) return receiptTurn(state, frame);
        if (frame?.type === 'chat') return [structuredClone(chatReply(state, frame))];
        return [];
      },
    },
  };
  return scenario;
}
