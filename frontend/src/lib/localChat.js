import { LocalApiError, safeApiError } from './localApi.js';

const CAPSULE_ID_RE = /^[a-z0-9_]{1,40}$/;
const FILE_ID_RE = /^[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_FILES = 8;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_REPLY_CHARS = 60_000;
const MAX_ERROR_DETAIL_CHARS = 800;

export const CHAT_WS_PROTOCOL = 'shimpz.chat.v1';

async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function requireCapsule(capsuleId) {
  if (!CAPSULE_ID_RE.test(capsuleId)) throw new LocalApiError('Invalid local chat request.');
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
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return value;
}

export async function listCapsuleFiles(fetcher, capsuleId) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid local file request.');
  requireCapsule(capsuleId);
  const response = await fetcher(`/api/capsules/${encodeURIComponent(capsuleId)}/files`, {
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

/** Build the only chat frame accepted by shimpz.chat.v1. Provider/model/keys remain server-owned. */
export function createChatFrame(capsuleId, turn) {
  requireCapsule(capsuleId);
  if (!turn || typeof turn !== 'object' || Object.keys(turn).sort().join(',') !== 'files,message') {
    throw new LocalApiError('Chat accepts only message and files.');
  }
  const message = typeof turn.message === 'string' ? turn.message.trim() : '';
  if (
    !message ||
    message.length > MAX_MESSAGE_CHARS ||
    !Array.isArray(turn.files) ||
    turn.files.length > MAX_FILES ||
    turn.files.some((fileId) => !FILE_ID_RE.test(fileId)) ||
    new Set(turn.files).size !== turn.files.length
  ) {
    throw new LocalApiError('Invalid local chat request.');
  }
  return { type: 'chat', message, files: [...turn.files] };
}

export function createStopFrame(capsuleId) {
  requireCapsule(capsuleId);
  return { type: 'stop' };
}

export function chatSocketUrl(locationValue, capsuleId) {
  requireCapsule(capsuleId);
  if (!locationValue || typeof locationValue.host !== 'string') {
    throw new LocalApiError('Invalid local chat request.');
  }
  const scheme = locationValue.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${locationValue.host}/api/capsules/${capsuleId}/chat/ws`;
}

/** Parse one terminal frame. Raw provider events and extra fields fail closed. */
export function parseChatTerminalEvent(value, expectedTeam) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  if (value.type === 'done') {
    if (
      !exactKeys(value, ['type', 'reply', 'team']) ||
      canonicalTeam(value.team) !== canonicalTeam(expectedTeam) ||
      typeof value.reply !== 'string' ||
      !value.reply.trim() ||
      value.reply.length > MAX_REPLY_CHARS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.reply)
    ) {
      throw new LocalApiError('The local chat response is invalid.');
    }
    return { type: 'done', team: value.team, reply: value.reply };
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
  throw new LocalApiError('The local chat response is invalid.');
}
