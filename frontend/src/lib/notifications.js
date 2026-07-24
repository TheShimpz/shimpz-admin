import { ASSISTANT_ID_RE, exactKeys, OPAQUE_ID_RE } from './validate.js';

const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_NOTIFICATIONS = 256;
const MAX_ASSISTANT_ID_LENGTH = 80;
const MAX_HEADLINE_LENGTH = 160;
const MAX_CHANGELOG_BYTES = 32 * 1024;
export const ASSISTANT_RUNTIME_UPDATED_EVENT = 'shimpz:assistant-runtime-updated';

function isBoundedText(value, maximum, { multiline = false, allowBoundaryWhitespace = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return false;
  if (allowBoundaryWhitespace ? value.trim().length === 0 : value.trim() !== value) return false;
  const forbiddenControls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  return !forbiddenControls.test(value);
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !UTC_RFC3339.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().replace('.000Z', 'Z') === value;
}

function parseNotification(value) {
  const keys = ['id', 'assistant_id', 'sequence', 'headline', 'changelog', 'published_at', 'read_at'];
  if (!exactKeys(value, keys)) throw new Error('invalid notification');
  if (!OPAQUE_ID_RE.test(value.id)) throw new Error('invalid notification id');
  if (value.assistant_id.length > MAX_ASSISTANT_ID_LENGTH || !ASSISTANT_ID_RE.test(value.assistant_id)) {
    throw new Error('invalid notification assistant');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error('invalid notification sequence');
  if (!isBoundedText(value.headline, MAX_HEADLINE_LENGTH)) throw new Error('invalid notification headline');
  if (
    !isBoundedText(value.changelog, MAX_CHANGELOG_BYTES, { multiline: true, allowBoundaryWhitespace: true })
    || new TextEncoder().encode(value.changelog).length > MAX_CHANGELOG_BYTES
  ) {
    throw new Error('invalid notification changelog');
  }
  if (!isTimestamp(value.published_at)) throw new Error('invalid notification publication time');
  if (value.read_at !== null && !isTimestamp(value.read_at)) throw new Error('invalid notification read time');

  return Object.freeze({ ...value });
}

/** Validate the complete local notification snapshot before it reaches UI state. */
export function parseNotificationEnvelope(value) {
  if (!exactKeys(value, ['notifications', 'unread_count'])) throw new Error('invalid notifications response');
  if (!Array.isArray(value.notifications) || value.notifications.length > MAX_NOTIFICATIONS) {
    throw new Error('invalid notifications list');
  }

  const notifications = value.notifications.map(parseNotification);
  if (new Set(notifications.map((notification) => notification.id)).size !== notifications.length) {
    throw new Error('duplicate notification id');
  }
  const unreadCount = notifications.filter((notification) => notification.read_at === null).length;
  if (!Number.isSafeInteger(value.unread_count) || value.unread_count !== unreadCount) {
    throw new Error('invalid unread notification count');
  }

  return Object.freeze({ notifications: Object.freeze(notifications), unread_count: unreadCount });
}

export function parseNotificationSyncEnvelope(value) {
  if (!exactKeys(value, ['notifications', 'unread_count', 'sync'])) {
    throw new Error('invalid notification sync response');
  }
  const envelope = parseNotificationEnvelope({
    notifications: value.notifications,
    unread_count: value.unread_count,
  });
  if (!exactKeys(value.sync, ['status', 'updated_assistants', 'notifications_added', 'failed_updates'])) {
    throw new Error('invalid notification sync result');
  }
  if (!['ok', 'offline', 'partial'].includes(value.sync.status)) throw new Error('invalid notification sync status');
  for (const key of ['updated_assistants', 'notifications_added', 'failed_updates']) {
    if (!Number.isSafeInteger(value.sync[key]) || value.sync[key] < 0) {
      throw new Error('invalid notification sync count');
    }
  }
  return Object.freeze({ ...envelope, sync: Object.freeze({ ...value.sync }) });
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
}

async function requestJson(fetchImpl, path, init, parser) {
  requireFetch(fetchImpl);
  const response = await fetchImpl(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    ...init,
  });
  if (!response?.ok) throw new Error(`notification request failed (${response?.status ?? 0})`);
  return parser(await response.json());
}

export function getNotifications(fetchImpl) {
  return requestJson(fetchImpl, '/api/notifications', { method: 'GET' }, parseNotificationEnvelope);
}

export function syncNotifications(fetchImpl) {
  return requestJson(fetchImpl, '/api/notifications/sync', { method: 'POST' }, parseNotificationSyncEnvelope);
}

/** Announce a completed local runtime upgrade without exposing Assistant or Team metadata. */
export function dispatchAssistantRuntimeUpdated(target = globalThis.window) {
  if (!target || typeof target.dispatchEvent !== 'function') return false;
  target.dispatchEvent(new Event(ASSISTANT_RUNTIME_UPDATED_EVENT));
  return true;
}

export function readNotification(fetchImpl, notificationId) {
  if (!OPAQUE_ID_RE.test(notificationId)) throw new TypeError('invalid notification id');
  return requestJson(
    fetchImpl,
    `/api/notifications/${notificationId}/read`,
    { method: 'POST' },
    parseNotificationEnvelope,
  );
}

export function readAllNotifications(fetchImpl) {
  return requestJson(fetchImpl, '/api/notifications/read-all', { method: 'POST' }, parseNotificationEnvelope);
}

export function clearNotifications(fetchImpl) {
  return requestJson(fetchImpl, '/api/notifications', { method: 'DELETE' }, parseNotificationEnvelope);
}
