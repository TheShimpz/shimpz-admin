// Team Routines (ADR-0086, ADR-0092) as the browser admits them. Each parser mirrors Team's closed protocol view and
// throws on any other shape; nothing here schedules or authorizes: Team creates a Routine from the user's own message.

import { clockTime } from './chatDays.js';
import { isLocale } from './locales.js';
import { codePointLength, isInstant, jsonObject, TEAM_ID_RE } from './validate.js';

const ENCODER = new TextEncoder();

export const MAX_QUOTE_CHARS = 500;
export const MAX_ASSISTANTS = 16;
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
  continuous: ['kind', 'gap', 'cap'],
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
  if (value.kind === 'continuous') {
    return whole(value.gap, MIN_CONTINUOUS_GAP_SECONDS, MAX_CONTINUOUS_GAP_SECONDS) && whole(value.cap, 1, MAX_DAILY_RUNS);
  }
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

const NONCE_RE = /^[0-9a-f]{32}$/;
const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_ROUTINES = 8;
// The unresolved incidents a Team holds at most (ADR-0092); each settles through its recovery card.
export const MAX_INCIDENTS = 32;
// A Team's rolling-24-hour run ceiling, which also bounds one continuous Routine's cap (ADR-0092).
export const MAX_DAILY_RUNS = 1000;
export const MIN_CONTINUOUS_GAP_SECONDS = 5;
export const MAX_CONTINUOUS_GAP_SECONDS = 86400;
export const MAX_ROLLUP_RUNS = 60 / MIN_CONTINUOUS_GAP_SECONDS;

/** A failed Routine request, named by the safe code Admin forwards. */
export class RoutineError extends Error {
  constructor(code, status = 0, retryAfter = 0) {
    super(code);
    this.name = 'RoutineError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function view(value, keys, valid) {
  if (!exact(value, keys) || !valid(value)) throw new RoutineError('routine-response-invalid');
  return structuredClone(value);
}

/** One confirmed Routine as a Supervisor sees it. */
export function parseRoutineView(value) {
  const keys = [
    'routine_id', 'name', 'quote', 'plan', 'output', 'schedule', 'timezone', 'assistant_ids', 'next_run_at',
    'needs_reconfirm', 'deleting', 'paused',
  ];
  return view(value, keys, (item) =>
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isName(item.name) &&
    isSummary(item.plan) &&
    isDisposition(item.output, item.plan.steps) &&
    isQuote(item.quote) &&
    isSchedule(item.schedule) &&
    isTimezone(item.timezone) &&
    isAssistants(item.assistant_ids, 1) &&
    isInstant(item.next_run_at) &&
    typeof item.needs_reconfirm === 'boolean' &&
    typeof item.deleting === 'boolean' &&
    typeof item.paused === 'boolean');
}

// A Routine plan's safe projection, mirroring Team's `routine.canonical_step` (ADR-0092): each step's Action, every
// input's source with a bounded literal preview, and the Stored Inputs its Action uses by name only. On the wire a step
// is named by its 1-based position in its revision's plan, and a reference names the earlier step it selects from by
// position (ADR-0092 amendment, 2026-10-05, scale).
export const MAX_ROUTINE_STEPS = 256;
const MAX_PREVIEW_CHARS = 120;
const MAX_STEP_INPUTS = 64;
const MAX_STEP_STORED_INPUTS = 8;
const MAX_STEP_VIEW_BYTES = 24 * 1024;
// A page holds whole consecutive steps: at most this many and this many encoded bytes.
const MAX_PAGE_STEPS = 64;
const MAX_PAGE_BYTES = 96 * 1024;
// A plan summary names its Actions as runs of consecutive equal Actions, at most this many.
const MAX_SUMMARY_RUNS = 16;
const PLAN_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const POINTER_RE = /^(?:\/(?:[^/~]|~[01])*)*$/;
const CLOCK_FORMATS = ['date', 'time', 'datetime', 'epoch_seconds'];
const PLAN_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const INPUT_KEYS = {
  literal: ['member', 'source', 'value'],
  run_clock: ['member', 'source', 'value'],
  step_output: ['member', 'source', 'step', 'pointer'],
  step_text: ['member', 'source', 'step', 'pointer'],
};

function plain(value, maximum) {
  return typeof value === 'string' && value.length > 0 && codePointLength(value) <= maximum && !PLAN_UNSAFE_RE.test(value);
}

/** Whether a value is a 1-based step position no greater than `maximum`. */
function isPosition(value, maximum = MAX_ROUTINE_STEPS) {
  return whole(value, 1, maximum);
}

function encodedBytes(value) {
  return ENCODER.encode(JSON.stringify(value)).length;
}

// Members in strictly ascending order, each once.
function sortedMembers(items) {
  const members = items.map((item) => item.member);
  return JSON.stringify(members) === JSON.stringify([...new Set(members)].sort());
}

function isInput(value, position) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? INPUT_KEYS[value.source] : undefined;
  if (!keys || !exact(value, keys) || !plain(value.member, 128)) return false;
  if (value.source === 'literal') return plain(value.value, MAX_PREVIEW_CHARS);
  if (value.source === 'run_clock') return CLOCK_FORMATS.includes(value.value);
  return isPosition(value.step, position - 1) && typeof value.pointer === 'string' &&
    codePointLength(value.pointer) <= 256 && POINTER_RE.test(value.pointer) && !PLAN_UNSAFE_RE.test(value.pointer);
}

/** Whether a value is one projected step at exactly `position`, referring only to earlier positions. */
export function isPlanStep(value, position) {
  if (!exact(value, ['position', 'assistant', 'action', 'inputs', 'stored_inputs'])) return false;
  const { inputs, stored_inputs: stored } = value;
  return (
    isPosition(position) &&
    value.position === position &&
    typeof value.assistant === 'string' && ASSISTANT_ID_RE.test(value.assistant) &&
    typeof value.action === 'string' && ACTION_ID_RE.test(value.action) &&
    Array.isArray(inputs) && inputs.length <= MAX_STEP_INPUTS && inputs.every((item) => isInput(item, position)) &&
    sortedMembers(inputs) &&
    Array.isArray(stored) && stored.length <= MAX_STEP_STORED_INPUTS &&
    stored.every((item) => typeof item === 'string' && ASSISTANT_ID_RE.test(item)) &&
    JSON.stringify(stored) === JSON.stringify([...new Set(stored)].sort()) &&
    encodedBytes(value) <= MAX_STEP_VIEW_BYTES
  );
}

/**
 * Whether a value is a revision's plan summary, mirroring Team's `routine.canonical_summary`: its revision and digest,
 * its step count, and its Actions as runs of consecutive equal `[assistant, action, count]` that cover the first steps
 * in order; `more` counts the steps after the sixteenth run.
 */
