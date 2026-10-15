// Thumbnails of the images a sent message carried, kept for the Supervisor session in memory only (ADR-0093). Each is
// drawn from Team's sanitized rendition of the stored file, never the original: Admin serves that rendition `no-store`,
// and the browser keeps only a smaller re-encoding of it in its own proportions, at most THUMBNAIL_EDGE device pixels on
// its long edge and never larger than the rendition, as an object URL, with the rendition's own size for the viewer. At most MAX_LOADING renditions load at once and at most MAX_PREVIEWS
// thumbnails are kept: one no message shows is evicted least recently used first, and beyond the bound a message keeps
// its card. Every session check clears them, and a load that settles after one is discarded.
import { attachmentKind, fetchFileBytes, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from './files.js';
import { OPAQUE_ID_RE, TEAM_ID_RE } from '../../ids.js';

export const MAX_PREVIEWS = 48;
export const MAX_LOADING = 2;
const THUMBNAIL_EDGE = 640;
// Team's rendition never exceeds these (Team protocol/http/v1/turn.py); a larger answer is refused before it is drawn.
const RENDITION_EDGE = 1_568;
const RENDITION_PIXELS = 1_200_000;
// How long one rendition may take to load: a busy Team still answers, a request that never answers is given up.
const LOAD_LIMIT_MS = 30_000;

const entries = new Map();
const queue = [];
let loading = 0;
let generation = 0;

/** The Admin route of one stored file's rendition, as an image loads it. */
export function previewUrl(teamId, fileId) {
  return `/api/teams/${teamId}/files/${fileId}/preview`;
}

// A PDF's page renditions: Team renders at most this many pages, and the first page's answer names the page count.
export const MAX_PDF_PAGES = 50;
export const PAGE_COUNT_HEADER = 'x-page-count';

/** The Admin route of one page's rendition of a stored PDF, pages counted from 1. */
export function pageUrl(teamId, fileId, page) {
  return `/api/teams/${teamId}/files/${fileId}/pages/${page}/preview`;
}

/** Whether a file reference names a file Team stored for a valid Team, which Admin can serve. */
export function stored(teamId, file) {
  return typeof teamId === 'string' && TEAM_ID_RE.test(teamId) && typeof file?.id === 'string' && OPAQUE_ID_RE.test(file.id);
}

/** Whether a stored file is a PDF within Team's PDF ceiling, whose pages Team can render. */
export function paged(teamId, file) {
  return stored(teamId, file) &&
    attachmentKind(file.mediaType) === 'pdf' &&
    Number.isSafeInteger(file.size) &&
    file.size > 0 &&
    file.size <= MAX_PDF_BYTES;
}

/**
 * Whether a sent file reference may ask for a thumbnail: a stored file of a valid Team whose stored media type names a
 * JPEG, PNG, or WebP within Team's image ceiling. The live message and its reload carry the same stored media type, so
 * both decide alike; Team still decides from the bytes, and a file it cannot read keeps its card.
 */
export function previewable(teamId, file) {
  return stored(teamId, file) &&
    attachmentKind(file.mediaType) === 'image' &&
    Number.isSafeInteger(file.size) &&
    file.size > 0 &&
    file.size <= MAX_IMAGE_BYTES;
}

/** The thumbnail's size: the rendition's own proportions, its long edge at most `edge`, never upscaled. */
/** A thumbnail's size: the rendition's proportions within `edge` on both sides, never upscaled. */
export function thumbnailSize(width, height, edge = THUMBNAIL_EDGE) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function abortError() {
  return new DOMException('The image preview was aborted.', 'AbortError');
}

function encoded(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The thumbnail could not be encoded.'))), 'image/webp', 0.86);
  });
}

function unavailable() {
  return new Error('The image preview is unavailable.');
}

/**
 * Read one rendition and draw its thumbnail: it is read as every other preview is, waiting out a Team busy with its
 * single preview slot, decoded once, and only the re-encoded thumbnail stays. A rendition larger than Team ever sends
 * is refused before it is drawn.
 */
