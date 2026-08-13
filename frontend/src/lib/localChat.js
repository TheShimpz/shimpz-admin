import { LocalApiError, safeApiError } from './localApi.js';
import {
  ASSISTANT_ID_RE,
  CONTROL_RE,
  exactKeys,
  jsonObject,
  OPAQUE_ID_RE,
  TEAM_ID_RE,
} from './validate.js';

const CHAT_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SECRET_CONTROL_RE = /\p{C}/u;
const SEMANTIC_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_FILES = 8;
const MAX_ASSISTANTS = 16;
const MAX_INTEGRATIONS = 512;
const MAX_INTEGRATION_REQUIREMENTS = 64;
const MAX_INTEGRATION_SCOPES = 32;
const MAX_INTEGRATION_ACTIONS = 128;
const MAX_HUMAN_OPTIONS = 32;
const MAX_HUMAN_REQUESTS_PER_ACTION = 8;
const MAX_HUMAN_RESPONSE_CHARS = 16_000;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_REPLY_CHARS = 60_000;
const MAX_ERROR_DETAIL_CHARS = 800;
export const CHAT_PROGRESS_PHASES = Object.freeze([
  'admin-preparation',
  'reply-validation',
  'team-context',
  'model',
  'action-preparation',
  'action',
  'action-delivery',
]);
const CHAT_PROGRESS_PHASE_SET = new Set(CHAT_PROGRESS_PHASES);
const ADMIN_PROGRESS_PHASES = new Set(['admin-preparation', 'reply-validation']);
const CHAT_PROGRESS_STATES = new Set(['started', 'finished']);
const MAX_CHAT_PROGRESS_EVENTS = 2052;
const MAX_CHAT_PROGRESS_ELAPSED_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_ASSISTANT_ID_CHARS = 40;
const MAX_PROGRESS_ACTION_ID_CHARS = 80;
const OAUTH_CHAT_STORAGE_KEY = 'shimpz:oauth-chat:v1';
const OAUTH_CHAT_STORAGE_TTL_MS = 10 * 60 * 1000;
const MAX_OAUTH_CHAT_TURNS = 64;
const MAX_OAUTH_CHAT_STORAGE_BYTES = 256 * 1024;
const CLOUDFLARE_SCOPES = new Set(['dns.read', 'dns.write', 'offline_access', 'zone.read']);
const OAUTH_SCOPE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const CHAT_WS_PROTOCOL = 'shimpz.chat.v4';
export const HUMAN_REQUEST_KINDS = Object.freeze([
  'approval',
  'input:text',
  'input:textarea',
  'input:password',
  'input:phone',
  'input:select',
  'input:choice',
  'input:choices',
  'auth:reauth',
  'auth:second-factor',
  'auth:phishing-resistant',
]);
const HUMAN_AUTH_KINDS = new Set(HUMAN_REQUEST_KINDS.filter((kind) => kind.startsWith('auth:')));
const HUMAN_LENGTH_LIMITS = new Map([
  ['input:text', 4096],
  ['input:textarea', 16_000],
  ['input:password', 1024],
  ['input:phone', 64],
]);
const HUMAN_SINGLE_CHOICE_KINDS = new Set(['input:select', 'input:choice']);

export function assistantIntegrationProviderLabel(provider) {
  if (typeof provider !== 'string' || !ASSISTANT_ID_RE.test(provider)) return '';
  if (provider === 'x') return 'X';
  return provider.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function oauthChatTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    value.role === 'user' &&
    exactKeys(value, ['role', 'text']) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_MESSAGE_CHARS &&
    !CHAT_TEXT_CONTROL_RE.test(value.text)
  ) {
    return { role: 'user', text: value.text };
  }
  if (
    value.role === 'assistant' &&
    exactKeys(value, ['role', 'text', 'author']) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_REPLY_CHARS &&
    !CHAT_TEXT_CONTROL_RE.test(value.text)
  ) {
    try {
      return { role: 'assistant', text: value.text, author: canonicalTeam(value.author) };
    } catch {
      return null;
    }
  }
  return null;
}

