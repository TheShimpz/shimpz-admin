import { LocalApiError, safeApiError } from './localApi.js';

const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPAQUE_ID_RE = /^[0-9a-f]{32}$/;
const FILE_ID_RE = /^[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SECRET_CONTROL_RE = /\p{C}/u;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_FILES = 8;
const MAX_ASSISTANTS = 16;
const MAX_INSTALLED_ASSISTANTS = 128;
const MAX_POWERS_PER_ASSISTANT = 128;
const MAX_SECRETS_PER_ASSISTANT = 32;
const MAX_SECRET_VALUES = 64;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_APPROVAL_REQUIREMENTS = 64;
const MAX_APPROVAL_INPUT_BYTES = 32 * 1024;
const MAX_APPROVAL_INPUT_TOTAL_BYTES = 128 * 1024;
const MAX_APPROVAL_JSON_DEPTH = 16;
const MAX_APPROVAL_JSON_NODES = 1024;
const MAX_REMEMBERED_APPROVALS = 8192;
const MAX_ACCOUNTS = 512;
const MAX_ACCOUNTS_PER_CHALLENGE = 64;
const MAX_ACCOUNT_SCOPES = 32;
const MAX_ACCOUNT_POWERS = 128;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_REPLY_CHARS = 60_000;
const MAX_ERROR_DETAIL_CHARS = 800;

export const CHAT_WS_PROTOCOL = 'shimpz.chat.v3';

async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function requireTeam(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local chat request.');
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
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

function canonicalMask(value) {
  if (typeof value !== 'string' || SECRET_CONTROL_RE.test(value)) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  if (value === '••••') return value;
  const characters = Array.from(value);
  const edgeLength = (characters.length - 1) / 2;
  if (!Number.isInteger(edgeLength) || edgeLength < 1 || edgeLength > 4 || characters[edgeLength] !== '…') {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return value;
}

function canonicalRequirement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(
    value,
    ['assistant_id', 'assistant_name', 'power_ids', 'secrets'],
  )) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const seen = new Set();
  if (!Array.isArray(value.secrets) || !value.secrets.length || value.secrets.length > MAX_SECRETS_PER_ASSISTANT) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const secrets = value.secrets.map((secret) => {
    if (
      !secret ||
      typeof secret !== 'object' ||
      Array.isArray(secret) ||
      !exactKeys(secret, ['id', 'name', 'summary'])
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const id = canonicalId(secret.id);
    if (seen.has(id)) throw new LocalApiError('The local chat response is invalid.');
    seen.add(id);
    return {
      id,
      name: canonicalPublicText(secret.name, 80),
      summary: canonicalPublicText(secret.summary, 160),
    };
  });
  return {
    assistant_id: canonicalId(value.assistant_id),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    power_ids: canonicalIds(value.power_ids, MAX_POWERS_PER_ASSISTANT),
    secrets,
  };
}

function canonicalInventoryAssistant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, ['id', 'name', 'secrets'])) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const seen = new Set();
  if (!Array.isArray(value.secrets) || value.secrets.length > MAX_SECRETS_PER_ASSISTANT) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const secrets = value.secrets.map((secret) => {
    if (
      !secret ||
      typeof secret !== 'object' ||
      Array.isArray(secret) ||
      !exactKeys(secret, ['configured', 'id', 'mask', 'name', 'summary']) ||
      typeof secret.configured !== 'boolean'
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const id = canonicalId(secret.id);
    if (seen.has(id)) throw new LocalApiError('The local chat response is invalid.');
    seen.add(id);
    const mask = secret.configured
      ? canonicalMask(secret.mask)
      : secret.mask === null
        ? null
        : undefined;
    if (mask === undefined) throw new LocalApiError('The local chat response is invalid.');
    return {
      id,
      name: canonicalPublicText(secret.name, 80),
      summary: canonicalPublicText(secret.summary, 160),
      configured: secret.configured,
      mask,
    };
  });
  return {
    id: canonicalId(value.id),
    name: canonicalPublicText(value.name, 80),
    secrets,
  };
}

function canonicalInventoryBody(
  body,
  teamId,
  status = 0,
  message = 'The Assistant secret inventory is invalid.',
) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !exactKeys(body, ['team_id', 'assistants']) ||
    body.team_id !== teamId ||
    !Array.isArray(body.assistants) ||
    body.assistants.length > MAX_INSTALLED_ASSISTANTS
  ) {
    throw new LocalApiError(message, status);
  }
  let assistants;
  try {
    assistants = body.assistants.map(canonicalInventoryAssistant);
  } catch {
    throw new LocalApiError(message, status);
  }
  if (new Set(assistants.map((entry) => entry.id)).size !== assistants.length) {
    throw new LocalApiError(message, status);
  }
  return { team_id: teamId, assistants };
}

