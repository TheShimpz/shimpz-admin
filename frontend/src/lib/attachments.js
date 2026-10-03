// Chat attachments (ADR-0093): the composer's per-message admission, the browser's mirror of Team's readability rules,
// the bounded upload through Admin, and the closed shapes Team discloses about files and withheld Actions.
import { LocalApiError } from './localApi.js';
import { ASSISTANT_ID_RE, codePointLength, exactKeys, jsonObject, OPAQUE_ID_RE, TEAM_ID_RE } from './validate.js';

const KIB = 1024;
const MIB = 1024 * KIB;

// One message selects at most this many files, each within the upload bound and all within the message's original
// bytes (Team prepare/limits.py). Team reads at most four images and a bounded amount of text per message.
export const MAX_ATTACHMENTS = 8;
export const MAX_UPLOAD_BYTES = 25 * MIB;
export const MAX_MESSAGE_BYTES = 32 * MIB;
export const MAX_MESSAGE_IMAGES = 4;
const MAX_MESSAGE_TEXT_CHARACTERS = 131_072;
const MAX_MESSAGE_TEXT_BYTES = 512 * KIB;
const MAX_IMAGE_BYTES = 8 * MIB;
const MAX_PDF_BYTES = 8 * MIB;
const MAX_TEXT_SOURCE_BYTES = 1 * MIB;
const MAX_TEXT_CHARACTERS = 32_768;
const MAX_TEXT_BYTES = 128 * KIB;
// The largest original an Action may receive, which an authorization challenge discloses (Assistant Spec v1).
const MAX_ACTION_FILE_BYTES = 8 * MIB;
const MAX_FILENAME_BYTES = 255;
const MAX_MEDIA_TYPE_CHARS = 127;
const MAX_RESTRICTED_ACTIONS = 16;
const MAX_RESTRICTED_ACTION_TOTAL = 2048;
const MAX_RESTRICTED_ACTIONS_BYTES = 2048;

const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILENAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;
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
  return new Intl.NumberFormat(locale, {
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
    !FILENAME_CONTROL_RE.test(value);
}

function canonicalMediaType(value) {
  return typeof value === 'string' && value.length <= MAX_MEDIA_TYPE_CHARS && MEDIA_TYPE_RE.test(value);
}

function positiveSize(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

/**
 * The one file an authorization challenge discloses (Team payload.canonical_file_disclosure): exactly the original
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
 * The Actions a completed turn withheld because readable attachment content was in it (Team
 * payload.canonical_restricted_actions): 1 to 16 distinct identities in identity order and the turn's total. It names
 * capabilities only and grants nothing.
 */
export function parseRestrictedActions(value) {
  if (
    !exactKeys(value, ['actions', 'total']) ||
    !Array.isArray(value.actions) ||
    value.actions.length < 1 ||
    value.actions.length > MAX_RESTRICTED_ACTIONS ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.actions.length ||
    value.total > MAX_RESTRICTED_ACTION_TOTAL
  ) throw new LocalApiError('The local chat response is invalid.');
  const actions = value.actions.map((item) => {
    if (
      !exactKeys(item, ['assistant', 'action']) ||
      typeof item.assistant !== 'string' ||
      item.assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(item.assistant) ||
      typeof item.action !== 'string' ||
      item.action.length > 128 ||
      !ACTION_ID_RE.test(item.action)
    ) throw new LocalApiError('The local chat response is invalid.');
    return { assistant: item.assistant, action: item.action };
  });
  const ordered = actions.every((item, index) => {
    if (index === 0) return true;
    const previous = actions[index - 1];
    return previous.assistant < item.assistant || (previous.assistant === item.assistant && previous.action < item.action);
  });
  const projected = { actions, total: value.total };
  if (!ordered || encoder.encode(JSON.stringify(projected)).length > MAX_RESTRICTED_ACTIONS_BYTES) {
    throw new LocalApiError('The local chat response is invalid.');
  }
  return projected;
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

/** A readable name for an Action or Assistant identifier that has no reviewed display name here. */
export function identifierName(value) {
  if (typeof value !== 'string') return '';
  return value.split(/[-._]/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}