export function stashOAuthChatTurns(storage, teamId, turns, now = Date.now()) {
  try {
    requireTeam(teamId);
    if (
      !storage ||
      typeof storage.setItem !== 'function' ||
      !Array.isArray(turns) ||
      turns.length > MAX_OAUTH_CHAT_TURNS ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) return false;
    const canonical = turns.map(oauthChatTurn);
    if (canonical.some((turn) => turn === null)) return false;
    const encoded = JSON.stringify({
      version: 1,
      team_id: teamId,
      expires_at: now + OAUTH_CHAT_STORAGE_TTL_MS,
      turns: canonical,
    });
    if (new TextEncoder().encode(encoded).length > MAX_OAUTH_CHAT_STORAGE_BYTES) return false;
    storage.setItem(OAUTH_CHAT_STORAGE_KEY, encoded);
    return true;
  } catch {
    return false;
  }
}

export function restoreOAuthChatTurns(storage, teamId, now = Date.now()) {
  try {
    requireTeam(teamId);
    if (
      !storage ||
      typeof storage.getItem !== 'function' ||
      typeof storage.removeItem !== 'function' ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) return [];
    const raw = storage.getItem(OAUTH_CHAT_STORAGE_KEY);
    if (raw === null) return [];
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, ['version', 'team_id', 'expires_at', 'turns'])
    ) {
      storage.removeItem(OAUTH_CHAT_STORAGE_KEY);
      return [];
    }
    if (value.team_id !== teamId) return [];
    storage.removeItem(OAUTH_CHAT_STORAGE_KEY);
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.expires_at) ||
      value.expires_at <= now ||
      value.expires_at > now + OAUTH_CHAT_STORAGE_TTL_MS ||
      !Array.isArray(value.turns) ||
      value.turns.length > MAX_OAUTH_CHAT_TURNS
    ) return [];
    const canonical = value.turns.map(oauthChatTurn);
    return canonical.some((turn) => turn === null) ? [] : canonical;
  } catch {
    return [];
  }
}

function requireTeam(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local chat request.');
  }
}

function canonicalTeam(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > MAX_TEAM_NAME_CHARS ||
    SECRET_CONTROL_RE.test(value)
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return value;
}

function canonicalId(value, message = 'The local chat response is invalid.') {
  if (typeof value !== 'string' || value.length > 80 || !ASSISTANT_ID_RE.test(value)) {
    throw new LocalApiError(message);
  }
  return value;
}

function canonicalPublicText(value, maximum) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    SECRET_CONTROL_RE.test(value)
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return value;
}

function canonicalSemanticVersion(value) {
  if (typeof value !== 'string' || !SEMANTIC_VERSION_RE.test(value)) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return value;
}

function canonicalIds(values, maximum) {
  if (!Array.isArray(values) || !values.length || values.length > maximum) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const canonical = values.map((value) => canonicalId(value));
  if (new Set(canonical).size !== canonical.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return canonical;
}

function canonicalOptionalPublicText(value, maximum) {
  return value === null ? null : canonicalPublicText(value, maximum);
}

function canonicalIntegrationScopes(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_INTEGRATION_SCOPES) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const scopes = values.map((value) => canonicalPublicText(value, 128));
  if (new Set(scopes).size !== scopes.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return scopes;
}

function trustedCloudflareScopes(value) {
  if (typeof value !== 'string') return false;
  const scopes = value.split(' ');
  return (
    scopes.length >= 1 &&
    scopes.length <= CLOUDFLARE_SCOPES.size &&
    scopes.every((scope) => OAUTH_SCOPE_RE.test(scope) && CLOUDFLARE_SCOPES.has(scope)) &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope, index) => index === 0 || scopes[index - 1] < scope)
  );
}

function canonicalIntegrationAction(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['id', 'name', 'summary'])
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return {
    id: canonicalId(value.id),
    name: canonicalPublicText(value.name, 80),
    summary: canonicalPublicText(value.summary, 160),
  };
}

