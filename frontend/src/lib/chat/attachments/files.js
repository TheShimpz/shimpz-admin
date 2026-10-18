// Chat attachments (ADR-0093): the composer's per-message admission, the browser's mirror of Team's readability rules,
// the bounded upload through Admin, and the closed shapes Team discloses about files.

import { exactKeys, jsonObject, LocalApiError } from '../../api.js';
import { codePointLength, CONTROL_RE } from '../../grammar.js';
import { OPAQUE_ID_RE, TEAM_ID_RE } from '../../ids.js';
import { numberFormat } from '../../i18n/formats.js';
import { socketReads } from '../../session/socket.js';

const KIB = 1024;
const MIB = 1024 * KIB;

// One message selects at most this many files, each within the upload bound and all within the message's original
// bytes (Team prepare/limits.py). Team reads at most four images and a bounded amount of text per message.
export const MAX_ATTACHMENTS = 8;
const MAX_UPLOAD_BYTES = 25 * MIB;
const MAX_MESSAGE_BYTES = 32 * MIB;
const MAX_MESSAGE_IMAGES = 4;
const MAX_MESSAGE_TEXT_CHARACTERS = 131_072;
const MAX_MESSAGE_TEXT_BYTES = 512 * KIB;
// The largest image Team reads, for the model or as a sent message's thumbnail.
export const MAX_IMAGE_BYTES = 8 * MIB;
export const MAX_PDF_BYTES = 8 * MIB;
export const MAX_TEXT_SOURCE_BYTES = 1 * MIB;
const MAX_TEXT_CHARACTERS = 32_768;
const MAX_TEXT_BYTES = 128 * KIB;
// The largest original an Action may receive, which an authorization challenge discloses (Assistant Spec v1).
const MAX_ACTION_FILE_BYTES = 8 * MIB;
const MAX_FILENAME_BYTES = 255;
const MAX_MEDIA_TYPE_CHARS = 127;

const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const encoder = new TextEncoder();

function startsWith(bytes, signature, offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function decodedText(bytes, final) {
  const body = startsWith(bytes, UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  if (body.length === 0) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body, { stream: !final });
    return TEXT_CONTROL_RE.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * What Team will read of one file, decided from its bytes exactly as Team decides (Team prepare/detect.py): a JPEG,
 * PNG, or WebP image, a PDF (its text only), UTF-8 text, or nothing. `note` is '' when the model reads it,
 * 'pdf-text' for a PDF it reads as text only, and 'unreadable' when it reaches the model as a name only. A corrupt
 * image or a PDF without text is decided only by Team.
 */
export async function attachmentReadability(file) {
  const prefix = new Uint8Array(await file.slice(0, MAX_TEXT_SOURCE_BYTES).arrayBuffer());
  const image = startsWith(prefix, [0xff, 0xd8, 0xff]) ||
    startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    (prefix.length >= 12 && startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) && startsWith(prefix, [0x57, 0x45, 0x42, 0x50], 8));
  if (image) return { kind: 'image', note: file.size > MAX_IMAGE_BYTES ? 'unreadable' : '' };
  if (startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: 'pdf', note: file.size > MAX_PDF_BYTES ? 'unreadable' : 'pdf-text' };
  }
  const final = file.size <= MAX_TEXT_SOURCE_BYTES;
  const text = decodedText(prefix, final);
  if (text === null) return { kind: 'file', note: 'unreadable' };
  const readable = final &&
    text.trim() !== '' &&
    codePointLength(text) <= MAX_TEXT_CHARACTERS &&
    encoder.encode(text).length <= MAX_TEXT_BYTES;
  return {
    kind: 'text',
    note: readable ? '' : 'unreadable',
    ...(readable ? { characters: codePointLength(text), bytes: encoder.encode(text).length } : {}),
  };
}

/**
 * Why one more file cannot join this message, or '' when it can. `selected` are the message's admitted attachments
 * and `candidate` is { size, kind, note, characters?, bytes? }.
 */
