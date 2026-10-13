// How Admin's answers are admitted: the one error a refused or invalid answer becomes, the JSON body, exact key sets with
// Team's optional trace id, and the safe public message an answer may carry.
import { TRACE_ID_RE } from './ids.js';

// Team's closed refusal of a fresh install beyond the Team's MAX_TEAM_ASSISTANTS (HTTP 409); Admin localizes it.
export const ASSISTANT_LIMIT_REACHED = 'assistant_limit_reached';

export class LocalApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'LocalApiError';
    this.status = status;
    this.code = code;
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

/** Exactly `keys`, and Team's trace id beside them only when it is one. */
export function exactEnvelope(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const traced = 'trace_id' in value;
  return exactKeys(value, traced ? [...keys, 'trace_id'] : keys) &&
    (!traced || (typeof value.trace_id === 'string' && TRACE_ID_RE.test(value.trace_id)));
}

export function safeApiError(body, fallback) {
  const candidate = body?.error ?? body?.detail;
  return typeof candidate === 'string' && candidate.length <= 300 ? candidate : fallback;
}

export function publicError(error, fallback) {
  if (error instanceof LocalApiError && error.message && error.message.length <= 300) return error;
  return new LocalApiError(fallback);
}