export function isSummary(value) {
  if (!exact(value, ['revision', 'plan_digest', 'steps', 'actions', 'more'])) return false;
  const { actions: runs, more, steps: total } = value;
  return (
    whole(value.revision, 1, 2 ** 31 - 1) &&
    typeof value.plan_digest === 'string' && PLAN_DIGEST_RE.test(value.plan_digest) &&
    isPosition(total) &&
    Array.isArray(runs) && runs.length > 0 && runs.length <= MAX_SUMMARY_RUNS &&
    runs.every((run) => Array.isArray(run) && run.length === 3 &&
      typeof run[0] === 'string' && ASSISTANT_ID_RE.test(run[0]) &&
      typeof run[1] === 'string' && ACTION_ID_RE.test(run[1]) &&
      isPosition(run[2])) &&
    runs.every((run, index) => index === 0 || run[0] !== runs[index - 1][0] || run[1] !== runs[index - 1][1]) &&
    Number.isInteger(more) && more >= 0 && (more === 0 || runs.length === MAX_SUMMARY_RUNS) &&
    runs.reduce((sum, run) => sum + run[2], 0) + more === total
  );
}

// Whole consecutive items from `offset` of `total`, each admitted at its own position, and the next offset or null.
function isPageOf(value, admit) {
  const { total, offset, steps, next } = value;
  return (
    isPosition(total) &&
    Number.isInteger(offset) && offset >= 0 && offset < total &&
    Array.isArray(steps) && steps.length > 0 && steps.length <= Math.min(MAX_PAGE_STEPS, total - offset) &&
    steps.every((step, index) => admit(step, offset + index + 1)) &&
    next === (offset + steps.length === total ? null : offset + steps.length) &&
    encodedBytes(steps) <= MAX_PAGE_BYTES
  );
}

function revisionPath(value) {
  if (!whole(value, 1, 2 ** 31 - 1)) throw new RoutineError('routine-request-invalid');
  return String(value);
}

function offsetPath(value) {
  if (!whole(value, 0, MAX_ROUTINE_STEPS - 1)) throw new RoutineError('routine-request-invalid');
  return String(value);
}

// A page that projects exactly the revision a plan summary names: its revision, digest, and step count.
function ofPlan(page, plan) {
  return page.revision === plan.revision && page.plan_digest === plan.plan_digest && page.total === plan.steps;
}

/**
 * One page of a Routine revision's steps from `offset`, admitted only for exactly the Routine, the revision its `plan`
 * summary names, and the offset asked for. Team refuses a revision that is no longer current
 * (`routine-revision-changed`), so pages of two revisions are never combined.
 */
export async function readPlanSteps(fetcher, teamId, routineId, plan, offset) {
  if (!isSummary(plan)) throw new RoutineError('routine-request-invalid');
  const path = `/${opaque(routineId)}/revisions/${revisionPath(plan.revision)}/steps/${offsetPath(offset)}`;
  const body = await request(fetcher, teamPath(teamId, path));
  return view(body, ['routine_id', 'revision', 'plan_digest', 'total', 'offset', 'steps', 'next'], (item) =>
    item.routine_id === routineId && ofPlan(item, plan) && item.offset === offset && isPageOf(item, isPlanStep));
}

// What one run did, step by step (ADR-0092 amendment, 2026-10-05, scale), mirroring Team's `routine.canonical_run_step`:
// a recorded step's status, Action, attempt, duration, instant, and its inputs as redacted previews, or a gap.
// `stopped`: Stop or the run's deadline cut the attempt, which says nothing about whether the Action acted.
const RUN_STEP_STATUSES = ['done', 'recovered', 'failed', 'stopped', 'waiting'];
const RUN_STEP_GAPS = ['not_run', 'unavailable'];
const RUN_INPUT_SOURCES = ['literal', 'run_clock', 'step_output', 'step_text'];
const RUN_STEP_KEYS = ['position', 'status', 'assistant_id', 'action', 'attempt', 'duration_ms', 'recorded_at', 'inputs'];
const SNAPSHOT_RE = /^[0-9a-f]{32}$/;

function isRunInput(value) {
  return exact(value, ['member', 'source', 'value']) && plain(value.member, 128) &&
    RUN_INPUT_SOURCES.includes(value.source) && (value.value === null || plain(value.value, MAX_PREVIEW_CHARS));
}

/** Whether a value is one run step at exactly `position`: what its attempt did, or only that it never ran or is gone. */
export function isRunStep(value, position) {
  if (!exact(value, RUN_STEP_KEYS) || !isPosition(position) || value.position !== position) return false;
  if (RUN_STEP_GAPS.includes(value.status)) {
    return RUN_STEP_KEYS.slice(2).every((key) => value[key] === null);
  }
  const duration = value.duration_ms;
  return (
    RUN_STEP_STATUSES.includes(value.status) &&
    typeof value.assistant_id === 'string' && ASSISTANT_ID_RE.test(value.assistant_id) &&
    typeof value.action === 'string' && ACTION_ID_RE.test(value.action) &&
    whole(value.attempt, 1, MAX_DIAGNOSTIC_ATTEMPTS) &&
    (duration === null || (Number.isSafeInteger(duration) && duration >= 0)) &&
    (value.status !== 'recovered' || duration === null) &&
    isInstant(value.recorded_at) &&
    (value.inputs === null || (Array.isArray(value.inputs) && value.inputs.length <= MAX_STEP_INPUTS &&
      value.inputs.every(isRunInput) && sortedMembers(value.inputs))) &&
    encodedBytes(value) <= MAX_STEP_VIEW_BYTES
  );
}

/**
 * One page of what a run did from `offset`, bound to the revision its notice's `plan` summary names and to one
 * `snapshot` of its retained records. `latest` asks for the current snapshot, which the page names; any other page is
 * admitted only for exactly that snapshot, and Team refuses one whose records changed since (`routine-run-changed`).
 */
