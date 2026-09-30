// Team Routines (ADR-0086) as the browser admits them. Each parser mirrors Team's closed protocol view and throws on
// any other shape; nothing here schedules or authorizes: a Routine exists only after a Supervisor confirms it.

export const MAX_QUOTE_CHARS = 500;
export const MAX_ASSISTANTS = 16;
export const PROPOSAL_SECONDS = 900;
const FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const ID_RE = /^[0-9a-f]{32}$/;
const ASSISTANT_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9_+-]{0,31}){0,2}$/;
const SCHEDULE_FIELDS = {
  hourly: ['kind', 'every'],
  daily: ['kind', 'time'],
  weekly: ['kind', 'weekday', 'time'],
  monthly: ['kind', 'day', 'time'],
};

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function whole(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high;
}

function invalid() {
  return new TypeError('invalid Routine proposal');
}

/** The user's quoted request: NFC, one line, trimmed, 1 to 500 characters. */
export function isQuote(value) {
  return (
    typeof value === 'string' &&
    [...value].length > 0 &&
    [...value].length <= MAX_QUOTE_CHARS &&
    value.normalize('NFC') === value &&
    value.trim() === value &&
    !FORBIDDEN_RE.test(value)
  );
}

/** The exact closed schedule, or false. */
export function isSchedule(value) {
  const fields = value && typeof value === 'object' ? SCHEDULE_FIELDS[value.kind] : undefined;
  if (!fields || !exact(value, fields)) return false;
  if (value.kind === 'hourly') return whole(value.every, 1, 24);
  return (
    typeof value.time === 'string' &&
    TIME_RE.test(value.time) &&
    (value.kind !== 'weekly' || whole(value.weekday, 0, 6)) &&
    (value.kind !== 'monthly' || whole(value.day, 1, 28))
  );
}

export function isTimezone(value) {
  return typeof value === 'string' && TIMEZONE_RE.test(value);
}

function isAssistants(value, minimum) {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= MAX_ASSISTANTS &&
    value.every((item) => typeof item === 'string' && ASSISTANT_ID_RE.test(item)) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

/** A chat turn's one-use Routine proposal for the confirmation card, or null when the turn proposed none. */
export function parseRoutineProposal(value) {
  if (value === null) return null;
  const keys = ['proposal_id', 'op', 'quote', 'schedule', 'timezone', 'routine_id', 'assistant_ids', 'expires_in'];
  if (!exact(value, keys) || typeof value.proposal_id !== 'string' || !ID_RE.test(value.proposal_id)) throw invalid();
  if (!isQuote(value.quote) || !whole(value.expires_in, 0, PROPOSAL_SECONDS)) throw invalid();
  const propose =
    value.op === 'propose' &&
    isSchedule(value.schedule) &&
    (value.timezone === null || isTimezone(value.timezone)) &&
    value.routine_id === null &&
    isAssistants(value.assistant_ids, 1);
  const cancel =
    value.op === 'cancel' &&
    value.schedule === null &&
    value.timezone === null &&
    typeof value.routine_id === 'string' &&
    ID_RE.test(value.routine_id) &&
    isAssistants(value.assistant_ids, 0);
  if (!propose && !cancel) throw invalid();
  return {
    proposal_id: value.proposal_id,
    op: value.op,
    quote: value.quote,
    schedule: value.schedule === null ? null : { ...value.schedule },
    timezone: value.timezone,
    routine_id: value.routine_id,
    assistant_ids: [...value.assistant_ids],
    expires_in: value.expires_in,
  };
}