function canonicalIntegrationActions(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_INTEGRATION_ACTIONS) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const actions = values.map(canonicalIntegrationAction);
  if (new Set(actions.map((action) => action.id)).size !== actions.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return actions;
}

function canonicalIntegrationRequirement(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'integration_id',
      'provider',
      'name',
      'summary',
      'scopes',
      'actions',
    ])
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return {
    assistant_id: canonicalId(value.assistant_id),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    integration_id: canonicalId(value.integration_id),
    provider: canonicalId(value.provider),
    name: canonicalPublicText(value.name, 80),
    summary: canonicalPublicText(value.summary, 160),
    scopes: canonicalIntegrationScopes(value.scopes),
    actions: canonicalIntegrationActions(value.actions),
  };
}

function canonicalHumanOption(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['value', 'label', 'description'])
  ) throw new LocalApiError('The local chat response is invalid.');
  return {
    value: canonicalPublicText(value.value, 128),
    label: canonicalPublicText(value.label, 80),
    description: canonicalOptionalPublicText(value.description, 160),
  };
}

function canonicalHumanOptions(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > MAX_HUMAN_OPTIONS) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const options = values.map(canonicalHumanOption);
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return options;
}

function canonicalHumanRequestBase(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !HUMAN_REQUEST_KINDS.includes(value.kind) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 0 ||
    value.ordinal >= MAX_HUMAN_REQUESTS_PER_ACTION ||
    typeof value.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.fingerprint)
  ) throw new LocalApiError('The local chat response is invalid.');
  return {
    kind: value.kind,
    ordinal: value.ordinal,
    title: canonicalPublicText(value.title, 80),
    description: canonicalPublicText(value.description, 500),
    fingerprint: value.fingerprint,
  };
}

function canonicalHumanInputBase(value, base) {
  if (typeof value.required !== 'boolean') {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return { ...base, label: canonicalPublicText(value.label, 80), required: value.required };
}

function canonicalHumanRequest(value) {
  const base = canonicalHumanRequestBase(value);
  const baseKeys = ['kind', 'ordinal', 'title', 'description', 'fingerprint'];
  if (base.kind === 'approval' || HUMAN_AUTH_KINDS.has(base.kind)) {
    if (!exactKeys(value, baseKeys)) throw new LocalApiError('The local chat response is invalid.');
    return base;
  }
  const input = canonicalHumanInputBase(value, base);
  if (HUMAN_LENGTH_LIMITS.has(base.kind)) {
    const limit = HUMAN_LENGTH_LIMITS.get(base.kind);
    if (
      !exactKeys(value, [...baseKeys, 'label', 'required', 'placeholder', 'min_length', 'max_length']) ||
      (value.placeholder !== null && typeof value.placeholder !== 'string') ||
      (typeof value.placeholder === 'string' && canonicalPublicText(value.placeholder, 120) !== value.placeholder) ||
      !Number.isSafeInteger(value.min_length) ||
      !Number.isSafeInteger(value.max_length) ||
      value.min_length < 0 ||
      value.max_length < value.min_length ||
      value.max_length > limit
    ) throw new LocalApiError('The local chat response is invalid.');
    return {
      ...input,
      placeholder: value.placeholder,
      min_length: value.min_length,
      max_length: value.max_length,
    };
  }
  if (HUMAN_SINGLE_CHOICE_KINDS.has(base.kind)) {
    if (!exactKeys(value, [...baseKeys, 'label', 'required', 'options'])) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return { ...input, options: canonicalHumanOptions(value.options) };
  }
  if (
    !exactKeys(value, [...baseKeys, 'label', 'required', 'options', 'min_selections', 'max_selections']) ||
    !Number.isSafeInteger(value.min_selections) ||
    !Number.isSafeInteger(value.max_selections)
  ) throw new LocalApiError('The local chat response is invalid.');
  const options = canonicalHumanOptions(value.options);
  if (
    value.min_selections < 0 ||
    value.max_selections < value.min_selections ||
    value.max_selections > options.length
  ) throw new LocalApiError('The local chat response is invalid.');
  return {
    ...input,
    options,
    min_selections: value.min_selections,
    max_selections: value.max_selections,
  };
}

function canonicalHumanIdentity(value, expectedKeys, maximum) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, expectedKeys)) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return Object.fromEntries(expectedKeys.map((key) => [
    key,
    key === 'id' ? canonicalId(value[key]) : canonicalPublicText(value[key], maximum),
  ]));
}

