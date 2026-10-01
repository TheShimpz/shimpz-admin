// Admin API scenarios shared by the browser tests and the preview (ADR-0087). A scenario is a pure factory: each call
// returns fresh state, answers only the requests it declares, and returns null for anything else so the caller fails
// closed. Nothing here reaches a real Admin, Team, Brain, or provider.
import modelCatalog from '../src/lib/modelCatalog.json' with { type: 'json' };
import { localizedChallenge } from './localizedRequest.js';

export const TEAM = { team_id: 'marketing', team_name: 'Marketing', status: 'running' };

export const ASSISTANTS = [
  { id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare', summary: 'Safely manage Cloudflare DNS records through OAuth.' },
  { id: 'whatsapp', title: 'WhatsApp', summary: 'Send reviewed WhatsApp messages.' },
];

export const ROUTINE_PROPOSAL = {
  proposal_id: 'c'.repeat(32),
  op: 'propose',
  quote: 'Every day at 9, list my DNS zones',
  schedule: { kind: 'daily', time: '09:00' },
  timezone: null,
  routine_id: null,
  assistant_ids: ['shimpz-cloudflare'],
  expires_in: 900,
};

export const ROUTINE_VIEW = {
  routine_id: 'a'.repeat(32),
  quote: ROUTINE_PROPOSAL.quote,
  schedule: ROUTINE_PROPOSAL.schedule,
  timezone: 'America/Sao_Paulo',
  assistant_ids: ['shimpz-cloudflare'],
  next_run_at: '2026-10-01T12:00:00Z',
  needs_reconfirm: false,
  deleting: false,
};

const WEEKLY_ROUTINE = {
  ...ROUTINE_VIEW,
  routine_id: 'd'.repeat(32),
  quote: 'Every Monday at 8, check my certificates',
  schedule: { kind: 'weekly', weekday: 0, time: '08:00' },
  next_run_at: '2026-10-05T11:00:00Z',
};

const UNCERTAIN_RUN = {
  run_id: 'b'.repeat(32),
  routine_id: ROUTINE_VIEW.routine_id,
  status: 'uncertain',
  scheduled_at: '2026-09-30T12:00:00Z',
  request_kind: null,
  assistant_id: null,
  action: null,
  batch_fingerprint: 'e'.repeat(64),
  actions: [['shimpz-cloudflare', 'replace-dns-record']],
};

const FROZEN_RUN = {
  run_id: 'f'.repeat(32),
  routine_id: WEEKLY_ROUTINE.routine_id,
  status: 'frozen',
  scheduled_at: '2026-09-29T11:00:00Z',
  request_kind: 'human',
  assistant_id: 'shimpz-cloudflare',
  action: 'list-zones',
  batch_fingerprint: null,
  actions: [],
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
const gone = () => ({ status: 404, json: { code: 'routine-proposal-unavailable' } });

function hexId(prefix, sequence) {
  return `${prefix}${sequence.toString(16)}`.padStart(32, '0');
}

// Each scenario names its starting state; `ready` is the Local chat with one Team and no Routines.
const STARTS = {
  ready: () => ({ session: authenticatedLocalSession(), teams: [TEAM], routines: [], runs: [] }),
  routines: () => ({
    session: authenticatedLocalSession(),
    teams: [TEAM],
    routines: [ROUTINE_VIEW, WEEKLY_ROUTINE],
    runs: [UNCERTAIN_RUN, FROZEN_RUN],
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
    human: true,
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

function routineRoutes(state, method, path, body) {
  const base = '/api/teams/marketing/routines';
  if (path === base && method === 'GET') return ok({ team_id: 'marketing', routines: state.routines, runs: state.runs });
  if (path === base && method === 'POST') {
    // A confirmation consumes its proposal once and creates a Routine with its own id.
    const proposal = state.proposals.get(body?.proposal_id);
    if (!proposal) return gone();
    state.proposals.delete(body.proposal_id);
    state.sequence += 1;
    const routine = {
      ...ROUTINE_VIEW,
      routine_id: hexId('9', state.sequence),
      quote: proposal.quote,
      schedule: proposal.schedule,
      timezone: body.timezone ?? 'UTC',
    };
    state.routines = [...state.routines, routine];
    return ok({ team_id: 'marketing', routine });
  }
  const preview = path.match(/^\/api\/teams\/marketing\/routines\/proposals\/([0-9a-f]{32})\/preview$/);
  if (preview && method === 'POST') {
    const proposal = state.proposals.get(preview[1]);
    if (!proposal) return gone();
    return ok({
      ...proposal,
      timezone: body?.timezone ?? 'UTC',
      next_runs: ['2026-10-01T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-03T12:00:00Z'],
      daily_runs: '1',
      max_daily_runs: 24,
      fits: true,
    });
  }
  const routine = path.match(/^\/api\/teams\/marketing\/routines\/([0-9a-f]{32})$/);
  if (routine && method === 'DELETE') {
    state.routines = state.routines.filter((item) => item.routine_id !== routine[1]);
    state.runs = state.runs.filter((run) => run.routine_id !== routine[1]);
    return ok({ team_id: 'marketing', routine_id: routine[1], deleted: true });
  }
  const run = path.match(/^\/api\/teams\/marketing\/routines\/runs\/([0-9a-f]{32})\/(stop|resolve)$/);
  if (run && method === 'POST') {
    state.runs = state.runs.filter((item) => item.run_id !== run[1]);
    return ok({ team_id: 'marketing', run_id: run[1], [run[2] === 'stop' ? 'stopped' : 'resolved']: true });
  }
  return null;
}

function propose(state, message) {
  state.sequence += 1;
  const proposal = { ...ROUTINE_PROPOSAL, proposal_id: hexId('c', state.sequence), quote: message.slice(0, 200) };
  state.proposals.set(proposal.proposal_id, proposal);
  return structuredClone(proposal);
}

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
      routine_proposal: null,
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
    routine_proposal: null,
  };
}

// The human-request scenario pauses an Action for a Stored Input the Team does not hold yet (ADR-0090).
const HUMAN_CHALLENGE = Object.freeze({
  type: 'human-required',
  challenge_id: 'b'.repeat(32),
  expires_in: 180,
  assistant: { id: 'shimpz-exa', name: 'Exa', version: '0.1.1' },
  action: { id: 'search-web', summary: 'Search the web with Exa.' },
  purpose: 'Para trazer as notícias de IA de hoje, preciso pesquisar na web com o Exa.',
  help_url: 'https://dashboard.exa.ai/api-keys',
  ...localizedChallenge({
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
  }),
});

function chatReply(state, frame) {
  const message = typeof frame.message === 'string' ? frame.message : '';
  if (state.clarify) return clarifyReply(state, message);
  const recurring = /\b(every|daily|weekly|toda|todo|cada)\b/iu.test(message);
  return {
    type: 'done',
    team_id: 'marketing',
    team_name: state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name,
    reply: recurring
      ? 'I can run this on a schedule. Confirm it below to schedule it.'
      : `Preview reply to: ${message}`,
    clarification: null,
    routine_proposal: recurring ? propose(state, message) : null,
  };
}

/** A fresh scenario; `respond` returns `{ status, json }` or null for a request this scenario does not answer. */
export function createScenario(name = 'ready') {
  const start = STARTS[name];
  if (!start) throw new Error(`unknown scenario: ${name}`);
  const state = { ...structuredClone(start()), proposals: new Map(), sequence: 0 };
  return {
    name,
    respond({ method = 'GET', path, body = null }) {
      if (path === '/api/session' && method === 'POST') return ok(state.session);
      if (!state.session.authenticated) return null;
      if (path === '/api/teams' && method === 'GET') return ok({ teams: state.teams });
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
      if (!state.teams.length || !path.startsWith('/api/teams/marketing/')) return null;
      if (path === '/api/teams/marketing/assistants' && method === 'GET') {
        return ok({
          assistants: [
            { assistant: 'shimpz-cloudflare', assistant_version: '0.4.1', status: 'running', provenance: 'published' },
            // A human request names an installed Assistant; Admin refuses one the Team inventory does not list.
            ...(state.human
              ? [{ assistant: 'shimpz-exa', assistant_version: '0.1.1', status: 'running', provenance: 'published' }]
              : []),
          ],
        });
      }
      if (path === '/api/teams/marketing/files' && method === 'GET') return ok({ files: [] });
      if (path === '/api/teams/marketing/chat/history' && method === 'GET') return ok({ entries: [], before: null });
      if (path === '/api/teams/marketing/inference' && method === 'GET') {
        return ok({ team_id: 'marketing', provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' });
      }
      if (path === '/api/teams/marketing/inference' && method === 'PUT') return ok({ team_id: 'marketing', ...body });
      if (path === '/api/teams/marketing/assistant-integrations' && method === 'GET') return ok({ integrations: [] });
      if (path === '/api/teams/marketing/assistant-stored-inputs' && method === 'GET') return ok({ stored_inputs: [] });
      return routineRoutes(state, method, path, body);
    },
    // The chat socket: `open` and `message` return the frames to send back, in order.
    chat: {
      path: '/api/teams/marketing/chat/ws',
      message(frame) {
        if (frame?.type === 'sync') return [{ type: 'sync-empty' }];
        if (frame?.type === 'chat' && state.human) return [structuredClone(HUMAN_CHALLENGE)];
        if (frame?.type === 'human-response') {
          return [{
            type: 'done',
            team_id: 'marketing',
            team_name: state.teams.find((team) => team.team_id === 'marketing')?.team_name ?? TEAM.team_name,
            reply: frame.decision === 'deny' ? 'Ok — I stopped that Action.' : 'Done — the search ran with your key.',
            clarification: null,
            routine_proposal: null,
          }];
        }
        if (frame?.type === 'chat') return [structuredClone(chatReply(state, frame))];
        return [];
      },
    },
  };
}