export function attachmentRefusal(selected, candidate) {
  if (selected.length >= MAX_ATTACHMENTS) return 'too-many';
  if (candidate.size < 1) return 'empty';
  if (candidate.size > MAX_UPLOAD_BYTES) return 'too-large';
  if (selected.reduce((total, item) => total + item.size, candidate.size) > MAX_MESSAGE_BYTES) return 'message-too-large';
  const readableImage = (item) => item.kind === 'image' && item.note === '';
  if (readableImage(candidate) && selected.filter(readableImage).length >= MAX_MESSAGE_IMAGES) return 'too-many-images';
  const texts = [...selected, candidate].filter((item) => item.kind === 'text' && item.note === '');
  if (
    texts.reduce((total, item) => total + (item.characters ?? 0), 0) > MAX_MESSAGE_TEXT_CHARACTERS ||
    texts.reduce((total, item) => total + (item.bytes ?? 0), 0) > MAX_MESSAGE_TEXT_BYTES
  ) return 'too-much-text';
  return '';
}

/** A file size in the interface language, in the largest unit that keeps it at or above one. */
export function formatFileSize(bytes, locale) {
  const units = [['byte', 1], ['kilobyte', KIB], ['megabyte', MIB]];
  const [unit, scale] = units.findLast(([, size]) => bytes >= size) ?? units[0];
  return numberFormat(locale, {
    style: 'unit',
    unit,
    // A byte count reads compactly (5 B); larger units keep their short names (1.5 kB, 3 MB).
    unitDisplay: unit === 'byte' ? 'narrow' : 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(bytes / scale);
}

/** The icon family for a file Team has not read yet, from the type the browser or Team reported. */
export function attachmentKind(mediaType) {
  if (typeof mediaType !== 'string') return 'file';
  if (/^image\/(?:jpeg|png|webp)$/.test(mediaType)) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return 'text';
  return 'file';
}

function canonicalFilename(value) {
  return typeof value === 'string' &&
    value !== '' &&
    value.trim() === value &&
    encoder.encode(value).length <= MAX_FILENAME_BYTES &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !CONTROL_RE.test(value);
}

function canonicalMediaType(value) {
  return typeof value === 'string' && value.length <= MAX_MEDIA_TYPE_CHARS && MEDIA_TYPE_RE.test(value);
}

function positiveSize(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

/**
 * The one file an authorization challenge discloses (Team challenge.canonical_file_disclosure): exactly the original
 * the approved Action receives, with any metadata embedded in it. Anything else fails closed.
 */
export function parseFileDisclosure(value) {
  if (
    !exactKeys(value, ['id', 'name', 'media_type', 'size', 'sha256']) ||
    typeof value.id !== 'string' ||
    !OPAQUE_ID_RE.test(value.id) ||
    !canonicalFilename(value.name) ||
    !canonicalMediaType(value.media_type) ||
    !positiveSize(value.size, MAX_ACTION_FILE_BYTES) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_RE.test(value.sha256)
  ) throw new LocalApiError('The local chat response is invalid.');
  return { id: value.id, name: value.name, media_type: value.media_type, size: value.size, sha256: value.sha256 };
}

/**
 * The files a saved user message carried, as Admin's history keeps them (history/store.py FILE_REFERENCE_KEYS): one to
 * eight distinct references, each only an id, literal name, media type, and size, never content. Anything else throws.
 */
export function parseFileReferences(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS) {
    throw new LocalApiError('The Team chat history is invalid.');
  }
  const references = value.map((item) => {
    if (
      !exactKeys(item, ['id', 'media_type', 'name', 'size']) ||
      typeof item.id !== 'string' ||
      !OPAQUE_ID_RE.test(item.id) ||
      !canonicalFilename(item.name) ||
      !canonicalMediaType(item.media_type) ||
      !positiveSize(item.size, MAX_UPLOAD_BYTES)
    ) throw new LocalApiError('The Team chat history is invalid.');
    return { id: item.id, name: item.name, media_type: item.media_type, size: item.size };
  });
  if (new Set(references.map((item) => item.id)).size !== references.length) {
    throw new LocalApiError('The Team chat history is invalid.');
  }
  return references;
}

// What a reply's Browser task did not keep, each with its closed reason (Team protocol browser.TERMINAL_LOSSES).
const BROWSER_LOSSES = new Set([
  'incomplete', 'over-limit', 'empty', 'quota-exceeded', 'name-refused', 'store-unavailable', 'browser-lost',
]);
const MAX_BROWSER_LOSSES = 128;
const MAX_BROWSER_SKIPPED = 1_000;

function browserLoss(item) {
  if (
    !exactKeys(item, ['name', 'reason']) ||
    typeof item.name !== 'string' ||
    item.name === '' ||
    encoder.encode(item.name).length > MAX_FILENAME_BYTES ||
    CONTROL_RE.test(item.name) ||
    !BROWSER_LOSSES.has(item.reason)
  ) throw new LocalApiError('The Team chat history is invalid.');
  return { name: item.name, reason: item.reason };
}

/**
 * A reply's `browser` field (Team protocol browser.canonical_terminal, ADR-0117 §7): the at most eight files its
 * Browser task kept, each a reference like a message's, the named files it did not keep with their reasons, and how
 * many it did not name. Anything else throws.
 */
export function parseBrowserTerminal(value) {
  if (
    !exactKeys(value, ['files', 'lost', 'skipped']) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_ATTACHMENTS ||
    !Array.isArray(value.lost) ||
    value.lost.length > MAX_BROWSER_LOSSES ||
    !Number.isSafeInteger(value.skipped) ||
    value.skipped < 0 ||
    value.skipped > MAX_BROWSER_SKIPPED
  ) throw new LocalApiError('The Team chat history is invalid.');
  return {
    files: value.files.length ? parseFileReferences(value.files) : [],
    lost: value.lost.map(browserLoss),
    skipped: value.skipped,
  };
}

/**
 * Record that the Supervisor accepts the risk of saving one file the Browser downloaded from the web: Team then
 * releases its original to them (ADR-0117 §7). Anything but Team's exact acknowledgement of that file throws.
 */
export async function acknowledgeWebFile(teamId, fileId, call = socketReads.call) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId) || typeof fileId !== 'string' || !OPAQUE_ID_RE.test(fileId)) {
    throw new LocalApiError('The file acknowledgement is invalid.');
  }
  const response = await call('files.acknowledge', { team_id: teamId, file_id: fileId });
  const body = await jsonObject(response);
  if (!response.ok || !exactKeys(body, ['file_id', 'acknowledged']) || body.file_id !== fileId || body.acknowledged !== true) {
    throw new LocalApiError('The file acknowledgement failed.', response.status);
  }
}

