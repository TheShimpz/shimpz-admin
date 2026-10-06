export const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
// The Team HTTP protocol's identifiers (teams protocol/http/v1/identifiers.py), pinned by the Admin parity test: an
// Assistant id and an Integration, provider, or Stored Input identifier share the Developers grammar with two bounds,
// and an Action id has Team's wider grammar.
export const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_ASSISTANT_ID_CHARS = 40;
export const MAX_IDENTIFIER_CHARS = 64;
export const MAX_ACTION_ID_CHARS = 128;
export const OPAQUE_ID_RE = /^[0-9a-f]{32}$/;
export const TRACE_ID_RE = OPAQUE_ID_RE;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const MAX_TEAM_NAME_CHARS = 80;

export function isAssistantId(value) {
  return typeof value === 'string' && value.length <= MAX_ASSISTANT_ID_CHARS && ASSISTANT_ID_RE.test(value);
}

/** An Integration, provider, or Stored Input identifier. */
export function isIdentifier(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTIFIER_CHARS && ASSISTANT_ID_RE.test(value);
}

export function isActionId(value) {
  return typeof value === 'string' && value.length <= MAX_ACTION_ID_CHARS && ACTION_ID_RE.test(value);
}

/** Producers bound text in Unicode code points (Python len(), JSON Schema maxLength), not UTF-16 code units. */
export function codePointLength(value) {
  return [...value].length;
}

export class LocalApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
    this.code = code;
  }
}

/** A real UTC instant in whole seconds, written YYYY-MM-DDTHH:MM:SSZ. */
export function isInstant(value) {
  // Date.parse rolls impossible dates such as February 30 forward, so the instant must round-trip exactly.
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().replace('.000Z', 'Z') === value;
}

export async function jsonObject(response) {
  const body = await response.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

export function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')) return false;
  actual.sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function publicError(error, fallback) {
  if (error instanceof LocalApiError && error.message && error.message.length <= 300) return error;
  return new LocalApiError(fallback);
}

export function canonicalTeamName(value, message = 'The local Team inventory is invalid.') {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    codePointLength(value) > MAX_TEAM_NAME_CHARS ||
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError(message);
  }
  return value;
}