export async function drawThumbnail(url, signal) {
  if (signal.aborted) throw abortError();
  let blob;
  try {
    blob = await (await fetchFileBytes(url, signal)).blob();
  } catch {
    throw signal.aborted ? abortError() : unavailable();
  }
  if (signal.aborted) throw abortError();
  const rendition = await createImageBitmap(blob).catch(() => {
    throw unavailable();
  });
  try {
    const { width, height } = rendition;
    if (width < 1 || height < 1 || Math.max(width, height) > RENDITION_EDGE || width * height > RENDITION_PIXELS) {
      throw new Error('The image preview is invalid.');
    }
    const size = thumbnailSize(width, height);
    const bitmap = await createImageBitmap(rendition, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'high',
    });
    try {
      if (signal.aborted) throw abortError();
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return { blob: await encoded(canvas), width, height };
    } finally {
      bitmap.close();
    }
  } finally {
    rendition.close();
  }
}

function discard(entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  const queued = queue.indexOf(entry);
  if (queued >= 0) queue.splice(queued, 1);
  entry.controller.abort();
  if (entry.shown) URL.revokeObjectURL(entry.shown.url);
}

// Evict the least recently used settled thumbnails no message shows until one more fits; false when none can go.
function makeRoom() {
  const idle = [...entries.values()].filter((entry) => entry.pins === 0 && entry.settled).sort((a, b) => a.used - b.used);
  while (entries.size >= MAX_PREVIEWS && idle.length) discard(idle.shift());
  return entries.size < MAX_PREVIEWS;
}

function pump() {
  while (loading < MAX_LOADING && queue.length) {
    const entry = queue.shift();
    loading += 1;
    entry.start();
  }
}

function load(key, url, draw) {
  const controller = new AbortController();
  const entry = { key, controller, pins: 0, used: performance.now(), settled: false, shown: null, start: null, ready: null };
  const loadedIn = generation;
  entry.ready = new Promise((resolve, reject) => {
    entry.start = async () => {
      const limit = globalThis.setTimeout(() => controller.abort(), LOAD_LIMIT_MS);
      try {
        const { blob, width, height } = await draw(url, controller.signal);
        // A session check while it loaded drops it: nothing it drew is kept.
        if (loadedIn !== generation || controller.signal.aborted) throw abortError();
        entry.shown = { url: URL.createObjectURL(blob), width, height };
        resolve(entry.shown);
      } catch (error) {
        reject(error);
      } finally {
        globalThis.clearTimeout(limit);
        entry.settled = true;
        if (loadedIn === generation) {
          loading -= 1;
          pump();
        }
      }
    };
  });
  // A failed load is kept for the session, so the message keeps its card without asking Team again.
  entry.ready.catch(() => {});
  entries.set(key, entry);
  queue.push(entry);
  pump();
  return entry;
}

/** The session already shows MAX_PREVIEWS thumbnails: this one waits for one of them to leave, its image is fine. */
export class PreviewCapacityError extends Error {}

/**
 * Pin one sent image's thumbnail for a message that shows it: `cached` is the thumbnail at once when the session holds
 * it, and `ready` settles with `{ url, width, height }`, loading it first when it does not, or rejects, and the message
 * keeps its card. `release()` unpins it once the message no longer shows it. `draw(url, signal)` draws a thumbnail from
 * the rendition's URL (`drawThumbnail` by default).
 */
export function acquirePreview(teamId, fileId, draw = drawThumbnail) {
  const key = `${teamId}:${fileId}`;
  let entry = entries.get(key);
  if (!entry) {
    if (!makeRoom()) {
      return { cached: null, ready: Promise.reject(new PreviewCapacityError('Too many image previews are shown.')), release() {} };
    }
    entry = load(key, previewUrl(teamId, fileId), draw);
  }
  entry.pins += 1;
  entry.used = performance.now();
  let pinned = true;
  const held = entry;
  return {
    cached: held.shown,
    ready: held.ready,
    release() {
      if (!pinned) return;
      pinned = false;
      held.pins -= 1;
      held.used = performance.now();
      // A thumbnail no message waits for any more is not loaded at all.
      if (held.pins === 0 && !held.settled && queue.includes(held)) discard(held);
    },
  };
}

/** A session check: every thumbnail is revoked, every load waiting or under way dropped, and a late one discarded. */
export function clearPreviews() {
  generation += 1;
  for (const entry of [...entries.values()]) discard(entry);
  queue.length = 0;
  loading = 0;
}
