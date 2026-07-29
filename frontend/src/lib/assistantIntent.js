import { ASSISTANT_ID_RE, exactKeys } from './validate.js';

export const STORE_ORIGIN = 'https://shimpz.com';
export const INSTALL_INTENT_TYPE = 'shimpz:assistant-install';
export const UNINSTALL_INTENT_TYPE = 'shimpz:assistant-uninstall';
export const INSTALL_ACK_TYPE = 'shimpz:assistant-install-ack';
export const UNINSTALL_ACK_TYPE = 'shimpz:assistant-uninstall-ack';
export const STORE_FRAME_TYPE = 'shimpz:assistant-store-frame';
export const STORE_CONTEXT_TYPE = 'shimpz:assistant-store-context';
export const STORE_STATE_TYPE = 'shimpz:assistant-store-state';
export const STORE_FRAME_MIN_HEIGHT = 320;
export const STORE_FRAME_MAX_HEIGHT = 5000;
export const STORE_STATE_MAX_ASSISTANTS = 128;
export const STORE_LIFECYCLE_PROTOCOL_VERSION = 2;

const INSTALL_INTENT_KEYS = Object.freeze(['assistant', 'source_digest', 'type', 'version']);
const UNINSTALL_INTENT_KEYS = Object.freeze(['assistant', 'type', 'version']);
const FRAME_KEYS = Object.freeze(['height', 'type', 'version']);
const STATE_KEYS = Object.freeze(['installed', 'status', 'type', 'version']);
const STATE_STATUSES = new Set(['error', 'loading', 'ready']);
const STORE_LOCALES = new Set(['en', 'pt']);
const STORE_ACTIONS = new Set(['install', 'uninstall']);

/** Build one canonical Store detail link without accepting an arbitrary origin or path. */
export function assistantStoreHref(locale, assistantId) {
  if (!STORE_LOCALES.has(locale) || !ASSISTANT_ID_RE.test(assistantId)) return null;
  return `${STORE_ORIGIN}/${locale}/assistants?assistant=${encodeURIComponent(assistantId)}`;
}

function isTrustedStoreEvent(event, iframeWindow) {
  return Boolean(event && event.origin === STORE_ORIGIN && event.source === iframeWindow && iframeWindow);
}

/** Keep one local Store admission active without exposing its state across the frame boundary. */
export function createStoreActionLatch() {
  let activeAction = '';
  return Object.freeze({
    acquire(action) {
      if (!STORE_ACTIONS.has(action) || activeAction) return false;
      activeAction = action;
      return true;
    },
    release(action) {
      if (activeAction !== action) return false;
      activeAction = '';
      return true;
    },
  });
}

function acceptsStoreIntent(event, iframeWindow, expectedType, expectedKeys) {
  if (!isTrustedStoreEvent(event, iframeWindow)) return false;
  const data = event.data;
  if (!exactKeys(data, expectedKeys)) return false;
  return (
    data.type === expectedType &&
    data.version === STORE_LIFECYCLE_PROTOCOL_VERSION &&
    typeof data.assistant === 'string' &&
    data.assistant.length <= 80 &&
    ASSISTANT_ID_RE.test(data.assistant) &&
    (
      expectedType !== INSTALL_INTENT_TYPE ||
      (
        typeof data.source_digest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(data.source_digest)
      )
    )
  );
}

function acknowledgeStoreIntent(event, iframeWindow, expectedType, expectedKeys, acknowledgementType) {
  if (!acceptsStoreIntent(event, iframeWindow, expectedType, expectedKeys)) return false;
  event.source.postMessage(
    {
      type: acknowledgementType,
      version: STORE_LIFECYCLE_PROTOCOL_VERSION,
      assistant: event.data.assistant,
      accepted: true,
    },
    event.origin,
  );
  return true;
}

/**
 * Accept one inert Store intent. The Store can nominate the released Assistant, but it never gets
 * a local token, Team id, or authority to install; the Supervisor must select and confirm locally.
 */
