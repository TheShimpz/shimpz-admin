// Admin API scenarios shared by the browser tests and the preview (ADR-0087). A scenario is a pure factory: each call
// returns fresh state, answers only the requests it declares, and returns null for anything else so the caller fails
// closed. Nothing here reaches a real Admin, Team, Brain, or provider.
import modelCatalog from '../src/lib/modelCatalog.json' with { type: 'json' };

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

function chatReply(state, frame) {
  const message = typeof frame.message === 'string' ? frame.message : '';
  const recurring = /\b(every|daily|weekly|toda|todo|cada)\b/iu.test(message);
  return {
    type: 'done',
    team_id: 'marketing',
    team_name: 'Marketing',
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
      if (!state.teams.length || !path.startsWith('/api/teams/marketing/')) return null;
      if (path === '/api/teams/marketing/assistants' && method === 'GET') {
        return ok({
          assistants: [
            { assistant: 'shimpz-cloudflare', assistant_version: '0.4.1', status: 'running', provenance: 'published' },
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
        if (frame?.type === 'chat') return [structuredClone(chatReply(state, frame))];
        return [];
      },
    },
  };
}