function canonicalApprovalInput(value) {
  const budget = { nodes: MAX_APPROVAL_JSON_NODES };
  function clone(node, depth) {
    budget.nodes -= 1;
    if (budget.nodes < 0 || depth > MAX_APPROVAL_JSON_DEPTH) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return node;
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (Array.isArray(node)) return node.map((entry) => clone(entry, depth + 1));
    if (!node || typeof node !== 'object') {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const entries = Object.entries(node);
    if (entries.some(([key]) => key.length > 128)) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return Object.fromEntries(entries.map(([key, entry]) => [key, clone(entry, depth + 1)]));
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const result = clone(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_APPROVAL_INPUT_BYTES) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return result;
}

function canonicalApprovalRequirement(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'power_id',
      'power_summary',
      'input',
      'approval',
    ]) ||
    !['always', 'once'].includes(value.approval)
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return {
    assistant_id: canonicalId(value.assistant_id),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    power_id: canonicalId(value.power_id),
    power_summary: canonicalPublicText(value.power_summary, 160),
    input: canonicalApprovalInput(value.input),
    approval: value.approval,
  };
}

function canonicalOptionalPublicText(value, maximum) {
  return value === null ? null : canonicalPublicText(value, maximum);
}

function canonicalAccountScopes(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_ACCOUNT_SCOPES) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const scopes = values.map((value) => canonicalPublicText(value, 128));
  if (new Set(scopes).size !== scopes.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return scopes;
}

function canonicalAccountPower(value) {
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

function canonicalAccountPowers(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_ACCOUNT_POWERS) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  const powers = values.map(canonicalAccountPower);
  if (new Set(powers.map((power) => power.id)).size !== powers.length) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return powers;
}

function canonicalAccountRequirement(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'account_id',
      'provider',
      'name',
      'summary',
      'scopes',
      'powers',
    ])
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return {
    assistant_id: canonicalId(value.assistant_id),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    account_id: canonicalId(value.account_id),
    provider: canonicalId(value.provider),
    name: canonicalPublicText(value.name, 80),
    summary: canonicalPublicText(value.summary, 160),
    scopes: canonicalAccountScopes(value.scopes),
    powers: canonicalAccountPowers(value.powers),
  };
}

function canonicalAccountAccount(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['id', 'name', 'username'])
  ) {
    throw new LocalApiError('The Assistant account inventory is invalid.');
  }
  return {
    id: canonicalPublicText(value.id, 160),
    name: canonicalOptionalPublicText(value.name, 160),
    username: canonicalOptionalPublicText(value.username, 160),
  };
}

function canonicalAccountExpiry(value) {
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
    throw new LocalApiError('The Assistant account inventory is invalid.');
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
    throw new LocalApiError('The Assistant account inventory is invalid.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new LocalApiError('The Assistant account inventory is invalid.');
  }
  return value;
}

function canonicalAccountInventoryItem(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'id',
      'provider',
      'name',
      'summary',
      'scopes',
      'status',
      'account',
      'expires_at',
    ]) ||
    !['missing', 'connected', 'expired', 'reauthorization-required'].includes(value.status)
  ) {
    throw new LocalApiError('The Assistant account inventory is invalid.');
  }
  const account = canonicalAccountAccount(value.account);
  return {
    assistant_id: canonicalId(value.assistant_id, 'The Assistant account inventory is invalid.'),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    id: canonicalId(value.id, 'The Assistant account inventory is invalid.'),
    provider: canonicalId(value.provider, 'The Assistant account inventory is invalid.'),
    name: canonicalPublicText(value.name, 80),
    summary: canonicalPublicText(value.summary, 160),
    scopes: canonicalAccountScopes(value.scopes),
    status: value.status,
    account,
    expires_at: canonicalAccountExpiry(value.expires_at),
  };
}

function trustedAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || CONTROL_RE.test(value)) {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  const directProvider = (
    url.protocol === 'https:' &&
    url.hostname === 'dash.cloudflare.com' &&
    !url.port &&
    url.pathname === '/oauth2/auth'
  );
  const namedHandoffOrigin = (
    (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '7777') ||
    (url.protocol === 'https:' && url.hostname === 'local.shimpz.com' && !url.port)
  );
  const localHandoff = (
    namedHandoffOrigin &&
    url.pathname === '/api/oauth/cloudflare/start' &&
    [...url.searchParams.keys()].length === 1 &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get('handoff') ?? '')
  );
  if (url.username || url.password || url.hash || (!directProvider && !localHandoff)) {
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
      !FILE_ID_RE.test(file.id) ||
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

/** Build the only chat frame accepted by shimpz.chat.v3. Provider/model/keys remain server-owned. */
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
    turn.files.some((fileId) => !FILE_ID_RE.test(fileId)) ||
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

export function createSecretSubmitFrame(teamId, challengeId, values) {
  requireTeam(teamId);
  if (
    typeof challengeId !== 'string' ||
    !OPAQUE_ID_RE.test(challengeId) ||
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_SECRET_VALUES
  ) {
    throw new LocalApiError('Invalid local secret submission.');
  }
  const seen = new Set();
  const canonical = values.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !exactKeys(entry, ['assistant_id', 'secret_id', 'value'])
    ) {
      throw new LocalApiError('Invalid local secret submission.');
    }
    const assistantId = canonicalId(entry.assistant_id, 'Invalid local secret submission.');
    const secretId = canonicalId(entry.secret_id, 'Invalid local secret submission.');
    const identity = `${assistantId}\u0000${secretId}`;
    if (
      seen.has(identity) ||
      typeof entry.value !== 'string' ||
      !entry.value ||
      entry.value !== entry.value.trim() ||
      SECRET_CONTROL_RE.test(entry.value) ||
      new TextEncoder().encode(entry.value).length > MAX_SECRET_BYTES
    ) {
      throw new LocalApiError('Invalid local secret submission.');
    }
    seen.add(identity);
    return { assistant_id: assistantId, secret_id: secretId, value: entry.value };
  });
  return { type: 'secret-submit', challenge_id: challengeId, values: canonical };
}

export function createApprovalSubmitFrame(teamId, challengeId) {
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid local approval submission.');
  }
  return { type: 'approval-submit', challenge_id: challengeId, approved: true };
}

export async function replaceAssistantSecrets(fetcher, teamId, assistantId, values) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant secret replacement.');
  requireTeam(teamId);
  const canonicalAssistant = canonicalId(assistantId, 'Invalid Assistant secret replacement.');
  if (!Array.isArray(values) || !values.length || values.length > MAX_SECRETS_PER_ASSISTANT) {
    throw new LocalApiError('Invalid Assistant secret replacement.');
  }
  const outgoing = createSecretSubmitFrame(
    teamId,
    '0'.repeat(32),
    values.map((entry) => ({ assistant_id: canonicalAssistant, ...entry })),
  ).values.map(({ secret_id, value }) => ({ secret_id, value }));
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/assistant-secrets`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistant_id: canonicalAssistant, values: outgoing }),
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Assistant secrets could not be replaced.'), response.status);
  }
  return canonicalInventoryBody(body, teamId, response.status);
}

export async function listRememberedApprovals(fetcher, teamId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant approval request.');
  requireTeam(teamId);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/assistant-approvals`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Remembered approvals are unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['team_id', 'grants']) ||
    body.team_id !== teamId ||
    !Array.isArray(body.grants) ||
    body.grants.length > MAX_REMEMBERED_APPROVALS
  ) {
    throw new LocalApiError('Remembered approvals are invalid.', response.status);
  }
  const seen = new Set();
  const grants = body.grants.map((grant) => {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant) || !exactKeys(grant, ['assistant_id', 'power_id'])) {
      throw new LocalApiError('Remembered approvals are invalid.', response.status);
    }
    const item = {
      assistant_id: canonicalId(grant.assistant_id),
      power_id: canonicalId(grant.power_id),
    };
    const identity = `${item.assistant_id}\u0000${item.power_id}`;
    if (seen.has(identity)) throw new LocalApiError('Remembered approvals are invalid.', response.status);
    seen.add(identity);
    return item;
  });
  return { team_id: teamId, grants };
}

export async function revokeRememberedApprovals(fetcher, teamId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant approval request.');
  requireTeam(teamId);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/assistant-approvals`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Remembered approvals could not be revoked.'), response.status);
  }
  if (
    !exactKeys(body, ['team_id', 'revoked']) ||
    body.team_id !== teamId ||
    !Number.isSafeInteger(body.revoked) ||
    body.revoked < 0 ||
    body.revoked > MAX_REMEMBERED_APPROVALS
  ) {
    throw new LocalApiError('Remembered approval response is invalid.', response.status);
  }
  return { team_id: teamId, revoked: body.revoked };
}

export async function listAssistantAccounts(fetcher, teamId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant account request.');
  requireTeam(teamId);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/assistant-accounts`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant accounts are unavailable.'), response.status);
  }
  if (!exactKeys(body, ['accounts']) || !Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) {
    throw new LocalApiError('The Assistant account inventory is invalid.', response.status);
  }
  let accounts;
  try {
    accounts = body.accounts.map(canonicalAccountInventoryItem);
  } catch {
    throw new LocalApiError('The Assistant account inventory is invalid.', response.status);
  }
  const identities = accounts.map((account) => `${account.assistant_id}\u0000${account.id}`);
  if (new Set(identities).size !== identities.length) {
    throw new LocalApiError('The Assistant account inventory is invalid.', response.status);
  }
  return { accounts };
}