export function acceptsStoreInstallIntent(event, iframeWindow) {
  return acceptsStoreIntent(event, iframeWindow, INSTALL_INTENT_TYPE, INSTALL_INTENT_KEYS);
}

/**
 * Acknowledge only the exact inert Store intent. The response deliberately contains no Team,
 * inventory, token, runtime, or installation state; local admission remains entirely in the Admin.
 */
export function acknowledgeStoreInstallIntent(event, iframeWindow) {
  return acknowledgeStoreIntent(
    event,
    iframeWindow,
    INSTALL_INTENT_TYPE,
    INSTALL_INTENT_KEYS,
    INSTALL_ACK_TYPE,
  );
}

/** Accept only the exact inert uninstall request; the Store still receives no local authority. */
export function acceptsStoreUninstallIntent(event, iframeWindow) {
  return acceptsStoreIntent(event, iframeWindow, UNINSTALL_INTENT_TYPE, UNINSTALL_INTENT_KEYS);
}

/** Acknowledge receipt without revealing whether, where, or how an Assistant is installed. */
export function acknowledgeStoreUninstallIntent(event, iframeWindow) {
  return acknowledgeStoreIntent(
    event,
    iframeWindow,
    UNINSTALL_INTENT_TYPE,
    UNINSTALL_INTENT_KEYS,
    UNINSTALL_ACK_TYPE,
  );
}

/**
 * Return the Store document height only for the exact, bounded frame protocol. The Store never
 * learns local state through this message; it only proves that its embedded UI is ready to show.
 */
export function storeFrameHeight(event, iframeWindow) {
  if (!isTrustedStoreEvent(event, iframeWindow)) return null;
  const data = event.data;
  if (!exactKeys(data, FRAME_KEYS)) return null;
  if (
    data.type !== STORE_FRAME_TYPE ||
    data.version !== STORE_LIFECYCLE_PROTOCOL_VERSION ||
    !Number.isInteger(data.height) ||
    data.height < STORE_FRAME_MIN_HEIGHT ||
    data.height > STORE_FRAME_MAX_HEIGHT
  ) return null;
  return data.height;
}

/** Acknowledge a valid frame measurement with a deliberately data-free parent context. */
export function acknowledgeStoreFrame(event, iframeWindow) {
  const height = storeFrameHeight(event, iframeWindow);
  if (height === null) return null;
  event.source.postMessage(
    { type: STORE_CONTEXT_TYPE, version: STORE_LIFECYCLE_PROTOCOL_VERSION },
    STORE_ORIGIN,
  );
  return height;
}

/** Project the private local inventory onto the intentionally public Store catalog. */
export function projectInstalledAssistantIds(installedAssistants) {
  if (!Array.isArray(installedAssistants)) return [];
  const installed = [];
  for (const entry of installedAssistants) {
    const assistant = entry && typeof entry === 'object' ? entry.assistant : null;
    if (
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      installed.includes(assistant)
    ) {
      return [];
    }
    installed.push(assistant);
  }
  return installed;
}

/**
 * Publish only the bounded installed-id projection needed to render the embedded Store. Team
 * identity, runtime metadata, credentials, and local authority never cross this boundary.
 */
export function postStoreAssistantState(iframeWindow, status, installed) {
  if (!iframeWindow || typeof iframeWindow.postMessage !== 'function') return false;
  if (!STATE_STATUSES.has(status) || !Array.isArray(installed)) return false;
  if (installed.length > STORE_STATE_MAX_ASSISTANTS) return false;
  if (status !== 'ready' && installed.length !== 0) return false;

  const seen = new Set();
  for (const assistant of installed) {
    if (
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      seen.has(assistant)
    ) {
      return false;
    }
    seen.add(assistant);
  }

  const message = {
    type: STORE_STATE_TYPE,
    version: STORE_LIFECYCLE_PROTOCOL_VERSION,
    status,
    installed: [...installed],
  };
  if (!exactKeys(message, STATE_KEYS)) return false;
  iframeWindow.postMessage(message, STORE_ORIGIN);
  return true;
}
