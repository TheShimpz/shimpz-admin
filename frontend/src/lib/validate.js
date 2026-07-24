export const TEAM_ID_RE = /^[a-z0-9_]{1,40}$/;
export const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const OPAQUE_ID_RE = /^[0-9a-f]{32}$/;
export const TRACE_ID_RE = OPAQUE_ID_RE;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const MAX_TEAM_NAME_CHARS = 80;

export class LocalApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
  }
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
    value.length > MAX_TEAM_NAME_CHARS ||
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError(message);
  }
  return value;
}