function canonicalIntegrationIntegration(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['id', 'name', 'username'])
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return {
    id: canonicalPublicText(value.id, 160),
    name: canonicalOptionalPublicText(value.name, 160),
    username: canonicalOptionalPublicText(value.username, 160),
  };
}

function canonicalIntegrationExpiry(value) {
  if (value === null) return null;
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/)
    : null;
  if (
    !match ||
    value.length > 40 ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const [, year, month, day, hour, minute, second, , offsetHour = '00', offsetMinute = '00'] = match;
  const maximumDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > maximumDay ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour) > 23 ||
    Number(offsetMinute) > 59
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return value;
}

function canonicalIntegrationInventoryItem(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'assistant_version',
      'assistant_summary',
      'id',
      'provider',
      'name',
      'summary',
      'scopes',
      'status',
      'integration',
      'expires_at',
    ]) ||
    !['missing', 'connected', 'expired', 'reauthorization-required'].includes(value.status)
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const integration = canonicalIntegrationIntegration(value.integration);
  return {
    assistant_id: canonicalId(value.assistant_id, 'The Assistant integration inventory is invalid.'),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    assistant_version: canonicalSemanticVersion(value.assistant_version),
    assistant_summary: canonicalPublicText(value.assistant_summary, 160),
    id: canonicalId(value.id, 'The Assistant integration inventory is invalid.'),
    provider: canonicalId(value.provider, 'The Assistant integration inventory is invalid.'),
    name: canonicalPublicText(value.name, 80),
    summary: canonicalPublicText(value.summary, 160),
    scopes: canonicalIntegrationScopes(value.scopes),
    status: value.status,
    integration,
    expires_at: canonicalIntegrationExpiry(value.expires_at),
  };
}