export async function authorizeAssistantAccount(fetcher, teamId, challengeId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant authorization request.');
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistant-accounts/challenges/${challengeId}/authorize`,
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
  if (!exactKeys(body, ['authorization_url'])) {
    throw new LocalApiError('The Assistant authorization response is invalid.', response.status);
  }
  return { authorization_url: trustedAuthorizationUrl(body.authorization_url) };
}

export async function disconnectAssistantAccount(fetcher, teamId, assistantId, accountId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant account request.');
  requireTeam(teamId);
  const canonicalAssistant = canonicalId(assistantId, 'Invalid Assistant account request.');
  const canonicalAccount = canonicalId(accountId, 'Invalid Assistant account request.');
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistant-accounts/${canonicalAssistant}/${canonicalAccount}`,
    { method: 'DELETE', headers: { Accept: 'application/json' } },
  );
  if (!response.ok) {
    const body = await jsonObject(response);
    throw new LocalApiError(safeApiError(body, 'Assistant account could not be disconnected.'), response.status);
  }
  if (response.status !== 204) {
    throw new LocalApiError('The Assistant disaccount response is invalid.', response.status);
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
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.reply)
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
  if (value.type === 'stopped' && exactKeys(value, ['type'])) return { type: 'stopped' };
  if (value.type === 'secrets-required') {
    if (
      !exactKeys(value, ['type', 'turn_id', 'challenge_id', 'requirements']) ||
      typeof value.turn_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.turn_id) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Array.isArray(value.requirements) ||
      !value.requirements.length ||
      value.requirements.length > MAX_ASSISTANTS
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const requirements = value.requirements.map(canonicalRequirement);
    if (
      new Set(requirements.map((entry) => entry.assistant_id)).size !== requirements.length ||
      requirements.reduce((total, entry) => total + entry.secrets.length, 0) > MAX_SECRET_VALUES
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'secrets-required',
      turn_id: value.turn_id,
      challenge_id: value.challenge_id,
      requirements,
    };
  }
  if (value.type === 'approval-required') {
    if (
      !exactKeys(value, ['type', 'turn_id', 'challenge_id', 'requirements']) ||
      typeof value.turn_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.turn_id) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Array.isArray(value.requirements) ||
      !value.requirements.length ||
      value.requirements.length > MAX_APPROVAL_REQUIREMENTS
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const requirements = value.requirements.map(canonicalApprovalRequirement);
    const aggregateBytes = requirements.reduce(
      (total, requirement) => total + new TextEncoder().encode(JSON.stringify(requirement.input)).length,
      0,
    );
    if (aggregateBytes > MAX_APPROVAL_INPUT_TOTAL_BYTES) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'approval-required',
      turn_id: value.turn_id,
      challenge_id: value.challenge_id,
      requirements,
    };
  }
  if (value.type === 'accounts-required') {
    if (
      !exactKeys(value, ['type', 'challenge_id', 'expires_in', 'requirements']) ||
      typeof value.challenge_id !== 'string' ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 1 ||
      value.expires_in > 900 ||
      !Array.isArray(value.requirements) ||
      !value.requirements.length ||
      value.requirements.length > MAX_ACCOUNTS_PER_CHALLENGE
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const requirements = value.requirements.map(canonicalAccountRequirement);
    const identities = requirements.map((requirement) => (
      `${requirement.assistant_id}\u0000${requirement.account_id}`
    ));
    if (new Set(identities).size !== identities.length) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'accounts-required',
      challenge_id: value.challenge_id,
      expires_in: value.expires_in,
      requirements,
    };
  }
  if (value.type === 'secret-inventory') {
    if (
      !exactKeys(value, ['type', 'team_id', 'assistants']) ||
      value.team_id !== expectedTeamId ||
      !TEAM_ID_RE.test(value.team_id) ||
      !Array.isArray(value.assistants) ||
      value.assistants.length > MAX_INSTALLED_ASSISTANTS
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const inventory = canonicalInventoryBody(
      { team_id: value.team_id, assistants: value.assistants },
      expectedTeamId,
      0,
      'The local chat response is invalid.',
    );
    return { type: 'secret-inventory', ...inventory };
  }
  throw new LocalApiError('The local chat response is invalid.');
}