/** Why an upload failed, in the closed words the composer explains: quota, size, type, or anything else. */
function uploadFailure(status, body) {
  if (status === 507 || body?.code === 'storage-quota-exceeded') return 'quota';
  if (status === 413) return 'too-large';
  if ([400, 415, 422].includes(status)) return 'invalid';
  return 'failed';
}

export class AttachmentUploadError extends Error {
  constructor(reason) {
    super(`The attachment upload failed (${reason}).`);
    this.name = 'AttachmentUploadError';
    this.reason = reason;
  }
}

/**
 * Store one file in the Team through Admin, as the one `file` part its route admits, and return the metadata Team
 * kept. `signal` cancels it; an aborted upload rejects with the browser's AbortError.
 */
export async function uploadTeamFile(fetcher, teamId, file, signal) {
  if (typeof fetcher !== 'function' || typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new AttachmentUploadError('failed');
  }
  const form = new FormData();
  form.append('file', file, file.name);
  let response;
  try {
    response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/files`, {
      method: 'POST',
      body: form,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (reason) {
    if (signal?.aborted) throw reason;
    throw new AttachmentUploadError('failed');
  }
  const body = await jsonObject(response);
  if (!response.ok) throw new AttachmentUploadError(uploadFailure(response.status, body));
  const stored = body.file;
  if (
    !exactKeys(body, ['team_id', 'file', 'used_bytes', 'limit_bytes', 'remaining_bytes']) ||
    body.team_id !== teamId ||
    !exactKeys(stored, ['id', 'name', 'media_type', 'size', 'sha256', 'created_at']) ||
    typeof stored.id !== 'string' ||
    !OPAQUE_ID_RE.test(stored.id) ||
    !canonicalFilename(stored.name) ||
    !canonicalMediaType(stored.media_type) ||
    !positiveSize(stored.size, MAX_UPLOAD_BYTES) ||
    typeof stored.sha256 !== 'string' ||
    !SHA256_RE.test(stored.sha256)
  ) throw new AttachmentUploadError('failed');
  return { id: stored.id, name: stored.name, media_type: stored.media_type, size: stored.size };
}

/** The Admin route that downloads one stored file of a Team, always as an attachment. */
export function downloadUrl(teamId, fileId) {
  return `/api/teams/${teamId}/files/${fileId}/download`;
}

// A file's bytes Team is too busy to send now are asked for again after the delay it names, at most FILE_RETRIES times.
const FILE_RETRIES = 3;
const FILE_RETRY_LIMIT_MS = 2_000;
// How long a saved file's object URL outlives the save it started, so every browser has read it, and how many bytes of
// saved originals the page holds at once: a save that would go beyond them waits, in order, until earlier ones are let
// go. Every original fits the bound on its own.
const SAVED_URL_MS = 20_000;
const MAX_SAVED_BYTES = 64 * MIB;
let savedBytes = 0;
const waitingSaves = [];

function admitSave(size) {
  return new Promise((resolve) => {
    waitingSaves.push({ size, resolve });
    admitWaitingSaves();
  });
}

function admitWaitingSaves() {
  while (waitingSaves.length && savedBytes + waitingSaves[0].size <= MAX_SAVED_BYTES) {
    const next = waitingSaves.shift();
    savedBytes += next.size;
    next.resolve();
  }
}

function releaseSave(size) {
  savedBytes -= size;
  admitWaitingSaves();
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    // The abort listener leaves with the timer, so a signal that outlives many retries holds none of them.
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * One of a stored file's byte routes, read with the session from Admin's own page: the successful response, after
 * waiting out a busy Team's named delay at most FILE_RETRIES times, or an error.
 */
export async function fetchFileBytes(url, signal) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' });
    if (response.ok) return response;
    const retry = response.status === 503 ? (await response.json().catch(() => null))?.retry_after_ms : null;
    if (attempt >= FILE_RETRIES || !Number.isSafeInteger(retry) || retry < 1 || retry > FILE_RETRY_LIMIT_MS) {
      throw new Error('The file could not be read.');
    }
    await delay(retry, signal);
  }
}

/**
 * Save one stored file under its own name: its original is read through Admin's download route with the session, as
 * every browser sends that read alike, then handed to the browser to save.
 */
export async function saveFile(teamId, file) {
  const size = Math.min(Math.max(Number.isSafeInteger(file.size) ? file.size : MAX_UPLOAD_BYTES, 0), MAX_UPLOAD_BYTES);
  await admitSave(size);
  let url = null;
  try {
    const response = await fetchFileBytes(downloadUrl(teamId, file.id));
    url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
  } finally {
    // The save's slot, and its original, are let go together once the browser had time to read it.
    const held = url;
    globalThis.setTimeout(() => {
      if (held) URL.revokeObjectURL(held);
      releaseSave(size);
    }, held ? SAVED_URL_MS : 0);
  }
}