function trustedAuthorizationUrl(value, completionMode) {
  if (typeof value !== 'string' || value.length > 4096 || CONTROL_RE.test(value)) {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  const browserOrigin = globalThis.location?.origin;
  const localHandoff = (
    typeof browserOrigin === 'string' &&
    url.origin === browserOrigin &&
    url.pathname === '/api/oauth/cloudflare/start' &&
    [...url.searchParams.keys()].length === 1 &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get('handoff') ?? '')
  );
  const outOfBand = (
    url.protocol === 'https:' &&
    url.hostname === 'shimpz.com' &&
    !url.port &&
    url.pathname === '/api/oauth/cloudflare/start' &&
    [...url.searchParams.keys()].length === 4 &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') &&
    trustedCloudflareScopes(url.searchParams.get('scope')) &&
    url.searchParams.get('callback') === 'out-of-band'
  );
  const trusted = (
    (completionMode === 'automatic' && localHandoff) ||
    (completionMode === 'code' && outOfBand)
  );
  if (url.username || url.password || url.hash || !trusted) {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  return url.href;
}

export function oauthReturnFailure(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const pairs = [...url.searchParams.entries()];
  return (
    url.pathname === '/chat' &&
    !url.hash &&
    pairs.length === 1 &&
    pairs[0][0] === 'oauth' &&
    ['start-failed', 'callback-failed'].includes(pairs[0][1])
  );
}

export async function listTeamFiles(fetcher, teamId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid local file request.');
  requireTeam(teamId);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/files`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, 'Team files are unavailable.'), response.status);
  if (!Array.isArray(body.files) || body.files.length > 256) {
    throw new LocalApiError('Team file inventory is invalid.', response.status);
  }
  return body.files.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      !OPAQUE_ID_RE.test(file.id) ||
      typeof file.name !== 'string' ||
      !file.name ||
      file.name.length > 255 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1
    ) {
      throw new LocalApiError('Team file inventory is invalid.', response.status);
    }
    return { id: file.id, name: file.name, size: file.size };
  });
}

/** Build the only chat frame accepted by shimpz.chat.v4. Provider/model/keys remain server-owned. */
export function createChatFrame(teamId, turn) {
  requireTeam(teamId);
  if (
    !turn ||
    typeof turn !== 'object' ||
    Object.keys(turn).sort().join(',') !== 'assistant_ids,files,message'
  ) {
    throw new LocalApiError('Chat accepts only message, files, and assistant_ids.');
  }
  const message = typeof turn.message === 'string' ? turn.message.trim() : '';
  if (
    !message ||
    message.length > MAX_MESSAGE_CHARS ||
    !Array.isArray(turn.files) ||
    turn.files.length > MAX_FILES ||
    turn.files.some((fileId) => !OPAQUE_ID_RE.test(fileId)) ||
    new Set(turn.files).size !== turn.files.length ||
    !Array.isArray(turn.assistant_ids) ||
    turn.assistant_ids.length > MAX_ASSISTANTS ||
    turn.assistant_ids.some((assistantId) => (
      typeof assistantId !== 'string' ||
      assistantId.length > 80 ||
      !ASSISTANT_ID_RE.test(assistantId)
    )) ||
    new Set(turn.assistant_ids).size !== turn.assistant_ids.length
  ) {
    throw new LocalApiError('Invalid local chat request.');
  }
  return {
    type: 'chat',
    message,
    files: [...turn.files],
    assistant_ids: [...turn.assistant_ids],
  };
}

export function createStopFrame(teamId) {
  requireTeam(teamId);
  return { type: 'stop' };
}

export function createSyncFrame(teamId) {
  requireTeam(teamId);
  return { type: 'sync' };
}

function canonicalHumanResponseValue(value) {
  if (value === true) return true;
  if (typeof value === 'string' && value.length <= MAX_HUMAN_RESPONSE_CHARS) return value;
  if (
    Array.isArray(value) &&
    value.length <= MAX_HUMAN_OPTIONS &&
    value.every((item) => typeof item === 'string' && item.length <= 128) &&
    new Set(value).size === value.length
  ) return [...value];
  throw new LocalApiError('Invalid human response.');
}

export function createHumanResponseFrame(teamId, challengeId, decision, value) {
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid human response.');
  }
  if (decision === 'deny' && value === undefined) {
    return { type: 'human-response', challenge_id: challengeId, decision: 'deny' };
  }
  if (decision !== 'submit') throw new LocalApiError('Invalid human response.');
  return {
    type: 'human-response',
    challenge_id: challengeId,
    decision: 'submit',
    value: canonicalHumanResponseValue(value),
  };
}

export async function listAssistantIntegrations(fetcher, teamId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant integration request.');
  requireTeam(teamId);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/assistant-integrations`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant integrations are unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['integrations']) ||
    !Array.isArray(body.integrations) ||
    body.integrations.length > MAX_INTEGRATIONS
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  let integrations;
  try {
    integrations = body.integrations.map(canonicalIntegrationInventoryItem);
  } catch {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  const identities = integrations.map((integration) => `${integration.assistant_id}\u0000${integration.id}`);
  if (new Set(identities).size !== identities.length) {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  const assistantMetadata = new Map();
  for (const integration of integrations) {
    const current = assistantMetadata.get(integration.assistant_id);
    const metadata = [integration.assistant_name, integration.assistant_version, integration.assistant_summary];
    if (current && current.some((value, index) => value !== metadata[index])) {
      throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
    }
    assistantMetadata.set(integration.assistant_id, metadata);
  }
  return { integrations };
}

export async function authorizeAssistantIntegration(fetcher, teamId, challengeId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant authorization request.');
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistant-integrations/challenges/${challengeId}/authorize`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not start.'), response.status);
  }
  if (
    !exactKeys(body, ['authorization_url', 'completion_mode']) ||
    !['automatic', 'code'].includes(body.completion_mode)
  ) {
    throw new LocalApiError('The Assistant authorization response is invalid.', response.status);
  }
  return {
    authorization_url: trustedAuthorizationUrl(body.authorization_url, body.completion_mode),
    completion_mode: body.completion_mode,
  };
}

export async function completeAssistantIntegration(fetcher, teamId, challengeId, completionCode) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant authorization request.');
  requireTeam(teamId);
  if (
    typeof challengeId !== 'string' ||
    !OPAQUE_ID_RE.test(challengeId) ||
    typeof completionCode !== 'string' ||
    !/^c1\.[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/.test(completionCode)
  ) {
    throw new LocalApiError('Invalid Assistant completion code.');
  }
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistant-integrations/challenges/${challengeId}/complete`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ completion_code: completionCode }),
    },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not finish.'), response.status);
  }
  if (
    !exactKeys(body, ['connected', 'team_id', 'assistant_id', 'integration_id']) ||
    body.connected !== true ||
    body.team_id !== teamId
  ) {
    throw new LocalApiError('The Assistant completion response is invalid.', response.status);
  }
  return {
    connected: true,
    team_id: teamId,
    assistant_id: canonicalId(body.assistant_id, 'The Assistant completion response is invalid.'),
    integration_id: canonicalId(body.integration_id, 'The Assistant completion response is invalid.'),
  };
}