export async function readRunSteps(fetcher, teamId, runId, plan, snapshot, offset) {
  if (!isSummary(plan) || (snapshot !== 'latest' && (typeof snapshot !== 'string' || !SNAPSHOT_RE.test(snapshot)))) {
    throw new RoutineError('routine-request-invalid');
  }
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/steps/${snapshot}/${offsetPath(offset)}`));
  const keys = ['team_id', 'run_id', 'routine_id', 'revision', 'plan_digest', 'total', 'snapshot', 'ended', 'offset', 'steps', 'next'];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    typeof item.routine_id === 'string' && ID_RE.test(item.routine_id) &&
    ofPlan(item, plan) &&
    typeof item.snapshot === 'string' && SNAPSHOT_RE.test(item.snapshot) &&
    (snapshot === 'latest' || item.snapshot === snapshot) &&
    typeof item.ended === 'boolean' &&
    item.offset === offset &&
    isPageOf(item, isRunStep));
}

/**
 * Whether a page reader must read the next page before it can reveal `wanted` steps: fewer are loaded and Team named a
 * next offset.
 */
export function needsPage(loaded, wanted, next) {
  return loaded < wanted && next !== null;
}

// What a completed run does with its result (ADR-0092 amendment, 2026-10-05, output), mirroring Team's
// `routine.canonical_disposition` and `routine.canonical_output`: show one step's result after every run, only when it
// changed, hand it on, or show nothing; and a shown result as Team's bounded, redacted, ordered projection.
const OUTPUT_MODES = ['show', 'changes', 'chain', 'none'];
const SHOWN_MODES = ['show', 'changes'];
const OUTPUT_STATES = ['shown', 'unchanged', 'unavailable'];
const MAX_OUTPUT_DEPTH = 4;
const MAX_OUTPUT_ITEMS = 50;
const MAX_OUTPUT_FIELDS = 24;
const MAX_OUTPUT_TEXT_CHARS = 300;
const MAX_OUTPUT_KEY_CHARS = 64;
const MAX_OUTPUT_BYTES = 16 * 1024;
// A number is its exact JSON text, so the browser never rounds it.
const MAX_OUTPUT_NUMBER_CHARS = 64;
const OUTPUT_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const SCALAR_NODES = {
  null: (node) => exact(node, ['kind']),
  redacted: (node) => exact(node, ['kind']),
  elided: (node) => exact(node, ['kind']),
  bool: (node) => exact(node, ['kind', 'value']) && typeof node.value === 'boolean',
  number: (node) =>
    exact(node, ['kind', 'value']) &&
    typeof node.value === 'string' &&
    node.value.length <= MAX_OUTPUT_NUMBER_CHARS &&
    OUTPUT_NUMBER_RE.test(node.value),
  text: (node) =>
    exact(node, ['kind', 'value', 'cut']) &&
    typeof node.cut === 'boolean' &&
    typeof node.value === 'string' &&
    codePointLength(node.value) <= MAX_OUTPUT_TEXT_CHARS &&
    !PLAN_UNSAFE_RE.test(node.value),
};

/** Whether a plan's output disposition is closed and names one of its `total` steps' positions when it shows one. */
export function isDisposition(value, total) {
  if (!exact(value, ['mode', 'step']) || !OUTPUT_MODES.includes(value.mode) || !isPosition(total)) return false;
  if (!SHOWN_MODES.includes(value.mode)) return value.step === null;
  return isPosition(value.step, total);
}

function isOutputNode(node, depth) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  if (node.kind !== 'list' && node.kind !== 'fields') {
    return typeof node.kind === 'string' && Object.hasOwn(SCALAR_NODES, node.kind) && SCALAR_NODES[node.kind](node);
  }
  if (depth >= MAX_OUTPUT_DEPTH || !Number.isInteger(node.omitted) || node.omitted < 0) return false;
  if (node.kind === 'list') {
    return exact(node, ['kind', 'items', 'omitted']) && Array.isArray(node.items) &&
      node.items.length <= MAX_OUTPUT_ITEMS && node.items.every((item) => isOutputNode(item, depth + 1));
  }
  return exact(node, ['kind', 'fields', 'omitted']) && Array.isArray(node.fields) &&
    node.fields.length <= MAX_OUTPUT_FIELDS &&
    node.fields.every((field) => Array.isArray(field) && field.length === 2 && plain(field[0], MAX_OUTPUT_KEY_CHARS) &&
      isOutputNode(field[1], depth + 1)) &&
    new Set(node.fields.map((field) => field[0])).size === node.fields.length;
}

/** Whether a completed run's output is Team's closed form: a shown projection, or unchanged or unavailable alone. */
export function isOutput(value) {
  if (!exact(value, ['step', 'state', 'value', 'truncated'])) return false;
  const valid =
    isPosition(value.step) &&
    OUTPUT_STATES.includes(value.state) &&
    typeof value.truncated === 'boolean' &&
    (value.state === 'shown' ? isOutputNode(value.value, 0) : value.value === null && value.truncated === false);
  return valid && encodedBytes(value) <= MAX_OUTPUT_BYTES;
}

function isActions(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ASSISTANTS &&
    value.every((pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === 'string' &&
      ASSISTANT_ID_RE.test(pair[0]) &&
      typeof pair[1] === 'string' &&
      ACTION_ID_RE.test(pair[1]))
  );
}

/** One live run: a frozen run names its request; a leased or held one only that it is live. */
export function parseRunView(value) {
  const keys = ['run_id', 'routine_id', 'status', 'scheduled_at', 'request_kind', 'assistant_id', 'action'];
  return view(value, keys, (item) => {
    const request = [item.request_kind, item.assistant_id, item.action];
    const frozen =
      ['human', 'integrations'].includes(item.request_kind) &&
      typeof item.assistant_id === 'string' &&
      ASSISTANT_ID_RE.test(item.assistant_id) &&
      typeof item.action === 'string' &&
      ACTION_ID_RE.test(item.action);
    return (
      typeof item.run_id === 'string' &&
      ID_RE.test(item.run_id) &&
      typeof item.routine_id === 'string' &&
      ID_RE.test(item.routine_id) &&
      isInstant(item.scheduled_at) &&
      ['leased', 'frozen', 'held'].includes(item.status) &&
      (item.status === 'frozen' ? frozen : request.every((part) => part === null))
    );
  });
}

// A step's 1-based position among its plan's `steps`, which names a repeated Action exactly.
function isPlaced(step, steps) {
  return isPosition(steps) && isPosition(step, steps);
}

// The step a held run stopped at and its position, or all null when it sealed no plan before it was held.
function isHeldStep(detail) {
  if (detail.assistant_id === null) return detail.action === null && detail.step === null && detail.steps === null;
  return typeof detail.assistant_id === 'string' && ASSISTANT_ID_RE.test(detail.assistant_id) &&
    typeof detail.action === 'string' && ACTION_ID_RE.test(detail.action) && isPlaced(detail.step, detail.steps);
}

/** One unresolved incident of a held run, which outlives a deleted Routine (ADR-0092). */
export function parseIncidentView(value) {
  const keys = ['incident_id', 'routine_id', 'quote', 'created_at', 'assistant_id', 'action', 'step', 'steps'];
  return view(value, keys, (item) =>
    typeof item.incident_id === 'string' &&
    ID_RE.test(item.incident_id) &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isQuote(item.quote) &&
    isInstant(item.created_at) &&
    isHeldStep(item));
}

async function request(fetcher, path, init = {}) {
  if (typeof fetcher !== 'function') throw new RoutineError('routine-request-invalid');
  const response = await fetcher(path, {
    cache: 'no-store',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    const code = typeof body.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(body.code) ? body.code : 'routine-request-failed';
    const retryAfter = Number.isInteger(body.retry_after) && body.retry_after > 0 && body.retry_after <= 3600 ? body.retry_after : 0;
    throw new RoutineError(code, response.status, retryAfter);
  }
  return body;
}

function teamPath(teamId, suffix = '') {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new RoutineError('routine-request-invalid');
  return `/api/teams/${encodeURIComponent(teamId)}/routines${suffix}`;
}

function opaque(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new RoutineError('routine-request-invalid');
  return value;
}

/** The browser's IANA timezone, the default zone of a Routine a chat message creates, or null when it is unknown. */
export function browserTimezone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimezone(zone) ? zone : null;
}

function deleted(body, teamId, routineId = null) {
  if (
    !exact(body, ['team_id', 'routine_id', 'deleted']) ||
    body.team_id !== teamId ||
    typeof body.deleted !== 'boolean' ||
    typeof body.routine_id !== 'string' ||
    !ID_RE.test(body.routine_id) ||
    (routineId !== null && body.routine_id !== routineId)
  ) {
    throw new RoutineError('routine-response-invalid');
  }
  return { deleted: body.deleted };
}

export async function listRoutines(fetcher, teamId) {
  const body = await request(fetcher, teamPath(teamId));
  if (
    !exact(body, ['team_id', 'routines', 'runs', 'incidents']) ||
    body.team_id !== teamId ||
    !Array.isArray(body.routines) ||
    !Array.isArray(body.runs) ||
    !Array.isArray(body.incidents) ||
    body.routines.length > MAX_ROUTINES ||
    body.runs.length > MAX_ROUTINES ||
    body.incidents.length > MAX_INCIDENTS
  ) throw new RoutineError('routine-response-invalid');
  return {
    routines: body.routines.map(parseRoutineView),
    runs: body.runs.map(parseRunView),
    incidents: body.incidents.map(parseIncidentView),
  };
}

/**
 * Deleting a Routine starts with the Supervisor password (ADR-0051). Admin answers with the second factors it accepts
 * for this one Routine: always `totp`, and `passkey` with its options when this address has one.
 */
export async function beginRoutineDeletion(fetcher, teamId, routineId, password) {
  if (typeof password !== 'string' || password.length < 1) throw new RoutineError('routine-request-invalid');
  const body = await request(fetcher, teamPath(teamId, `/${opaque(routineId)}/deletion`), {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  const methods = body.methods;
  const passkey = Array.isArray(methods) && methods.length === 2 && methods[0] === 'totp' && methods[1] === 'passkey';
  const totpOnly = Array.isArray(methods) && methods.length === 1 && methods[0] === 'totp';
  if (totpOnly && exact(body, ['methods'])) return { passkey: null };
  if (passkey && exact(body, ['methods', 'passkey_options']) && body.passkey_options && typeof body.passkey_options === 'object') {
    return { passkey: body.passkey_options };
  }
  throw new RoutineError('routine-response-invalid');
}

/** Spend the started deletion on exactly one second factor, `{ code }` or `{ credential }`; Admin then asks Team. */
export async function deleteRoutine(fetcher, teamId, routineId, proof) {
  const byCode = exact(proof, ['code']) && /^[0-9]{6}$/.test(proof.code);
  const byPasskey = exact(proof, ['credential']) && proof.credential && typeof proof.credential === 'object';
  if (!byCode && !byPasskey) throw new RoutineError('routine-request-invalid');
  return deleted(
    await request(fetcher, teamPath(teamId, `/${opaque(routineId)}`), { method: 'DELETE', body: JSON.stringify(proof) }),
    teamId,
    routineId,
  );
}

async function decideRun(fetcher, teamId, runId, action, payload, result) {
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/${action}`), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!exact(body, ['team_id', 'run_id', result]) || body.team_id !== teamId || body.run_id !== runId || typeof body[result] !== 'boolean') {
    throw new RoutineError('routine-response-invalid');
  }
  return body[result];
}

