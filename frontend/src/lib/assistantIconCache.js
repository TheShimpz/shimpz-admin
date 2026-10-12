// Decoded Assistant icons kept for the Supervisor session, in memory only (ADR-0037): Admin serves every icon `no-store`
// and nothing persists one. Each icon is an object URL of exactly what the server names: a staged snapshot's icon by its
// image id, a publication's by its catalog entry's identity and icon digest, whose bytes must have that digest. A
// screen pins the icons it shows and only unpins them when it leaves, so returning shows them at once; an icon no screen
// shows is evicted, least recently used first, beyond the count and decoded-size bounds, and the session's end revokes
// every one and drops every load under way.
import { loadLocalAssistantIcon, loadPublicAssistantIcon } from './localAssistantIcons.js';

export const MAX_CACHED_ICONS = 48;
// A canonical icon is 1024 by 1024 pixels, about 4 MiB decoded: the bound keeps 48 of them.
const MAX_DECODED_BYTES = 192 * 1024 * 1024;
// How long one icon load may take before it is given up: a slow host still delivers it, a request that never answers
// does not hold its connection forever.
const ICON_REQUEST_LIMIT_MS = 30_000;

const entries = new Map();

function abortError() {
  return new DOMException('The Assistant icon request was aborted.', 'AbortError');
}

function decodeImage(image, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    image.decode().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// One fetched icon as a decoded object URL: the image stays referenced with it, so showing it again needs no decode.
async function decoded(icon, signal) {
  const url = URL.createObjectURL(icon);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await decodeImage(image, signal);
    if (signal.aborted) throw abortError();
    return { url, image, bytes: image.naturalWidth * image.naturalHeight * 4 };
  } catch (error) {
    image.src = '';
    URL.revokeObjectURL(url);
    throw error;
  }
}

function discard(key, entry) {
  if (entries.get(key) === entry) entries.delete(key);
  entry.controller.abort();
  if (entry.url) {
    entry.image.src = '';
    URL.revokeObjectURL(entry.url);
  }
}

// Evict the least recently used icons no screen shows while the cache holds more than its bounds allow.
function evict() {
  let decodedBytes = 0;
  for (const entry of entries.values()) decodedBytes += entry.bytes;
  const idle = [...entries].filter(([, entry]) => entry.pins === 0 && entry.url).sort(([, a], [, b]) => a.used - b.used);
  for (const [key, entry] of idle) {
    if (entries.size <= MAX_CACHED_ICONS && decodedBytes <= MAX_DECODED_BYTES) break;
    decodedBytes -= entry.bytes;
    discard(key, entry);
  }
}

function load(key, fetchIcon) {
  const controller = new AbortController();
  const entry = { controller, url: '', image: null, bytes: 0, pins: 0, used: performance.now(), promise: null };
  const limit = globalThis.setTimeout(() => controller.abort(), ICON_REQUEST_LIMIT_MS);
  entry.promise = (async () => {
    try {
      const icon = await fetchIcon(controller.signal);
      // An icon evicted or cleared while it loaded was aborted, so decoding it threw: this one is still the cache's.
      const shown = await decoded(icon, controller.signal);
      Object.assign(entry, shown);
      evict();
      return shown.url;
    } catch (error) {
      // A failed icon is not kept: the next screen that shows it asks again.
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    } finally {
      globalThis.clearTimeout(limit);
    }
  })();
  entries.set(key, entry);
  return entry;
}

/**
 * Pin one icon for a screen that shows it: `cached` is its object URL when the cache holds it, and `url` settles with
 * it, loaded and decoded first when the cache does not; `release()` unpins it once the screen no longer shows it, and
 * the cache keeps it within its bounds. `icon` is `{ key, fetch(signal) }`, as `localIcon` and `publicIcon` describe.
 */
export function acquireIcon(icon) {
  const entry = entries.get(icon.key) ?? load(icon.key, icon.fetch);
  entry.pins += 1;
  entry.used = performance.now();
  let pinned = true;
  return {
    // The object URL at once when the cache holds the decoded icon, so a screen shows it in its first frame.
    cached: entry.url,
    url: entry.promise,
    release() {
      if (!pinned) return;
      pinned = false;
      entry.pins -= 1;
      entry.used = performance.now();
      if (entry.pins === 0 && entries.get(icon.key) === entry) evict();
    },
  };
}

/** Load and decode icons a screen is about to show, keeping them unpinned. */
export function preloadIcons(icons) {
  for (const icon of icons) {
    const pin = acquireIcon(icon);
    pin.url.catch(() => {}).finally(() => pin.release());
  }
}

/** The session ended: every icon is revoked and every load under way dropped. */
export function clearIconCache() {
  for (const [key, entry] of [...entries]) discard(key, entry);
}

/** A staged snapshot's icon: its exact image. */
export function localIcon(snapshot) {
  return {
    key: `local:${snapshot.image_id}`,
    fetch: (signal) => loadLocalAssistantIcon(fetch, snapshot.image_id, { signal }),
  };
}

/** A publication's icon: the catalog entry's exact publication and icon digest, which its bytes must have. */
export function publicIcon(assistant) {
  return {
    key: `public:${assistant.assistant_id}:${assistant.source_digest}:${assistant.icon_digest}`,
    fetch: (signal) => loadPublicAssistantIcon(fetch, assistant.assistant_id, {
      signal,
      iconDigest: assistant.icon_digest,
    }),
  };
}
