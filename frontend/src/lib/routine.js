// Team Routines (ADR-0086, ADR-0092, ADR-0101) as the browser admits them. Each parser mirrors Team's closed protocol
// view and throws on any other shape; nothing here schedules or authorizes: a Routine exists only once the person
// confirms the card Team recorded from a chat turn.

import { clockTime } from './chatDays.js';
import { isLocale } from './locales.js';
import { parseRunUsage } from './taskUsage.js';
import { codePointLength, isActionId, isAssistantId, isIdentifier, isInstant, jsonObject, TEAM_ID_RE } from './validate.js';

const ENCODER = new TextEncoder();

export const MAX_ASSISTANTS = 16;
const FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const ID_RE = /^[0-9a-f]{32}$/;
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

/** The exact closed schedule, or false. */
export function isSchedule(value) {
  const fields = value && typeof value === 'object' ? SCHEDULE_FIELDS[value.kind] : undefined;
  if (!fields || !exact(value, fields)) return false;
  if (value.kind === 'hourly') return whole(value.every, 1, 24);
  if (value.kind === 'continuous') {
    return whole(value.gap, MIN_CONTINUOUS_GAP_SECONDS, MAX_CONTINUOUS_GAP_SECONDS) && value.cap === continuousCap(value.gap);
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

// Where a Routine's timezone came from (ADR-0101): the person's browser, a zone the person wrote, or none, when the
// Routine needs no zone and stores UTC only by convention, which Admin never shows as the person's zone.
export const TIMEZONE_SOURCES = ['browser', 'person', 'none'];
const CONVENTIONAL_TIMEZONE = 'UTC';

/**
 * Whether a timezone and its source fit together, as Team's `zoned` admits them: a known source names a zone, and
 * `none` means UTC used because no timezone was given, for any schedule and any run date (ADR-0101).
 */
export function isZoned(timezone, source) {
  if (!TIMEZONE_SOURCES.includes(source) || !isTimezone(timezone)) return false;
  return source !== 'none' || timezone === CONVENTIONAL_TIMEZONE;
}

/** The timezone Admin shows a Routine's instants in: the one it runs in, UTC when no timezone was given. */
export function displayZone(value) {
  return value.timezone;
}

/** A continuous Routine's starts in any rolling 24 hours: as many as its gap allows all day, never lowered. */
export function continuousCap(gap) {
  return Math.ceil(DAY_SECONDS / gap);
}

/** The most runs a Routine may start in any rolling 24 hours, as Team's `daily_cap` derives it from its schedule. */
export function dailyCap(schedule) {
  if (schedule.kind === 'continuous') return schedule.cap;
  if (schedule.kind === 'hourly') return Math.ceil(24 / schedule.every);
  return 1;
}

function isAssistants(value, minimum) {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= MAX_ASSISTANTS &&
    value.every(isAssistantId) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

const NONCE_RE = /^[0-9a-f]{32}$/;
export const MAX_ROUTINES = 8;
// The unresolved incidents a Team holds at most (ADR-0092); each settles through its recovery card.
export const MAX_INCIDENTS = 32;
const DAY_SECONDS = 86400;
export const MIN_CONTINUOUS_GAP_SECONDS = 5;
export const MAX_CONTINUOUS_GAP_SECONDS = 86400;
// Runs start their gap apart, but one after an overrun or a confirmed change starts at once: one a second.
export const MAX_ROLLUP_RUNS = 60;

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

// A Routine's state (ADR-0101): it runs, or a person paused it.
export const ROUTINE_STATES = ['active', 'paused'];
// The Actions a Routine may call at most in its lifetime: every replayed step's.
const MAX_PERMITTED = 256;

function isPermittedSummary(value) {
  return exact(value, ['total', 'changes']) && whole(value.total, 1, MAX_PERMITTED) &&
    whole(value.changes, 0, value.total);
}

// A Routine's standing scope: whether it runs, and its permitted Actions.
function isScope(item) {
  return ROUTINE_STATES.includes(item.state) && isPermittedSummary(item.permitted);
}

/** One confirmed Routine as a Supervisor sees it. */
export function parseRoutineView(value) {
  const keys = [
    'routine_id', 'name', 'plan', 'output', 'schedule', 'timezone', 'timezone_source', 'assistant_ids', 'next_run_at',
    'needs_reconfirm', 'deleting', 'state', 'permitted',
  ];
  return view(value, keys, (item) =>
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isName(item.name) &&
    isSummary(item.plan) &&
    isDisposition(item.output, item.plan.steps) &&
    isSchedule(item.schedule) &&
    isZoned(item.timezone, item.timezone_source) &&
    isAssistants(item.assistant_ids, 0) &&
    isInstant(item.next_run_at) &&
    typeof item.needs_reconfirm === 'boolean' &&
    typeof item.deleting === 'boolean' &&
    isScope(item));
}

// A Routine plan's safe projection, mirroring Team's `routine.canonical_step` (ADR-0092, ADR-0101): each step's Action,
// whether it only reads, every input's source with a bounded literal preview, and the Stored Inputs its Action uses by
// name only. On the wire a step is named by its 1-based position in its revision's plan, and a reference names the
// earlier step it selects from by position, and through an array item its selecting member and the item's pointer.
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
const CLOCK_FORMATS = ['date'];
const PLAN_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const INPUT_KEYS = {
  literal: ['member', 'source', 'value'],
  run_clock: ['member', 'source', 'value'],
  step_output: ['member', 'source', 'step', 'pointer', 'where', 'item'],
};
const MAX_WHERE_CHARS = 4096;

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

function isPointer(value) {
  return typeof value === 'string' && codePointLength(value) <= 256 && POINTER_RE.test(value) &&
    !PLAN_UNSAFE_RE.test(value);
}

/** A selector constant as Team shows it: its JSON text with every control or invisible character escaped. */
export function whereText(constant) {
  return escapedText(JSON.stringify(constant));
}

// A selector as shown: its member and its constant's escaped JSON text, a string or an integer.
function isWhere(value) {
  if (!exact(value, ['member', 'value_json']) || !plain(value.member, 128) || !plain(value.value_json, MAX_WHERE_CHARS)) {
    return false;
  }
  let constant;
  try {
    constant = JSON.parse(value.value_json);
  } catch {
    return false;
  }
  return (typeof constant === 'string' || Number.isSafeInteger(constant)) && whereText(constant) === value.value_json;
}

// A copied value: an earlier position and its pointer, and through an array item its selector and item pointer.
function isReference(value, position) {
  return isPosition(value.step, position - 1) && isPointer(value.pointer) &&
    (value.where === null ? value.item === null : isWhere(value.where) && isPointer(value.item));
}

function isInput(value, position) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? INPUT_KEYS[value.source] : undefined;
  if (!keys || !exact(value, keys) || !plain(value.member, 128)) return false;
  if (value.source === 'literal') return plain(value.value, MAX_PREVIEW_CHARS);
  if (value.source === 'run_clock') return CLOCK_FORMATS.includes(value.value);
  return isReference(value, position);
}

/** Whether a value is one projected step at exactly `position`, referring only to earlier positions. */
export function isPlanStep(value, position) {
  if (!exact(value, ['position', 'assistant', 'action', 'read_only', 'inputs', 'stored_inputs'])) return false;
  const { inputs, stored_inputs: stored } = value;
  return (
    isPosition(position) &&
    value.position === position &&
    isAssistantId(value.assistant) &&
    isActionId(value.action) &&
    typeof value.read_only === 'boolean' &&
    Array.isArray(inputs) && inputs.length <= MAX_STEP_INPUTS && inputs.every((item) => isInput(item, position)) &&
    sortedMembers(inputs) &&
    Array.isArray(stored) && stored.length <= MAX_STEP_STORED_INPUTS &&
    stored.every(isIdentifier) &&
    JSON.stringify(stored) === JSON.stringify([...new Set(stored)].sort()) &&
    encodedBytes(value) <= MAX_STEP_VIEW_BYTES
  );
}

/**
 * Whether a value is a revision's plan summary, mirroring Team's `routine.canonical_summary`: its revision and digest,
 * its step count, and its Actions as runs of consecutive equal `[assistant, action, count]` that cover the first steps
 * in order; `more` counts the steps after the sixteenth run. A plan always has at least one step.
 */
export function isSummary(value) {
  if (!exact(value, ['revision', 'plan_digest', 'steps', 'actions', 'more'])) return false;
  const { actions: runs, more, steps: total } = value;
  return (
    whole(value.revision, 1, 2 ** 31 - 1) &&
    typeof value.plan_digest === 'string' && PLAN_DIGEST_RE.test(value.plan_digest) &&
    whole(total, 1, MAX_ROUTINE_STEPS) &&
    Array.isArray(runs) && runs.length > 0 && runs.length <= MAX_SUMMARY_RUNS &&
    runs.every((run) => Array.isArray(run) && run.length === 3 && isAssistantId(run[0]) && isActionId(run[1]) &&
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
    whole(total, 1, MAX_ROUTINE_STEPS) &&
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

// What one run did, step by step (ADR-0092 amendment, 2026-10-05, scale; ADR-0101), mirroring Team's
// `routine.canonical_run_step`: a recorded replay step's status, Action, attempt, duration, instant,
// and its inputs as redacted previews, or a gap. `stopped`: Stop or the run's deadline cut the attempt, which says
// nothing about whether the Action acted.
const RUN_STEP_STATUSES = ['done', 'recovered', 'failed', 'stopped', 'waiting'];
const RUN_STEP_GAPS = ['not_run', 'unavailable'];
const RUN_INPUT_SOURCES = ['literal', 'run_clock', 'step_output'];
const RUN_STEP_KEYS = ['position', 'status', 'assistant_id', 'action', 'attempt', 'duration_ms', 'recorded_at', 'inputs'];
const SNAPSHOT_RE = /^[0-9a-f]{32}$/;

function isRunInput(value) {
  return exact(value, ['member', 'source', 'value']) && plain(value.member, 128) &&
    RUN_INPUT_SOURCES.includes(value.source) && (value.value === null || plain(value.value, MAX_PREVIEW_CHARS));
}

/** Whether a value is a call's position: a replay step among `steps`, `{phase: "replay", step}`. */
export function isCallPosition(value, steps) {
  if (!whole(steps, 0, MAX_ROUTINE_STEPS)) return false;
  return exact(value, ['phase', 'step']) && value.phase === 'replay' && isPosition(value.step, steps);
}

/** The position of a run page's `index`-th entry (1-based): its replay step. */
export function runPosition(index) {
  return { phase: 'replay', step: index };
}

function samePosition(left, right) {
  return left.phase === right.phase && left.step === right.step;
}

/** Whether a value is one run entry at exactly `position`: what its attempt did, or only that it never ran or is gone. */
export function isRunStep(value, position, steps) {
  if (!exact(value, RUN_STEP_KEYS) || !isCallPosition(value.position, steps) || !samePosition(value.position, position)) {
    return false;
  }
  if (RUN_STEP_GAPS.includes(value.status)) {
    return RUN_STEP_KEYS.slice(2).every((key) => value[key] === null);
  }
  const duration = value.duration_ms;
  return (
    RUN_STEP_STATUSES.includes(value.status) &&
    isAssistantId(value.assistant_id) &&
    isActionId(value.action) &&
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
 * The historical binding every page of one run's records must match: its Routine always, and its revision, plan
 * digest, and step count once known. A completed run's notice carries its plan summary, which binds them from
 * the start; a failed, stopped, or held run's notice carries none, so its first page binds them for every later page.
 * A run's page never needs its revision's plan, so it reads the same after the Routine changed or went.
 */
export function runBinding(routineId, plan = null) {
  return {
    routine_id: routineId,
    revision: plan?.revision ?? null,
    plan_digest: plan?.plan_digest ?? null,
    total: plan?.steps ?? null,
  };
}

/** The binding a run page names: its Routine, revision, plan digest, and step count. */
export function pageBinding(page) {
  return { routine_id: page.routine_id, revision: page.revision, plan_digest: page.plan_digest, total: page.total };
}

// A binding is its Routine with its revision, digest, and step count all known or all still unknown.
function isBinding(value) {
  if (!exact(value, ['routine_id', 'revision', 'plan_digest', 'total'])) return false;
  const { routine_id: routineId, revision, plan_digest: digest, total } = value;
  const known = whole(revision, 1, 2 ** 31 - 1) && typeof digest === 'string' && PLAN_DIGEST_RE.test(digest) &&
    whole(total, 1, MAX_ROUTINE_STEPS);
  return typeof routineId === 'string' && ID_RE.test(routineId) &&
    (known || (revision === null && digest === null && total === null));
}

/**
 * One page of what a run did from `offset`, bound to the run's historical `binding` (`runBinding`) and to one
 * `snapshot` of its retained records. `latest` asks for the current snapshot, which the page names; any other page is
 * admitted only for exactly that snapshot, and Team refuses one whose records changed since (`routine-run-changed`).
 */
export async function readRunSteps(fetcher, teamId, runId, binding, snapshot, offset) {
  if (!isBinding(binding) || (snapshot !== 'latest' && (typeof snapshot !== 'string' || !SNAPSHOT_RE.test(snapshot)))) {
    throw new RoutineError('routine-request-invalid');
  }
  const path = `/runs/${opaque(runId)}/steps/${snapshot}/${offsetPath(offset)}`;
  const body = await request(fetcher, teamPath(teamId, path));
  const keys = [
    'team_id', 'run_id', 'routine_id', 'revision', 'plan_digest', 'total', 'snapshot', 'ended', 'offset', 'steps',
    'next',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    whole(item.revision, 1, 2 ** 31 - 1) &&
    typeof item.plan_digest === 'string' && PLAN_DIGEST_RE.test(item.plan_digest) &&
    Object.entries(binding).every(([key, expected]) => expected === null || item[key] === expected) &&
    typeof item.snapshot === 'string' && SNAPSHOT_RE.test(item.snapshot) &&
    (snapshot === 'latest' || item.snapshot === snapshot) &&
    typeof item.ended === 'boolean' &&
    item.offset === offset &&
    isPageOf(item, (step, index) => isRunStep(step, runPosition(index), item.total)));
}

const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Whether a page reader must read the next page before it can reveal `wanted` steps: fewer are loaded and Team named a
 * next offset.
 */
export function needsPage(loaded, wanted, next) {
  return loaded < wanted && next !== null;
}

// What a completed run does with its result (ADR-0092 amendment, 2026-10-05, output; ADR-0101), mirroring Team's
// `routine.canonical_disposition` and `routine.canonical_output`: show one step's result after every run, only when it
// changed, or show nothing; and a shown result as Team's bounded, redacted, ordered projection.
const OUTPUT_MODES = ['show', 'changes', 'none'];
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

/**
 * Whether a plan's output disposition is closed: it names one of its `total` steps' positions when it shows one.
 */
export function isDisposition(value, total) {
  if (!exact(value, ['mode', 'step']) || !OUTPUT_MODES.includes(value.mode)) return false;
  if (!whole(total, 1, MAX_ROUTINE_STEPS)) return false;
  return SHOWN_MODES.includes(value.mode) ? isPosition(value.step, total) : value.step === null;
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
      isAssistantId(pair[0]) &&
      isActionId(pair[1]))
  );
}

// What a frozen run waits for: a person's answer or an Integration.
export const REQUEST_KINDS = ['human', 'integrations'];

/** One live run: a frozen run names its request and its call's position; a leased or held one only that it is live. */
export function parseRunView(value) {
  const keys = ['run_id', 'routine_id', 'status', 'scheduled_at', 'request_kind', 'assistant_id', 'action', 'position', 'steps'];
  return view(value, keys, (item) => {
    const request = [item.request_kind, item.assistant_id, item.action, item.position, item.steps];
    const frozen =
      REQUEST_KINDS.includes(item.request_kind) &&
      isAssistantId(item.assistant_id) &&
      isActionId(item.action) &&
      isCallPosition(item.position, item.steps);
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

// The call a held run stopped at and its position, or all null when it sealed no plan before it was held.
function isHeldStep(detail) {
  if (detail.assistant_id === null) return detail.action === null && detail.position === null && detail.steps === null;
  return isAssistantId(detail.assistant_id) && isActionId(detail.action) && isCallPosition(detail.position, detail.steps);
}

/** One unresolved incident of a held run, which outlives a deleted Routine (ADR-0092). */
export function parseIncidentView(value) {
  const keys = ['incident_id', 'routine_id', 'name', 'created_at', 'assistant_id', 'action', 'position', 'steps'];
  return view(value, keys, (item) =>
    typeof item.incident_id === 'string' &&
    ID_RE.test(item.incident_id) &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isName(item.name) &&
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
 * again, paused, waiting for an approval, running now, or idle between runs (continuous or
 * on its schedule).
 */
export function routineStatus(routine, runs = [], incidents = []) {
  const own = runs.filter((run) => run.routine_id === routine.routine_id);
  if (routine.deleting) return 'deleting';
  if (incidents.some((item) => item.routine_id === routine.routine_id) || own.some((run) => run.status === 'held')) {
    return 'recovery';
  }
  if (routine.needs_reconfirm) return 'reconfirm';
  if (routine.state === 'paused') return 'paused';
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

// Exactly Team's unsafe set (`routine.escaped`): controls, bidi and zero-width formatting, line and paragraph
// separators, the BOM, and, in this Unicode-mode class, a lone surrogate.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ud800-\udfff\ufeff]/gu;

/** Text with every character in Team's unsafe set written back as its JSON unicode escape, as Team writes it. */
export function escapedText(text) {
  return text.replace(UNSAFE_TEXT_RE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A literal's preview as plain words: a JSON string reads without its quotes, with every unsafe character Team escaped
 * escaped again, so decoding never restores a control or invisible character; anything else stays as Team showed it.
 */
export function literalWords(preview) {
  try {
    const value = JSON.parse(preview);
    return typeof value === 'string' ? escapedText(value) : preview;
  } catch {
    return preview;
  }
}

/**
 * A selector's constant in words: a string reads without its quotes, every unsafe character Team escaped escaped
 * again; an integer reads as its digits.
 */
export function whereWords(where) {
  return literalWords(where.value_json);
}

/**
 * One plan input in words: a literal's preview, the date of each run, or a path into an earlier step's result, through
 * the one item whose member holds the constant the request named.
 */
export function inputWords(input, copy) {
  if (input.source === 'literal') return literalWords(input.value);
  if (input.source === 'run_clock') return fill(copy.clock, { format: copy.clocks[input.value] });
  const n = input.step;
  if (input.where !== null) {
    const path = [pointerWords(input.pointer, copy), input.item ? pointerWords(input.item, copy) : ''].filter(Boolean);
    return fill(copy.fromItem, {
      n,
      path: path.join(' › '),
      member: humanizeId(input.where.member),
      value: whereWords(input.where),
    });
  }
  if (!input.pointer) return fill(copy.fromStepWhole, { n });
  return fill(copy.fromStep, { n, path: pointerWords(input.pointer, copy) });
}

// A held run's recovery card (ADR-0092 section 7, ADR-0101): exactly Rodar and Excluir, in this order, none
// recommended. Team answers Rodar; Excluir is the Routine's own confirmed deletion.
export const CARD_CHOICES = ['run', 'delete'];
export const CARD_ANSWERS = ['run'];
const CARD_STATUSES = { run: 'requested' };
const CARD_EVIDENCE = ['recorded', 'absent', 'unavailable'];

// The held operation's latest diagnostic, exactly when Team recorded one, and only of the card's own call.
function isCardEvidence(item) {
  if (!CARD_EVIDENCE.includes(item.evidence) || (item.diagnostic === null) === (item.evidence === 'recorded')) {
    return false;
  }
  return item.diagnostic === null || (
    isDiagnostic(item.diagnostic) &&
    item.diagnostic.assistant_id === item.assistant_id &&
    item.diagnostic.action === item.action &&
    samePosition(item.diagnostic.position, item.position)
  );
}

function parseCard(body, teamId, incidentId) {
  const keys = [
    'team_id', 'incident_id', 'routine_id', 'revision', 'assistant_id', 'action', 'position', 'steps', 'evidence',
    'diagnostic', 'nonce', 'expires_in', 'choices',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.incident_id === incidentId &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    Number.isInteger(item.revision) &&
    item.revision >= 1 &&
    isAssistantId(item.assistant_id) &&
    isActionId(item.action) &&
    isCallPosition(item.position, item.steps) &&
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

/** Answer an open card with Rodar; returns what Team did. Excluir is the confirmed deletion instead. */
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
    // The Team's Routines' daily Action steps together, or their definitions together, would outgrow its budget.
    'routine-step-budget': copy.stepBudget,
    'routine-team-budget': copy.teamBudget,
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
    'routine-recovery-stopped': copy.stopped,
    // The card was confirmed, revoked, replaced, or outlived its fifteen minutes; nothing was created.
    'routine-proposal-expired': copy.proposalExpired,
    // The Team cannot hold one more change right now; nothing changed, and it frees up on its own.
    'notices-full': copy.unavailable,
    'routine-state-unavailable': copy.unavailable,
    'team-context-unavailable': copy.unavailable,
  };
  return byCode[code] ?? copy.generic;
}

export { fill as fillRoutineCopy };

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

// The call a failed run stopped at by position, or both null when it failed before any call.
function isFailedAt(detail) {
  return (detail.position === null && detail.steps === null) || isCallPosition(detail.position, detail.steps);
}

const STEP_KEYS = ['assistant_id', 'action', 'position', 'steps'];
const COMPLETED_KEYS = ['plan', 'output'];
const DEFINED_KEYS = ['name', 'plan', 'output', 'schedule', 'timezone', 'timezone_source', 'state', 'permitted'];

const NOTICE_DETAILS = {
  done: [COMPLETED_KEYS, isCompleted],
  recovered: [COMPLETED_KEYS, isCompleted],
  held: [STEP_KEYS, isHeldStep],
  paused: [[...STEP_KEYS, 'reason'], (detail) => isHeldStep(detail) && PAUSE_REASONS.includes(detail.reason)],
  // A person set the held run aside: Rodar, or the deletion of its Routine.
  'user-skipped': [[...STEP_KEYS, 'choice'], (detail) => isHeldStep(detail) && CARD_CHOICES.includes(detail.choice)],
  skipped: [['missed'], (detail) => Number.isInteger(detail.missed) && detail.missed >= 1],
  healthy: [['runs'], (detail) => whole(detail.runs, 1, MAX_ROLLUP_RUNS)],
  'scope-changed': [['assistants'], (detail) => isAssistantList(detail.assistants)],
  frozen: [
    ['request_kind', ...STEP_KEYS],
    (detail) => REQUEST_KINDS.includes(detail.request_kind) && detail.assistant_id !== null && isHeldStep(detail),
  ],
  failed: [
    ['code', 'actions', 'position', 'steps'],
    (detail) => typeof detail.code === 'string' && ERROR_CODE_RE.test(detail.code) && isActions(detail.actions) &&
      isFailedAt(detail),
  ],
  denied: [['actions'], (detail) => isActions(detail.actions)],
  stopped: [['actions'], (detail) => isActions(detail.actions)],
  created: [DEFINED_KEYS, isDefinition],
  changed: [DEFINED_KEYS, isDefinition],
  // A deleted Routine's last notice names it and says nothing else (ADR-0101).
  deleted: [[], () => true],
};

// `healthy` rolls up a continuous Routine's healthy runs that ended in one minute (ADR-0092 section 9); `deleted`
// closes a Routine's timeline (ADR-0101).
const ROUTINE_OUTCOMES = ['skipped', 'scope-changed', 'created', 'changed', 'healthy', 'deleted'];

function isName(value) {
  return closedText(value, MAX_NAME_CHARS) && !FORBIDDEN_RE.test(value) && value.normalize('NFC') === value;
}

function isDefinition(detail) {
  return isName(detail.name) && isSummary(detail.plan) && isDisposition(detail.output, detail.plan.steps) &&
    isSchedule(detail.schedule) && isZoned(detail.timezone, detail.timezone_source) &&
    isScope(detail);
}

function isAssistantList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_ASSISTANTS &&
    value.every(isAssistantId)
  );
}

// A row's usage: every run outcome carries its run's, and the healthy rollup its runs' summed; no other Routine
// outcome carries any.
function rowUsage(value) {
  const used = !ROUTINE_OUTCOMES.includes(value.outcome) || value.outcome === 'healthy';
  if (!used) {
    if (value.usage !== null) throw new RoutineError('routine-entry-invalid');
    return null;
  }
  try {
    return parseRunUsage(value.usage);
  } catch {
    throw new RoutineError('routine-entry-invalid');
  }
}

/**
 * One Routine outcome row of a Team's transcript (ADR-0086, ADR-0101); a run's row is keyed by its run id. Its title
 * is only the name Team froze into this notice version, never the live Routine list and never a request.
 */
export function parseRoutineRunEntry(value) {
  const keys = [
    'id', 'kind', 'notice_id', 'routine_id', 'name', 'run_id', 'outcome', 'created_at', 'detail', 'version', 'usage',
    'protection_lost',
  ];
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
    !isName(value.name) ||
    (value.run_id !== null && value.run_id !== value.notice_id) ||
    (value.run_id === null) !== ROUTINE_OUTCOMES.includes(value.outcome) ||
    !isInstant(value.created_at) ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !exact(value.detail, rule[0]) ||
    !rule[1](value.detail) ||
    typeof value.protection_lost !== 'boolean' ||
    (value.protection_lost && ROUTINE_OUTCOMES.includes(value.outcome))
  ) throw new RoutineError('routine-entry-invalid');
  return {
    id: value.id,
    kind: 'routine-run',
    runId: value.run_id,
    routineId: value.routine_id,
    name: value.name,
    outcome: value.outcome,
    createdAt: value.created_at,
    detail: structuredClone(value.detail),
    version: value.version,
    usage: rowUsage(value),
    protectionLost: value.protection_lost,
  };
}

// The words of a count: one form for exactly one, the other for any other number.
function plural(forms, count, locale) {
  return new Intl.PluralRules(locale).select(count) === 'one' ? forms.one : forms.other;
}

/** How many runs one rollup counts, in words: the healthy runs of a continuous Routine, or the runs one missed. */
export function runCountWords(forms, runs, locale) {
  return fill(plural(forms, runs, locale), { runs });
}

// Each notice's tone where it is shown: a Routine's creation in the transcript, or a run in full: healthy (done,
// recovered), danger (failed, held, denied), waiting (paused, frozen), or neutral (created, set aside, stopped).
const NOTICE_TONES = Object.freeze({
  done: 'healthy',
  recovered: 'healthy',
  failed: 'danger',
  held: 'danger',
  denied: 'danger',
  paused: 'waiting',
  frozen: 'waiting',
  created: 'neutral',
  'user-skipped': 'neutral',
  stopped: 'neutral',
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

/**
 * A Routine's creation in a Team's transcript (ADR-0086), or one of its runs opened in full, in plain text only: its
 * tone, a short status phrase, and the notice's time of day in the viewer's own clock.
 */
export function routineNotice(entry, { copy, locale }) {
  const notice = copy.notice;
  const frozen = {
    human: notice.status.frozenHuman,
    integrations: notice.status.frozenIntegrations,
  };
  const status = {
    'user-skipped': notice.status.userSkipped,
    frozen: frozen[entry.detail.request_kind],
  }[entry.outcome] ?? notice.status[entry.outcome];
  return { tone: NOTICE_TONES[entry.outcome], status, time: clockTime(Date.parse(entry.createdAt), locale) };
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
  // The opening named the language its copy renders in; a challenge in any other language is not this opening. A run's
  // card shows no input rows (ADR-0101 §6) and is never Team's policy confirmation, since its card granted each Action.
  if (challenge.locale !== locale || challenge.input || challenge.request?.kind === 'confirmation') {
    throw new RoutineError('routine-response-invalid');
  }
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
const UNSAFE_DIAGNOSTIC_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
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
    exact(value, ['operation_id', 'attempt', 'assistant_id', 'action', 'position', 'recorded_at', 'failure', 'condition']) &&
    typeof value.operation_id === 'string' &&
    OPERATION_ID_RE.test(value.operation_id) &&
    whole(value.attempt, 1, MAX_DIAGNOSTIC_ATTEMPTS) &&
    isAssistantId(value.assistant_id) &&
    isActionId(value.action) &&
    isCallPosition(value.position, MAX_ROUTINE_STEPS) &&
    isInstant(value.recorded_at) &&
    (value.failure === null) !== (value.condition === null) &&
    (value.failure === null || isFailure(value.failure)) &&
    (value.condition === null || (typeof value.condition === 'string' && CONDITION_RE.test(value.condition)))
  );
}

/**
 * A recorded attempt's heading: the replay step Team recorded, its Assistant and Action, and its attempt number, so
 * attempts of one Action repeated at different steps never read alike. `names` words the Assistant and Action.
 */
export function attemptWords(item, template, { assistant = (id) => id, action = (id) => id } = {}) {
  return fill(template, {
    step: item.position.step,
    assistant: assistant(item.assistant_id),
    action: action(item.action),
    attempt: item.attempt,
  });
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

// Two diagnostics in Team's order: by instant, then operation, then attempt.
function diagnosticOrder(left, right) {
  if (left.recorded_at !== right.recorded_at) return left.recorded_at < right.recorded_at ? -1 : 1;
  if (left.operation_id !== right.operation_id) return left.operation_id < right.operation_id ? -1 : 1;
  return left.attempt - right.attempt;
}

/** One run's execution details for exactly the Team and run asked for, oldest attempt first, each attempt once. */
export async function readRunDiagnostics(fetcher, teamId, runId) {
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/diagnostics`));
  return view(body, ['team_id', 'run_id', 'diagnostics'], (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    Array.isArray(item.diagnostics) &&
    item.diagnostics.length <= MAX_RUN_DIAGNOSTICS &&
    item.diagnostics.every(isDiagnostic) &&
    new Set(item.diagnostics.map((entry) => `${entry.operation_id}:${entry.attempt}`)).size === item.diagnostics.length &&
    item.diagnostics.every((entry, index) => index === 0 || diagnosticOrder(item.diagnostics[index - 1], entry) <= 0)).diagnostics;
}

// The confirmation card of a recorded Routine (ADR-0101 section 5.2), mirroring Team's `routine.canonical_proposal`:
// every literal complete and escaped, every source and selector described completely, the schedule, the output, every
// permitted Action. Nothing in it is paged or cut.
const MAX_PROPOSAL_BYTES = 160 * 1024;
const INPUT_ORIGINS = ['request', 'assistant', 'clock', 'step', 'selector'];
const MAX_NEXT_RUNS = 3;
const CARD_INPUT_KEYS = ['member', 'origin', 'value', 'step', 'pointer', 'where', 'item'];

function isCardInput(value, position) {
  if (!exact(value, CARD_INPUT_KEYS) || !INPUT_ORIGINS.includes(value.origin) || !plain(value.member, 128)) return false;
  const others = (keys) => keys.every((key) => value[key] === null);
  if (value.origin === 'request' || value.origin === 'assistant') {
    return typeof value.value === 'string' && !PLAN_UNSAFE_RE.test(value.value) &&
      others(['step', 'pointer', 'where', 'item']);
  }
  if (value.origin === 'clock') return others(['value', 'step', 'pointer', 'where', 'item']);
  return value.value === null && (value.where !== null) === (value.origin === 'selector') && isReference(value, position);
}

function isCardStep(value, position) {
  return exact(value, ['position', 'assistant', 'action', 'read_only', 'inputs']) &&
    value.position === position &&
    isAssistantId(value.assistant) &&
    isActionId(value.action) &&
    typeof value.read_only === 'boolean' &&
    Array.isArray(value.inputs) && value.inputs.length <= MAX_STEP_INPUTS &&
    value.inputs.every((item) => isCardInput(item, position)) && sortedMembers(value.inputs);
}

function isCardPermitted(value) {
  if (!Array.isArray(value) || value.length > MAX_PERMITTED) return false;
  const valid = value.every((item) => exact(item, ['assistant', 'action', 'read_only']) &&
    isAssistantId(item.assistant) && isActionId(item.action) && typeof item.read_only === 'boolean');
  const identities = value.map((item) => `${item.assistant}\u0000${item.action}`);
  return valid && identities.every((item, index) => index === 0 || identities[index - 1] < item);
}

// The permitted Actions are exactly the card's steps' Actions, each with the same reviewed effect as its steps.
function permitsExactly(permitted, steps) {
  const effects = new Map(permitted.map((item) => [`${item.assistant}\u0000${item.action}`, item.read_only]));
  const used = new Set(steps.map((step) => `${step.assistant}\u0000${step.action}`));
  return effects.size === used.size && [...used].every((key) => effects.has(key)) &&
    steps.every((step) => effects.get(`${step.assistant}\u0000${step.action}`) === step.read_only);
}

/**
 * The Routine card a recording turn's reply carries, admitted exactly as Team's closed form, or a thrown
 * `routine-response-invalid`. It is the one thing the person confirms.
 */
export function parseRoutineProposal(value) {
  const keys = [
    'proposal_id', 'expires_at', 'replaces', 'name', 'schedule', 'timezone', 'timezone_source', 'next_runs',
    'daily_cap', 'output', 'steps', 'permitted',
  ];
  return view(value, keys, (item) => {
    const { steps, output, next_runs: runs } = item;
    if (!Array.isArray(steps) || steps.length > MAX_ROUTINE_STEPS || !exact(output, ['mode'])) return false;
    const shown = SHOWN_MODES.includes(output.mode) ? steps.length : null;
    return (
      typeof item.proposal_id === 'string' && ID_RE.test(item.proposal_id) &&
      isInstant(item.expires_at) &&
      (item.replaces === null || (typeof item.replaces === 'string' && ID_RE.test(item.replaces))) &&
      isName(item.name) &&
      isSchedule(item.schedule) &&
      isZoned(item.timezone, item.timezone_source) &&
      Array.isArray(runs) && runs.length >= 1 && runs.length <= MAX_NEXT_RUNS && runs.every(isInstant) &&
      runs.every((run, index) => index === 0 || runs[index - 1] <= run) &&
      item.daily_cap === dailyCap(item.schedule) &&
      isDisposition({ ...output, step: shown }, steps.length) &&
      steps.every((step, index) => isCardStep(step, index + 1)) &&
      isCardPermitted(item.permitted) &&
      permitsExactly(item.permitted, steps) &&
      encodedBytes(item) <= MAX_PROPOSAL_BYTES
    );
  });
}

/** Why a recording turn made no card: one closed code; nothing was created. */
export function parseRoutineRefusal(value) {
  return view(value, ['code'], (item) => typeof item.code === 'string' && ERROR_CODE_RE.test(item.code));
}

// What Team asks the person before a recording can become a card (ADR-0101): the span is kept, and the person's answer
// is an ordinary send. Only an ambiguous binding offers targets; an interval over budget carries the shortest that fits;
// what to do with each run's result is answered with the Team protocol's own four labels, which Team reads back.
export const QUESTION_CODES = [
  'routine-schedule-unstated',
  'routine-interval-over-budget',
  'routine-binding-ambiguous',
  'routine-binding-unsourced',
  'routine-work-split',
  'routine-work-rerun',
  'routine-output-unstated',
];
const MAX_QUESTION_OPTIONS = 8;
const MAX_QUESTION_OPTION_CHARS = 120;

// A target's exact JSON text: a string escapes at most its quotes and backslashes; an integer keeps every digit.
const MAX_QUESTION_VALUE_CHARS = 2 * MAX_QUESTION_OPTION_CHARS + 2;
const INTEGER_TEXT_RE = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * The target a question option names, decoded from its exact JSON text, or null when the text is not one: a plain
 * string written exactly as compact JSON writes it, or an integer whose digits are kept as text so none is rounded.
 */
export function questionTarget(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_QUESTION_VALUE_CHARS) return null;
  if (INTEGER_TEXT_RE.test(text)) return text.length <= MAX_QUESTION_OPTION_CHARS ? { kind: 'integer', shown: text } : null;
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof decoded !== 'string' || !plain(decoded, MAX_QUESTION_OPTION_CHARS) || JSON.stringify(decoded) !== text) {
    return null;
  }
  return { kind: 'string', shown: decoded };
}

function isQuestionOption(value) {
  return exact(value, ['value', 'label']) && questionTarget(value.value) !== null &&
    (value.label === null || plain(value.label, MAX_QUESTION_OPTION_CHARS));
}

/** One question Team asks before a card, admitted exactly as Team's closed form, or a thrown error. */
export function parseRoutineQuestion(value) {
  return view(value, ['code', 'options', 'value'], (item) => {
    const { code, options, value: interval } = item;
    return (
      QUESTION_CODES.includes(code) &&
      Array.isArray(options) &&
      (code === 'routine-binding-ambiguous' || options.length === 0) &&
      options.length <= MAX_QUESTION_OPTIONS &&
      options.every(isQuestionOption) &&
      new Set(options.map((option) => option.value)).size === options.length &&
      (code === 'routine-interval-over-budget'
        ? whole(interval, MIN_CONTINUOUS_GAP_SECONDS, MAX_CONTINUOUS_GAP_SECONDS)
        : interval === null)
    );
  });
}

const QUESTION_KEYS = {
  'routine-schedule-unstated': 'schedule',
  'routine-interval-over-budget': 'overBudget',
  'routine-binding-ambiguous': 'ambiguous',
  'routine-binding-unsourced': 'unsourced',
  'routine-work-split': 'split',
  'routine-work-rerun': 'rerun',
  'routine-output-unstated': 'output',
};

/**
 * A Routine question in words: its sentence and the answers a person may send with one press, each with the label a
 * person reads and the text the answer sends. An ambiguous binding's target is sent as its exact JSON text, the only
 * answer Team matches, so a string and an integer of the same digits stay distinct; every other answer is sent as the
 * words it shows. An interval over budget offers the shortest interval that fits.
 */
export function questionWords(question, questions) {
  const words = questions[QUESTION_KEYS[question.code]];
  if (question.code === 'routine-binding-ambiguous') {
    const answers = question.options.map((option) => {
      const target = questionTarget(option.value).shown;
      const label = option.label === null ? target : fill(words.option, { label: option.label, value: target });
      return { label, text: option.value };
    });
    return { question: words.question, answers };
  }
  if (question.code === 'routine-interval-over-budget') {
    const seconds = String(question.value);
    const answer = fill(words.answer, { seconds });
    return { question: fill(words.question, { seconds }), answers: [{ label: answer, text: answer }] };
  }
  return { question: words.question, answers: (words.answers ?? []).map((answer) => ({ label: answer, text: answer })) };
}

// The words of a refusal code. Every documented one has its own sentence; a plan code reads as the plan's, and any
// other code reads as the generic sentence, so Team may stop emitting one without a stored row turning invalid.
const REFUSAL_KEYS = {
  'routine-recording-unavailable': 'unavailable',
  'routine-recording-too-large': 'tooLarge',
  'routine-recording-empty': 'empty',
  'routine-recording-invalid': 'invalid',
  'routine-secret-literal': 'secret',
  'routine-step-budget': 'stepBudget',
  'routine-proposal-too-large': 'tooLarge',
  'routine-record-again': 'recordAgain',
  'routine-recording-cyclic': 'unverified',
  'routine-recording-conflict': 'unverified',
  'routine-recording-unverified': 'unverified',
  'routine-recording-ambiguous': 'ambiguous',
};

/** The localized sentence saying why no Routine was created from this turn. */
export function refusalWords(refusal, copy) {
  const key = REFUSAL_KEYS[refusal.code] ?? (refusal.code.startsWith('plan-') ? 'plan' : 'generic');
  return copy.refusals[key];
}

/**
 * One card input's value and origin in words: named in the request, chosen by the assistant, or from an earlier step;
 * `planCopy` words a path into that step's result.
 */
export function proposalInputWords(input, copy, planCopy) {
  if (input.origin === 'request' || input.origin === 'assistant') {
    return { value: literalWords(input.value), origin: copy.origins[input.origin] };
  }
  if (input.origin === 'clock') return { value: '', origin: copy.origins.clock };
  const path = [input.pointer, input.item ?? ''].filter(Boolean).map((pointer) => pointerWords(pointer, planCopy));
  const origin = input.origin === 'selector'
    ? fill(copy.origins.selector, { n: input.step, member: humanizeId(input.where.member), value: whereWords(input.where) })
    : fill(copy.origins.step, { n: input.step });
  return { value: path.join(' › '), origin };
}

function answered(body, teamId, proposalId, statuses) {
  if (
    !exact(body, ['team_id', 'proposal_id', 'routine_id', 'status']) ||
    body.team_id !== teamId ||
    body.proposal_id !== proposalId ||
    !statuses.includes(body.status) ||
    (body.status === 'revoked'
      ? body.routine_id !== null
      : typeof body.routine_id !== 'string' || !ID_RE.test(body.routine_id))
  ) throw new RoutineError('routine-response-invalid');
  return { status: body.status, routineId: body.routine_id };
}

/** Criar rotina: the person's one confirmation that creates or changes the Routine a card shows. */
export async function confirmRoutineProposal(fetcher, teamId, proposalId) {
  const body = await request(fetcher, teamPath(teamId, `/proposals/${opaque(proposalId)}`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return answered(body, teamId, proposalId, ['created', 'changed']);
}

/** Cancelar: revoke a card, so nothing it shows can be created; an absent card is already revoked. */
export async function revokeRoutineProposal(fetcher, teamId, proposalId) {
  const body = await request(fetcher, teamPath(teamId, `/proposals/${opaque(proposalId)}`), { method: 'DELETE' });
  return answered(body, teamId, proposalId, ['revoked']);
}