export function stopRoutineRun(fetcher, teamId, runId) {
  return decideRun(fetcher, teamId, runId, 'stop', {}, 'stopped');
}

async function setPaused(fetcher, teamId, routineId, paused) {
  const body = await request(fetcher, teamPath(teamId, `/${opaque(routineId)}/${paused ? 'pause' : 'resume'}`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!exact(body, ['team_id', 'routine_id', 'paused']) || body.team_id !== teamId || body.routine_id !== routineId
    || body.paused !== paused) {
    throw new RoutineError('routine-response-invalid');
  }
  return paused;
}

/** Turn a paused Routine's dispatch back on; an unresolved incident still holds it until its card settles it. */
export function resumeRoutine(fetcher, teamId, routineId) {
  return setPaused(fetcher, teamId, routineId, false);
}

/** Turn a Routine's dispatch off until it is resumed; a run already going finishes. */
export function pauseRoutine(fetcher, teamId, routineId) {
  return setPaused(fetcher, teamId, routineId, true);
}

/**
 * How a listed Routine stands for the person, most urgent first: being deleted, held for recovery, waiting to be asked
 * again, paused, waiting for an approval, running now, or idle between runs (continuous or on its schedule).
 */
export function routineStatus(routine, runs = [], incidents = []) {
  const own = runs.filter((run) => run.routine_id === routine.routine_id);
  if (routine.deleting) return 'deleting';
  if (incidents.some((item) => item.routine_id === routine.routine_id) || own.some((run) => run.status === 'held')) {
    return 'recovery';
  }
  if (routine.needs_reconfirm) return 'reconfirm';
  if (routine.paused) return 'paused';
  if (own.some((run) => run.status === 'frozen')) return 'waiting';
  if (own.length) return 'running';
  return routine.schedule.kind === 'continuous' ? 'continuous' : 'healthy';
}

/**
 * The one word a Routine's status shows the person: it is running, paused, or failed. Waiting for an approval and
 * waiting to be asked again stop its dispatch, so they read as paused; a run held for recovery reads as failed. The
 * panel names the reason beside the word. A Routine being deleted shows no word.
 */
export const STATUS_WORDS = Object.freeze({
  healthy: 'running',
  continuous: 'running',
  running: 'running',
  paused: 'paused',
  waiting: 'paused',
  reconfirm: 'paused',
  recovery: 'failed',
});

/** Each status word's tag tone and icon: one border color per word, the same in every Routine surface. */
export const STATUS_TAGS = Object.freeze({
  running: { tone: 'accent', icon: 'activity' },
  paused: { tone: 'warning', icon: 'pause' },
  failed: { tone: 'danger', icon: 'warning' },
});

/** Statuses that need the person, shown in words beside the Routine. */
export const ATTENTION_STATUSES = Object.freeze(['deleting', 'recovery', 'reconfirm', 'paused', 'waiting']);

const ACRONYMS = new Set(['api', 'dns', 'http', 'id', 'ip', 'ssl', 'tls', 'url']);

/** A machine identifier as words: "list-dns-records" reads "List DNS records", "zone_id" reads "Zone ID". */
export function humanizeId(value) {
  const words = String(value).split(/[-_.]+/u).filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  if (words.length === 0) return String(value);
  const [first, ...rest] = words;
  return [first === first.toUpperCase() ? first : first[0].toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** A JSON Pointer into a step's result as words: "/zones/0/id" reads "zones › first › id". */
export function pointerWords(pointer, copy) {
  return pointer.split('/').slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((segment) => {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(segment)) return segment;
      const index = Number(segment);
      return index === 0 ? copy.first : fill(copy.item, { n: index + 1 });
    })
    .join(' › ');
}

/** A literal's preview as plain words: a JSON string reads without its quotes; anything else stays as Team showed it. */
export function literalWords(preview) {
  try {
    const value = JSON.parse(preview);
    return typeof value === 'string' ? value : preview;
  } catch {
    return preview;
  }
}

/** One plan input in words: a literal's preview, each run's clock, or a path into an earlier step's result. */
export function inputWords(input, copy) {
  if (input.source === 'literal') return literalWords(input.value);
  if (input.source === 'run_clock') return fill(copy.clock, { format: copy.clocks[input.value] });
  const n = input.step;
  const text = input.source === 'step_text';
  if (!input.pointer) return fill(text ? copy.fromStepTextWhole : copy.fromStepWhole, { n });
  return fill(text ? copy.fromStepText : copy.fromStep, { n, path: pointerWords(input.pointer, copy) });
}

// A held run's recovery card (ADR-0092 section 7, amended 2026-10-02): exactly Rodar, Recriar, and Excluir, in this
// order, none recommended. Team answers Rodar and Recriar; Excluir is the Routine's own confirmed deletion.
export const CARD_CHOICES = ['run', 'recreate', 'delete'];
export const CARD_ANSWERS = ['run', 'recreate'];
const CARD_STATUSES = { run: 'requested', recreate: 'recreated' };
const CARD_EVIDENCE = ['recorded', 'absent', 'unavailable'];

function isCardStep(item) {
  return isPlaced(item.step, item.steps);
}

// The held operation's latest diagnostic, exactly when Team recorded one, and only of the card's own step.
function isCardEvidence(item) {
  if (!CARD_EVIDENCE.includes(item.evidence) || (item.diagnostic === null) === (item.evidence === 'recorded')) {
    return false;
  }
  return item.diagnostic === null || (
    isDiagnostic(item.diagnostic) &&
    item.diagnostic.assistant_id === item.assistant_id &&
    item.diagnostic.action === item.action
  );
}

function parseCard(body, teamId, incidentId) {
  const keys = [
    'team_id', 'incident_id', 'routine_id', 'revision', 'assistant_id', 'action', 'step', 'steps', 'evidence',
    'diagnostic', 'nonce', 'expires_in', 'choices',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.incident_id === incidentId &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    Number.isInteger(item.revision) &&
    item.revision >= 1 &&
    typeof item.assistant_id === 'string' && ASSISTANT_ID_RE.test(item.assistant_id) &&
    typeof item.action === 'string' && ACTION_ID_RE.test(item.action) &&
    isCardStep(item) &&
    isCardEvidence(item) &&
    typeof item.nonce === 'string' &&
    NONCE_RE.test(item.nonce) &&
    item.expires_in === 300 &&
    Array.isArray(item.choices) &&
    item.choices.length === CARD_CHOICES.length &&
    CARD_CHOICES.every((choice, index) => item.choices[index] === choice));
}

/** Open a held run's recovery card for the signed-in person; its nonce answers it once within five minutes. */
export async function openRoutineCard(fetcher, teamId, incidentId) {
  const body = await request(fetcher, teamPath(teamId, `/incidents/${opaque(incidentId)}/card`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return parseCard(body, teamId, incidentId);
}

/** Answer an open card with Rodar or Recriar; returns what Team did. Excluir is the confirmed deletion instead. */
export async function answerRoutineCard(fetcher, teamId, incidentId, card, choice) {
  if (!CARD_ANSWERS.includes(choice) || typeof card?.nonce !== 'string' || !NONCE_RE.test(card.nonce)) {
    throw new RoutineError('routine-request-invalid');
  }
  const body = await request(fetcher, teamPath(teamId, `/incidents/${opaque(incidentId)}/answer`), {
    method: 'POST',
    body: JSON.stringify({ nonce: card.nonce, choice }),
  });
  return view(body, ['team_id', 'incident_id', 'choice', 'status'], (item) =>
    item.team_id === teamId &&
    item.incident_id === incidentId &&
    item.choice === choice &&
    item.status === CARD_STATUSES[choice]);
}

// Words that suggest what may have caused a failure, read only from Team's sanitized diagnostic. They choose the
// plain explanation shown beside the literal error, never anything Team does: a guess, phrased as a possible cause.
const CAUSE_WORDS = [
  ['credits', /\b(credits?|quota|billing|balance|insufficient[ _]funds|payment required|out of funds)\b/i],
  ['rateLimit', /\b(rate[ _-]?limit(ed)?|too many requests|throttl\w*)\b/i],
  ['auth', /\b(unauthori[sz]ed|forbidden|permission|access denied|authentication|invalid (api[ _-]?)?(key|token)|expired token)\b/i],
  ['timeout', /\b(timed? ?out|timeout|deadline exceeded)\b/i],
  ['notFound', /\b(not found|does not exist|no such|could not route)\b/i],
  ['invalid', /\b(invalid|validation|malformed|bad request|unprocessable)\b/i],
];
const CAUSE_STATUSES = { 402: 'credits', 429: 'rateLimit', 401: 'auth', 403: 'auth', 404: 'notFound', 410: 'notFound', 408: 'timeout', 504: 'timeout' };

/** The likely cause of a card's recorded failure, for its plain explanation; `unknown` when nothing suggests one. */
export function failureCause(diagnostic) {
  if (!diagnostic) return 'unknown';
  if (diagnostic.condition !== null) return diagnostic.condition === 'timeout' ? 'timeout' : 'assistant';
  const { error_type: type, message, http_status: status, response_excerpt: excerpt } = diagnostic.failure;
  const text = `${type} ${message} ${excerpt ?? ''}`;
  // Billing words outrank a status: providers report an exhausted balance as 402, 403, or 429 alike.
  if (CAUSE_WORDS[0][1].test(text)) return 'credits';
  if (status !== null && CAUSE_STATUSES[status]) return CAUSE_STATUSES[status];
  const matched = CAUSE_WORDS.find(([, words]) => words.test(text));
  if (matched) return matched[0];
  if (status === 400 || status === 422) return 'invalid';
  return status !== null && status >= 500 ? 'provider' : 'unknown';
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

// Weekday 0 is Monday in the Routine grammar.
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** A schedule in words for the viewer's locale; wall-clock times are in the Routine's own timezone. */
export function scheduleWords(schedule, copy, locale) {
  if (schedule.kind === 'hourly') {
    return schedule.every === 1 ? copy.hour : fill(copy.hours, { every: schedule.every });
  }
  if (schedule.kind === 'continuous') {
    return fill(copy.continuous, {
      gap: new Intl.NumberFormat(locale).format(schedule.gap),
      cap: new Intl.NumberFormat(locale).format(schedule.cap),
    });
  }
  if (schedule.kind === 'daily') return fill(copy.daily, { time: schedule.time });
  if (schedule.kind === 'weekly') {
    // Each locale names its weekdays itself, so the article agrees with the day ("Todo domingo", "Toda segunda-feira").
    return fill(copy.weekly, { weekday: copy.weekdays[WEEKDAYS[schedule.weekday]], time: schedule.time });
  }
  return fill(copy.monthly, { day: schedule.day, time: schedule.time });
}

/** A UTC instant shown in a Routine's timezone for the viewer's locale. */
export function instantWords(value, locale, timeZone) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

/** An instant as day/Month/year and a 24-hour clock to the second ("02/Outubro/2026 22:29:00") in a timezone. */
export function clockWords(value, locale, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat(locale, {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const month = parts.month.charAt(0).toLocaleUpperCase(locale) + parts.month.slice(1);
  return `${parts.day}/${month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** How far ahead an instant is, in the largest whole unit ("in 3 hours"); an instant already due has no words. */
export function untilWords(value, now, locale) {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  if (!(seconds > 0)) return '';
  const [unit, size] = [['day', 86_400], ['hour', 3_600], ['minute', 60], ['second', 1]].find(([, step]) => seconds >= step);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
}

/** A copy template as ordered parts, each value part keyed by its placeholder so it can be styled on its own. */
export function fillParts(template, values) {
  return template.split(/(\{\w+\})/u).filter(Boolean).map((part) => {
    const key = /^\{(\w+)\}$/u.exec(part)?.[1];
    return key && key in values ? { text: String(values[key]), key } : { text: part, key: '' };
  });
}

/** The time of day a minute starts, for the viewer's locale and timezone. */
export function minuteWords(value, locale) {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(value));
}

/** The localized message for a Routine failure code. */
export function routineErrorMessage(error, copy) {
  const code = error instanceof RoutineError ? error.code : '';
  const byCode = {
    'team-context-changed': copy.changed,
    // The run's request no longer renders against the Team's reviewed Assistant; it stays frozen (ADR-0091).
    'human-request-invalid': copy.changed,
    'assistant-language-drift': copy.unavailable,
    'routine-limit': copy.full,
    'routine-rate-limit': copy.full,
    // A Team's daily Action-step budget, or its whole definitions' budget, is full like its run ceiling.
    'routine-step-budget': copy.full,
    'routine-team-budget': copy.full,
    'routine-too-large': copy.tooLarge,
    // The Routine changed while its steps were read; it is read again, never mixed with the other revision.
    'routine-revision-changed': copy.routineChanged,
    'routine-run-changed': copy.stale,
    'routine-run-not-found': copy.ended,
    'routine-incident-unavailable': copy.ended,
    'routine-card-expired': copy.expired,
    'routine-card-stale': copy.stale,
    'routine-not-found': copy.ended,
    'routine-busy': copy.busy,
    'routine-workload-unquiesced': copy.stillRunning,
    'routine-contracts-changed': copy.contractsChanged,
    'routine-source-unavailable': copy.sourceUnavailable,
    'routine-recreate-refused': copy.recreateRefused,
    'routine-recreate-unavailable': copy.recreateUnavailable,
    'routine-recovery-stopped': copy.stopped,
    // The Team cannot hold one more change right now; nothing changed, and it frees up on its own.
    'routine-receipts-full': copy.unavailable,
    'notices-full': copy.unavailable,
    'model-credential-missing': copy.credentialMissing,
    'routine-state-unavailable': copy.unavailable,
    'team-context-unavailable': copy.unavailable,
  };
  return byCode[code] ?? copy.generic;
}

export { fill as fillRoutineCopy };

const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_NAME_CHARS = 80;
const PAUSE_REASONS = ['decided', 'unavailable', 'exhausted', 'policy', 'evidence'];

function closedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum && value.trim() === value;
}

// The summary of the plan a completed run carried out, never an input, and the result it shows, if any.
function isCompleted(detail) {
  return isSummary(detail.plan) &&
    (detail.output === null || (isOutput(detail.output) && detail.output.step <= detail.plan.steps));
}

// The step a failed run stopped at by position, or both null when it failed before any step.
function isFailedAt(detail) {
  return (detail.step === null && detail.steps === null) || isPlaced(detail.step, detail.steps);
}

const STEP_KEYS = ['assistant_id', 'action', 'step', 'steps'];

const NOTICE_DETAILS = {
  done: [['plan', 'output'], isCompleted],
  recovered: [['plan', 'output'], isCompleted],
  held: [STEP_KEYS, isHeldStep],
  paused: [[...STEP_KEYS, 'reason'], (detail) => isHeldStep(detail) && PAUSE_REASONS.includes(detail.reason)],
  // A person set the held run aside: Rodar, Recriar, or the deletion of its Routine.
  'user-skipped': [[...STEP_KEYS, 'choice'], (detail) => isHeldStep(detail) && CARD_CHOICES.includes(detail.choice)],
  skipped: [['missed'], (detail) => Number.isInteger(detail.missed) && detail.missed >= 1],
  healthy: [['runs'], (detail) => whole(detail.runs, 1, MAX_ROLLUP_RUNS)],
  'scope-changed': [['assistants'], (detail) => isAssistantList(detail.assistants)],
  frozen: [
    ['request_kind', ...STEP_KEYS],
    (detail) =>
      ['human', 'integrations'].includes(detail.request_kind) && detail.assistant_id !== null && isHeldStep(detail),
  ],
  failed: [
    ['code', 'actions', 'step', 'steps'],
    (detail) => typeof detail.code === 'string' && ERROR_CODE_RE.test(detail.code) && isActions(detail.actions) &&
      isFailedAt(detail),
  ],
  denied: [['actions'], (detail) => isActions(detail.actions)],
  stopped: [['actions'], (detail) => isActions(detail.actions)],
  created: [['name', 'plan', 'output', 'schedule', 'timezone'], isDefinition],
  changed: [['name', 'plan', 'output', 'schedule', 'timezone'], isDefinition],
};

// `healthy` rolls up a continuous Routine's healthy runs that ended in one minute (ADR-0092 section 9).
const ROUTINE_OUTCOMES = ['skipped', 'scope-changed', 'created', 'changed', 'healthy'];

function isName(value) {
  return closedText(value, MAX_NAME_CHARS) && !FORBIDDEN_RE.test(value) && value.normalize('NFC') === value;
}

function isDefinition(detail) {
  return isName(detail.name) && isSummary(detail.plan) && isDisposition(detail.output, detail.plan.steps) &&
    isSchedule(detail.schedule) && isTimezone(detail.timezone);
}

function isAssistantList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ASSISTANTS &&
    value.every((item) => typeof item === 'string' && ASSISTANT_ID_RE.test(item))
  );
}

/** One Routine outcome row of a Team's transcript (ADR-0086); a run's row is keyed by its run id. */
export function parseRoutineRunEntry(value) {
  const keys = ['id', 'kind', 'notice_id', 'routine_id', 'quote', 'run_id', 'outcome', 'created_at', 'detail', 'version'];
  const rule = value && typeof value === 'object' ? NOTICE_DETAILS[value.outcome] : undefined;
  if (
    !exact(value, keys) ||
    value.kind !== 'routine-run' ||
    !rule ||
    typeof value.notice_id !== 'string' ||
    !ID_RE.test(value.notice_id) ||
    value.id !== `${value.notice_id}:routine` ||
    typeof value.routine_id !== 'string' ||
    !ID_RE.test(value.routine_id) ||
    !isQuote(value.quote) ||
    (value.run_id !== null && value.run_id !== value.notice_id) ||
    (value.run_id === null) !== ROUTINE_OUTCOMES.includes(value.outcome) ||
    !isInstant(value.created_at) ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !exact(value.detail, rule[0]) ||
    !rule[1](value.detail)
  ) throw new RoutineError('routine-entry-invalid');
  return {
    id: value.id,
    kind: 'routine-run',
    runId: value.run_id,
    routineId: value.routine_id,
    quote: value.quote,
    outcome: value.outcome,
    createdAt: value.created_at,
    detail: structuredClone(value.detail),
    version: value.version,
  };
}

// The words of a count: one form for exactly one, the other for any other number.
function plural(forms, count, locale) {
  return new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other;
}

/** How many healthy runs one rollup of a continuous Routine counts, in words. */
export function healthyRunsWords(forms, runs, locale) {
  return fill(plural(forms, runs, locale), { runs });
}

// Each outcome's tone in the transcript's activity timeline: healthy (done, recovered, running), danger (failed, held,
// denied), waiting (paused, frozen, scope changed), or neutral (created, updated, set aside, stopped, missed runs).
const NOTICE_TONES = Object.freeze({
  done: 'healthy',
  recovered: 'healthy',
  healthy: 'healthy',
  failed: 'danger',
  held: 'danger',
  denied: 'danger',
  paused: 'waiting',
  frozen: 'waiting',
  'scope-changed': 'waiting',
  created: 'neutral',
  changed: 'neutral',
  'user-skipped': 'neutral',
  stopped: 'neutral',
  skipped: 'neutral',
});

/**
 * Ordered Assistant Actions as one line grouped by Assistant: "A · x › y" when every step shares A, otherwise
 * "A · x › B · y", naming an Assistant again only where it changes. An item may carry how many consecutive steps
 * repeat its Action, which reads "x ×3".
 */
export function stepChain(steps, assistantName) {
  return steps.map(([assistant, action, count = 1], index) => {
    const words = count > 1 ? `${humanizeId(action)} ×${count}` : humanizeId(action);
    return index > 0 && steps[index - 1][0] === assistant ? words : `${assistantName(assistant)} · ${words}`;
  }).join(' › ');
}

/** A plan summary's Actions as one line, then how many steps follow beyond the runs it names. */
export function summaryChain(plan, assistantName, copy, locale) {
  const chain = stepChain(plan.actions, assistantName);
  if (plan.more === 0) return chain;
  return `${chain} › ${fill(plural(copy.rest, plan.more, locale), { count: new Intl.NumberFormat(locale).format(plan.more) })}`;
}

/** A sentence's first letter in upper case for a locale. */
function capitalized(value, locale) {
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
}

/**
 * One Routine notice of a Team's transcript (ADR-0086) as an activity-timeline entry, in plain text only: its tone,
 * a short status phrase, the notice's time of day in the viewer's own clock, detail lines, and an error code shown
 * apart. `assistantName` names an Assistant id in words. A held or frozen step reads as "Step n of total", its position
 * in the plan the run carried out, and a failed run says the step it stopped at.
 */
export function routineNotice(entry, { copy, locale, assistantName }) {
  const notice = copy.notice;
  const detail = entry.detail;
  const placed = (item) => fill(notice.stepOf, {
    n: item.step, total: item.steps, step: stepChain([[item.assistant_id, item.action]], assistantName),
  });
  const chain = detail.plan ? [summaryChain(detail.plan, assistantName, notice, locale)]
    : detail.actions?.length ? [stepChain(detail.actions, assistantName)] : [];
  const status = {
    'scope-changed': notice.status.scopeChanged,
    'user-skipped': notice.status.userSkipped,
    frozen: detail.request_kind === 'human' ? notice.status.frozenHuman : notice.status.frozenIntegrations,
  }[entry.outcome] ?? notice.status[entry.outcome];
  let lines = chain;
  switch (entry.outcome) {
    case 'created':
    case 'changed': {
      const schedule = scheduleWords(detail.schedule, copy.schedule, locale);
      lines = [`${schedule} · ${detail.timezone}`, ...chain, dispositionWords(detail.output, copy.plan)];
      break;
    }
    case 'done':
    case 'recovered':
      if (detail.output && detail.output.state !== 'shown') lines = [...chain, notice.output[detail.output.state]];
      break;
    case 'healthy':
      lines = [fill(plural(notice.healthy, detail.runs, locale), { runs: detail.runs, minute: minuteWords(entry.createdAt, locale) })];
      break;
    case 'skipped':
      lines = [fill(plural(notice.skipped, detail.missed, locale), { missed: detail.missed })];
      break;
    case 'held': lines = detail.assistant_id === null ? [] : [placed(detail)]; break;
    case 'failed':
      if (detail.step !== null) lines = [...chain, fill(notice.stoppedAt, { n: detail.step, total: detail.steps })];
      break;
    case 'paused': lines = [capitalized(copy.run.pauseReasons[detail.reason] ?? '', locale)]; break;
    case 'user-skipped': lines = [notice.setAside[detail.choice]]; break;
    case 'scope-changed':
      lines = [fill(notice.scopeChanged, {
        assistants: new Intl.ListFormat(locale, { type: 'conjunction' }).format(detail.assistants.map(assistantName)),
      })];
      break;
    case 'frozen': lines = [placed(detail)]; break;
    default: break;
  }
  return {
    tone: NOTICE_TONES[entry.outcome],
    status,
    time: clockTime(Date.parse(entry.createdAt), locale),
    lines,
    code: entry.outcome === 'failed' ? detail.code : '',
    // A shown result, rendered apart as plain text: Team's bounded, redacted projection, never Markdown or HTML.
    output: detail.output?.state === 'shown' ? detail.output : null,
  };
}

/** What a Routine does with each run's result, in words: the shown step is named by its place in the plan. */
export function dispositionWords(output, copy) {
  return fill(copy.output[output.mode], { n: output.step });
}

/**
 * A list of field sets as one table, when every item is a field set and together they name at most eight labels: its
 * columns in first-seen order and each row's node per column, or null for a missing one. Anything else is null.
 */
export function outputTable(node, maximum = 8) {
  // A field set Team cut short keeps its own list form, so its "N more" is never lost in a table row.
  if (node.kind !== 'list' || node.items.length === 0 ||
    !node.items.every((item) => item.kind === 'fields' && item.omitted === 0)) {
    return null;
  }
  const columns = [...new Set(node.items.flatMap((item) => item.fields.map(([label]) => label)))];
  if (columns.length === 0 || columns.length > maximum) return null;
  const rows = node.items.map((item) => {
    const cells = new Map(item.fields);
    return columns.map((column) => cells.get(column) ?? null);
  });
  return { columns, rows };
}

/**
 * Labels as shown: humanized ("per_page" reads "Per page") only while that keeps every label distinct, otherwise
 * exactly as Team wrote them, so two fields never read alike.
 */
export function outputLabels(labels) {
  const humanized = labels.map((label) => humanizeId(label));
  return new Set(humanized).size === labels.length ? humanized : [...labels];
}

/**
 * A number's exact JSON text in the viewer's locale only when the browser holds it exactly and the locale's digits
 * keep every one of them: at most 15 significant digits, and zero or a magnitude from 0.000001 to under 10^15.
 * Anything else reads exactly as Team wrote it, so a shown number is never rounded.
 */
function numberWords(text, locale) {
  const digits = text.replace(/^-/u, '').replace(/[eE].*$/u, '').replace('.', '').replace(/^0+/u, '');
  const value = Number(text);
  const magnitude = Math.abs(value);
  const localizable = digits.length <= 15 && Number.isFinite(value) &&
    (value === 0 || (magnitude >= 1e-6 && magnitude < 1e15));
  return localizable ? new Intl.NumberFormat(locale, { maximumFractionDigits: 21 }).format(value) : text;
}

/** One scalar node of a shown result as plain words in the viewer's language. */
export function outputScalarWords(node, copy, locale) {
  switch (node.kind) {
    case 'text': return node.value;
    case 'number': return numberWords(node.value, locale);
    case 'bool': return node.value ? copy.yes : copy.no;
    case 'redacted': return copy.redacted;
    case 'elided': return '…';
    default: return '—';
  }
}

/** How many more items or fields a shown result left out, in words. */
export function omittedWords(copy, count, locale) {
  return fill(plural(copy.more, count, locale), { count: new Intl.NumberFormat(locale).format(count) });
}

/**
 * The Routine rows of a re-read history page that a transcript does not show yet at their version, in page order.
 * `shown` maps each shown Routine row id to its version; any other kind of entry is left to the conversation.
 */
export function newerRoutineEntries(shown, entries) {
  return entries.filter((entry) => (
    entry.kind === 'routine-run' && (!shown.has(entry.id) || shown.get(entry.id) < entry.version)
  ));
}

/**
 * Open a frozen run's fresh challenge, or learn that it waits for an Integration. Team renders the request copy in the
 * interface language named here, so a different language always opens a fresh challenge (ADR-0091).
 */
export async function openRoutineChallenge(fetcher, teamId, runId, locale, parseChallenge) {
  if (!isLocale(locale)) throw new RoutineError('routine-request-invalid');
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/challenge`), {
    method: 'POST',
    body: JSON.stringify({ locale }),
  });
  if (exact(body, ['team_id', 'run_id', 'status']) && body.status === 'integrations-required'
    && body.team_id === teamId && body.run_id === runId) {
    return { status: 'integrations-required' };
  }
  if (!exact(body, ['team_id', 'run_id', 'status', 'challenge']) || body.status !== 'human-required'
    || body.team_id !== teamId || body.run_id !== runId) {
    throw new RoutineError('routine-response-invalid');
  }
  let challenge;
  try {
    challenge = parseChallenge(body.challenge);
  } catch {
    throw new RoutineError('routine-response-invalid');
  }
  // The opening named the language its copy renders in; a challenge in any other language is not this opening.
  if (challenge.locale !== locale) throw new RoutineError('routine-response-invalid');
  return { status: 'human-required', challenge };
}

function resumed(body, teamId, runId) {
  if (
    !exact(body, ['team_id', 'run_id', 'status']) ||
    body.team_id !== teamId ||
    body.run_id !== runId ||
    !['done', 'recovered', 'failed', 'denied', 'stopped', 'frozen', 'held'].includes(body.status)
  ) throw new RoutineError('routine-response-invalid');
  return body.status;
}

/** Answer the open challenge with chat's exact human-response frame; the run then resumes or ends. */
export async function answerRoutineChallenge(fetcher, teamId, runId, frame) {
  const response = await fetcher(teamPath(teamId, `/runs/${opaque(runId)}/human`), {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(frame),
  });
  const body = await jsonObject(response);
  // A wrong password keeps the challenge open, as in chat.
  if (response.status === 409 && ['authentication-denied', 'authentication-locked'].includes(body.code)) {
    const { code: _code, ...rejection } = body;
    return { rejection };
  }
  if (!response.ok) {
    const code = typeof body.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(body.code) ? body.code : 'routine-request-failed';
    const retryAfter = Number.isInteger(body.retry_after) && body.retry_after > 0 && body.retry_after <= 3600 ? body.retry_after : 0;
    throw new RoutineError(code, response.status, retryAfter);
  }
  return { status: resumed(body, teamId, runId) };
}

export async function resumeRoutineIntegrations(fetcher, teamId, runId) {
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/integrations`), { method: 'POST' });
  return resumed(body, teamId, runId);
}

// One Routine run's execution details (ADR-0092 section 8): per attempt of one logical operation, Team's sanitized
// handled failure or a safe transport condition. Every text member is literal evidence, rendered only as escaped text,
// never as Markdown or HTML, and never effect proof or authority.
const MAX_RUN_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_ATTEMPTS = 64;
const MAX_DIAGNOSTIC_TEXT_BYTES = 2048;
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_TYPE_RE = /^[!-~]{1,128}$/;
const PROVIDER_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CONDITION_RE = /^(?:exit-status:-?[0-9]{1,10}|stderr-output|timeout|frame-invalid|exit-unavailable|transport-failed)$/;
// Tab and line feed only; every other control, bidi override or isolate, and zero-width formatting character is refused.
const UNSAFE_DIAGNOSTIC_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/u;
function diagnosticText(value) {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    !UNSAFE_DIAGNOSTIC_RE.test(value) &&
    ENCODER.encode(value).length <= MAX_DIAGNOSTIC_TEXT_BYTES
  );
}

function isFailure(value) {
  return (
    exact(value, ['error_type', 'message', 'provider', 'http_status', 'response_excerpt', 'redacted', 'truncated']) &&
    typeof value.error_type === 'string' &&
    ERROR_TYPE_RE.test(value.error_type) &&
    diagnosticText(value.message) &&
    (value.provider === null || (typeof value.provider === 'string' && value.provider.length <= 253 &&
      PROVIDER_RE.test(value.provider))) &&
    (value.http_status === null || whole(value.http_status, 100, 599)) &&
    (value.response_excerpt === null || diagnosticText(value.response_excerpt)) &&
    typeof value.redacted === 'boolean' &&
    typeof value.truncated === 'boolean'
  );
}

function isDiagnostic(value) {
  return (
    exact(value, ['operation_id', 'attempt', 'assistant_id', 'action', 'step', 'recorded_at', 'failure', 'condition']) &&
    typeof value.operation_id === 'string' &&
    OPERATION_ID_RE.test(value.operation_id) &&
    whole(value.attempt, 1, MAX_DIAGNOSTIC_ATTEMPTS) &&
    typeof value.assistant_id === 'string' &&
    ASSISTANT_ID_RE.test(value.assistant_id) &&
    typeof value.action === 'string' &&
    ACTION_ID_RE.test(value.action) &&
    isPosition(value.step) &&
    isInstant(value.recorded_at) &&
    (value.failure === null) !== (value.condition === null) &&
    (value.failure === null || isFailure(value.failure)) &&
    (value.condition === null || (typeof value.condition === 'string' && CONDITION_RE.test(value.condition)))
  );
}

/** A failed attempt's safe transport condition in words. */
export function conditionWords(condition, copy) {
  const exit = condition.match(/^exit-status:(-?\d+)$/u);
  if (exit) return fill(copy.conditions.exit, { code: exit[1] });
  return {
    'stderr-output': copy.conditions.stderr,
    timeout: copy.conditions.timeout,
    'frame-invalid': copy.conditions.frame,
    'exit-unavailable': copy.conditions.exitUnavailable,
    'transport-failed': copy.conditions.transport,
  }[condition];
}

/** One run's execution details for exactly the Team and run asked for, oldest attempt first. */
export async function readRunDiagnostics(fetcher, teamId, runId) {
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/diagnostics`));
  return view(body, ['team_id', 'run_id', 'diagnostics'], (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    Array.isArray(item.diagnostics) &&
    item.diagnostics.length <= MAX_RUN_DIAGNOSTICS &&
    item.diagnostics.every(isDiagnostic)).diagnostics;
}
