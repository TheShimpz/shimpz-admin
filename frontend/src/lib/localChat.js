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
const MAX_SECRET_VALUES = MAX_ASSISTANTS * MAX_SECRETS_PER_ASSISTANT;
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_REPLY_CHARS = 60_000;
const MAX_ERROR_DETAIL_CHARS = 800;

export const CHAT_WS_PROTOCOL = 'shimpz.chat.v2';

async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function requireTeam(teamId) {
  if (!TEAM_ID_RE.test(teamId)) throw new LocalApiError('Invalid local chat request.');
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

/** Build the only chat frame accepted by shimpz.chat.v2. Provider/model/keys remain server-owned. */
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
      !OPAQUE_ID_RE.test(value.turn_id) ||
      !OPAQUE_ID_RE.test(value.challenge_id) ||
      !Array.isArray(value.requirements) ||
      !value.requirements.length ||
      value.requirements.length > MAX_ASSISTANTS
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    const requirements = value.requirements.map(canonicalRequirement);
    if (new Set(requirements.map((entry) => entry.assistant_id)).size !== requirements.length) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return {
      type: 'secrets-required',
      turn_id: value.turn_id,
      challenge_id: value.challenge_id,
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
    const assistants = value.assistants.map(canonicalInventoryAssistant);
    if (new Set(assistants.map((entry) => entry.id)).size !== assistants.length) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return { type: 'secret-inventory', team_id: value.team_id, assistants };
  }
  throw new LocalApiError('The local chat response is invalid.');
}
