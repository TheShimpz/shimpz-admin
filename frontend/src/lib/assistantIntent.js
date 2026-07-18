export const STORE_ORIGIN = 'https://shimpz.com';
export const INSTALL_INTENT = Object.freeze({
  type: 'shimpz:assistant-install',
  version: 1,
  assistant: 'hello-pulse',
});
export const UNINSTALL_INTENT = Object.freeze({
  type: 'shimpz:assistant-uninstall',
  version: 1,
  assistant: 'hello-pulse',
});
export const INSTALL_ACK_TYPE = 'shimpz:assistant-install-ack';
export const UNINSTALL_ACK_TYPE = 'shimpz:assistant-uninstall-ack';
export const STORE_FRAME_TYPE = 'shimpz:assistant-store-frame';
export const STORE_CONTEXT_TYPE = 'shimpz:assistant-store-context';
export const STORE_STATE_TYPE = 'shimpz:assistant-store-state';
export const STORE_FRAME_MIN_HEIGHT = 320;
export const STORE_FRAME_MAX_HEIGHT = 5000;
export const STORE_STATE_MAX_ASSISTANTS = 128;
export const STORE_LIFECYCLE_PROTOCOL_VERSION = 1;

const INTENT_KEYS = Object.freeze(['assistant', 'type', 'version']);
const FRAME_KEYS = Object.freeze(['height', 'type', 'version']);
const STATE_KEYS = Object.freeze(['installed', 'status', 'type', 'version']);
const STATE_STATUSES = new Set(['error', 'loading', 'ready']);
const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STORE_LOCALES = new Set(['en', 'pt']);
const RELEASED_STORE_ASSISTANT_IDS = Object.freeze([INSTALL_INTENT.assistant]);
const RELEASED_STORE_ASSISTANTS = new Set(RELEASED_STORE_ASSISTANT_IDS);
const STORE_ACTIONS = new Set(['install', 'uninstall']);

/** Build one canonical Store detail link without accepting an arbitrary origin or path. */
export function assistantStoreHref(locale, assistantId) {
  if (!STORE_LOCALES.has(locale) || !ASSISTANT_ID_RE.test(assistantId)) return null;
  return `${STORE_ORIGIN}/${locale}/assistants/${assistantId}`;
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  keys.sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
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

function acceptsStoreIntent(event, iframeWindow, expected) {
  if (!isTrustedStoreEvent(event, iframeWindow)) return false;
  const data = event.data;
  if (!hasExactKeys(data, INTENT_KEYS)) return false;
  return (
    data.type === expected.type &&
    data.version === expected.version &&
    data.assistant === expected.assistant
  );
}

function acknowledgeStoreIntent(event, iframeWindow, expected, acknowledgementType) {
  if (!acceptsStoreIntent(event, iframeWindow, expected)) return false;
  event.source.postMessage(
    {
      type: acknowledgementType,
      version: expected.version,
      assistant: expected.assistant,
      accepted: true,
    },
    event.origin,
  );
  return true;
}

/**
 * Accept one inert Store intent. The Store can nominate the released Assistant, but it never gets
 * a local token, Team id, or authority to install; the Captain must select and confirm locally.
 */
export function acceptsStoreInstallIntent(event, iframeWindow) {
  return acceptsStoreIntent(event, iframeWindow, INSTALL_INTENT);
}

/**
 * Acknowledge only the exact inert Store intent. The response deliberately contains no Team,
 * inventory, token, runtime, or installation state; local admission remains entirely in the Admin.
 */
export function acknowledgeStoreInstallIntent(event, iframeWindow) {
  return acknowledgeStoreIntent(event, iframeWindow, INSTALL_INTENT, INSTALL_ACK_TYPE);
}

/** Accept only the exact inert uninstall request; the Store still receives no local authority. */
export function acceptsStoreUninstallIntent(event, iframeWindow) {
  return acceptsStoreIntent(event, iframeWindow, UNINSTALL_INTENT);
}

/** Acknowledge receipt without revealing whether, where, or how an Assistant is installed. */
export function acknowledgeStoreUninstallIntent(event, iframeWindow) {
  return acknowledgeStoreIntent(event, iframeWindow, UNINSTALL_INTENT, UNINSTALL_ACK_TYPE);
}

/**
 * Return the Store document height only for the exact, bounded frame protocol. The Store never
 * learns local state through this message; it only proves that its embedded UI is ready to show.
 */
export function storeFrameHeight(event, iframeWindow) {
  if (!isTrustedStoreEvent(event, iframeWindow)) return null;
  const data = event.data;
  if (!hasExactKeys(data, FRAME_KEYS)) return null;
  if (
    data.type !== STORE_FRAME_TYPE ||
    data.version !== INSTALL_INTENT.version ||
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
    { type: STORE_CONTEXT_TYPE, version: INSTALL_INTENT.version },
    STORE_ORIGIN,
  );
  return height;
}

/** Project the private local inventory onto the intentionally public Store catalog. */
export function projectReleasedStoreAssistantIds(installedAssistants) {
  if (!Array.isArray(installedAssistants)) return [];
  const installed = new Set(
    installedAssistants
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.assistant === 'string')
      .map((entry) => entry.assistant),
  );
  return RELEASED_STORE_ASSISTANT_IDS.filter((assistant) => installed.has(assistant));
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
      !RELEASED_STORE_ASSISTANTS.has(assistant) ||
      seen.has(assistant)
    ) {
      return false;
    }
    seen.add(assistant);
  }

  const message = {
    type: STORE_STATE_TYPE,
    version: INSTALL_INTENT.version,
    status,
    installed: [...installed],
  };
  if (!hasExactKeys(message, STATE_KEYS)) return false;
  iframeWindow.postMessage(message, STORE_ORIGIN);
  return true;
}