export async function cancelAssistantIntegrationAuthorization(fetcher, teamId, challengeId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant authorization request.');
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistant-integrations/challenges/${challengeId}/authorize`,
    {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  if (!response.ok) {
    const body = await jsonObject(response);
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not be cancelled.'), response.status);
  }
  if (response.status !== 204) {
    throw new LocalApiError('The Assistant cancellation response is invalid.', response.status);
  }
}

export function chatSocketUrl(locationValue, teamId) {
  requireTeam(teamId);
  if (!locationValue || typeof locationValue.host !== 'string') {
    throw new LocalApiError('Invalid local chat request.');
  }
  const scheme = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${locationValue.host}/api/teams/${teamId}/chat/ws`;
}

/** Parse one public chat frame. Raw provider events and extra fields fail closed. */
export function parseChatEvent(value, expectedTeamId, expectedTeamName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  if (value.type === 'done') {
    if (
      !exactKeys(value, ['type', 'team_id', 'team_name', 'reply']) ||
      !TEAM_ID_RE.test(value.team_id) ||
      value.team_id !== expectedTeamId ||
      canonicalTeam(value.team_name) !== canonicalTeam(expectedTeamName) ||
      typeof value.reply !== 'string' ||
      !value.reply.trim() ||
      value.reply.length > MAX_REPLY_CHARS ||
      CHAT_TEXT_CONTROL_RE.test(value.reply)
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'done',
      team_id: value.team_id,
      team_name: value.team_name,
      reply: value.reply,
    };
  }
  if (value.type === 'error') {
    if (
      !exactKeys(value, ['type', 'status', 'detail']) ||
      !Number.isInteger(value.status) ||
      value.status < 400 ||
      value.status > 599 ||
      typeof value.detail !== 'string' ||
      !value.detail ||
      value.detail !== value.detail.trim() ||
      value.detail.length > MAX_ERROR_DETAIL_CHARS ||
      CONTROL_RE.test(value.detail)
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return { type: 'error', status: value.status, detail: value.detail };
  }
  if (value.type === 'progress') {
    const action = value.phase === 'action';
    const finished = value.state === 'finished';
    const expected = ['type', 'seq', 'origin', 'phase', 'state'];
    if (finished) expected.push('elapsed_ms');
    if (action) expected.push('assistant_id', 'index', 'action', 'total');
    const validAuthority = (
      (value.origin === 'admin' && ADMIN_PROGRESS_PHASES.has(value.phase)) ||
      (value.origin === 'team' && !ADMIN_PROGRESS_PHASES.has(value.phase))
    );
    if (
      !exactKeys(value, expected) ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 1 ||
      value.seq > MAX_CHAT_PROGRESS_EVENTS ||
      !validAuthority ||
      !CHAT_PROGRESS_PHASE_SET.has(value.phase) ||
      !CHAT_PROGRESS_STATES.has(value.state) ||
      (finished && (
        !Number.isSafeInteger(value.elapsed_ms) ||
        value.elapsed_ms < 0 ||
        value.elapsed_ms > MAX_CHAT_PROGRESS_ELAPSED_MS
      )) ||
      (action && (
        typeof value.assistant_id !== 'string' ||
        value.assistant_id.length > MAX_PROGRESS_ASSISTANT_ID_CHARS ||
        !ASSISTANT_ID_RE.test(value.assistant_id) ||
        typeof value.action !== 'string' ||
        value.action.length > MAX_PROGRESS_ACTION_ID_CHARS ||
        !ASSISTANT_ID_RE.test(value.action) ||
        !Number.isSafeInteger(value.index) ||
        !Number.isSafeInteger(value.total) ||
        value.index < 1 ||
        value.total < value.index ||
        value.total > 512
      ))
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const event = {
      type: 'progress',
      seq: value.seq,
      origin: value.origin,
      phase: value.phase,
      state: value.state,
    };
    if (finished) event.elapsed_ms = value.elapsed_ms;
    if (action) {
      event.assistant_id = value.assistant_id;
      event.index = value.index;
      event.action = value.action;
      event.total = value.total;
    }
    return event;
  }
  if (value.type === 'stopped' && exactKeys(value, ['type'])) return { type: 'stopped' };
  if (value.type === 'sync-empty' && exactKeys(value, ['type'])) return { type: 'sync-empty' };
  if (value.type === 'human-response-rejected') {
    const denied = value.reason === 'authentication-denied';
    const locked = value.reason === 'authentication-locked';
    if (
      !exactKeys(value, [
        'type', 'challenge_id', 'reason', 'attempts_remaining', 'retry_after',
      ]) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      (!denied && !locked) ||
      !Number.isSafeInteger(value.attempts_remaining) ||
      !Number.isSafeInteger(value.retry_after) ||
      (denied && (
        value.attempts_remaining < 1 ||
        value.attempts_remaining > 2 ||
        value.retry_after !== 0
      )) ||
      (locked && (
        value.attempts_remaining !== 0 ||
        value.retry_after < 1 ||
        value.retry_after > 60
      ))
    ) throw new LocalApiError('The local chat response is invalid.');
    return {
      type: 'human-response-rejected',
      challenge_id: value.challenge_id,
      reason: value.reason,
      attempts_remaining: value.attempts_remaining,
      retry_after: value.retry_after,
    };
  }
  if (value.type === 'integrations-required') {
    if (
      !exactKeys(value, ['type', 'challenge_id', 'expires_in', 'requirements']) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 1 ||
      value.expires_in > 900 ||
      !Array.isArray(value.requirements) ||
      !value.requirements.length ||
      value.requirements.length > MAX_INTEGRATION_REQUIREMENTS
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const requirements = value.requirements.map(canonicalIntegrationRequirement);
    const identities = requirements.map((requirement) => (
      `${requirement.assistant_id}\u0000${requirement.integration_id}`
    ));
    if (new Set(identities).size !== identities.length) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'integrations-required',
      challenge_id: value.challenge_id,
      expires_in: value.expires_in,
      requirements,
    };
  }
  if (value.type === 'human-required') {
    if (
      !exactKeys(value, ['type', 'challenge_id', 'expires_in', 'assistant', 'action', 'request']) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 1 ||
      value.expires_in > 300
    ) throw new LocalApiError('The local chat response is invalid.');
    return {
      type: 'human-required',
      challenge_id: value.challenge_id,
      expires_in: value.expires_in,
      assistant: canonicalHumanIdentity(value.assistant, ['id', 'name', 'version'], 80),
      action: canonicalHumanIdentity(value.action, ['id', 'summary'], 160),
      request: canonicalHumanRequest(value.request),
    };
  }
  throw new LocalApiError('The local chat response is invalid.');
}
