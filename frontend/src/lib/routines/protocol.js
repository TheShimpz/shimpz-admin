// Team Routines (ADR-0086, ADR-0092, ADR-0101) as the browser admits them. Admin already admits every Routine answer
// through Team's mirrored canonical forms, so each parser here keeps only what rendering needs to be safe: exact keys,
// types, bounded and safe strings, identifiers, the keys a list renders by, and the bindings to the request it answers.
// It throws on anything else; nothing here schedules or authorizes: a Routine exists only once the person confirms the
// card Team recorded from a chat turn.

import { isLocale } from '../i18n/locales.js';
import { parseRunUsage } from '../chat/usage.js';
import { exactKeys, jsonObject } from '../api.js';
import { codePointLength, isInstant } from '../grammar.js';
import { DIGEST_RE, isActionId, isAssistantId, isIdentifier, OPAQUE_ID_RE, TEAM_ID_RE } from '../ids.js';

const ENCODER = new TextEncoder();

const FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
const TIME_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9_+-]{0,31}){0,2}$/;
const SCHEDULE_FIELDS = {
  daily: ['kind', 'time'],
  weekly: ['kind', 'weekday', 'time'],
  monthly: ['kind', 'day', 'time'],
  continuous: ['kind', 'gap'],
};

function whole(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** The exact closed schedule, or false. */
export function isSchedule(value) {
  const fields = value && typeof value === 'object' ? SCHEDULE_FIELDS[value.kind] : undefined;
  if (!fields || !exactKeys(value, fields)) return false;
  if (value.kind === 'continuous') return whole(value.gap, MIN_CONTINUOUS_GAP_SECONDS, MAX_CONTINUOUS_GAP_SECONDS);
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
const TIMEZONE_SOURCES = ['browser', 'person', 'none'];

/** Whether a timezone and its source are each in their closed forms (ADR-0101). */
export function isZoned(timezone, source) {
  return TIMEZONE_SOURCES.includes(source) && isTimezone(timezone);
}

const MAX_ROUTINES = 8;
// The unresolved incidents a Team holds at most (ADR-0092); each settles through its recovery card.
const MAX_INCIDENTS = 32;
const DAY_SECONDS = 86400;
const MIN_CONTINUOUS_GAP_SECONDS = 5;
const MAX_CONTINUOUS_GAP_SECONDS = 366 * DAY_SECONDS;
// Runs start their gap apart, but one after an overrun or a confirmed change starts at once: one a second.
const MAX_ROLLUP_RUNS = 60;

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
  if (!exactKeys(value, keys) || !valid(value)) throw new RoutineError('routine-response-invalid');
  return structuredClone(value);
}

// A Routine's state (ADR-0101): it runs, or a person paused it.
const ROUTINE_STATES = ['active', 'paused'];

/** One confirmed Routine as a Supervisor sees it. */
export function parseRoutineView(value) {
  const keys = [
    'routine_id', 'name', 'plan', 'output', 'schedule', 'timezone', 'timezone_source', 'next_run_at',
    'needs_reconfirm', 'deleting', 'state',
  ];
  return view(value, keys, (item) =>
    typeof item.routine_id === 'string' &&
    OPAQUE_ID_RE.test(item.routine_id) &&
    isName(item.name) &&
    isSummary(item.plan) &&
    isDisposition(item.output, item.plan.steps) &&
    isSchedule(item.schedule) &&
    isZoned(item.timezone, item.timezone_source) &&
    isInstant(item.next_run_at) &&
    typeof item.needs_reconfirm === 'boolean' &&
    typeof item.deleting === 'boolean' &&
    ROUTINE_STATES.includes(item.state));
}

// A Routine plan's safe projection, mirroring Team's `routine.canonical_step` (ADR-0092, ADR-0101): each step's Action,
// whether it only reads, every input's source with a bounded literal preview, and the Stored Inputs its Action uses by
// name only. On the wire a step is named by its 1-based position in its revision's plan, and a reference names the
// earlier step it selects from by position, and through an array item its selecting member and the item's pointer.
export const MAX_ROUTINE_STEPS = 256;
const MAX_PREVIEW_CHARS = 120;
const MAX_STEP_INPUTS = 64;
const MAX_STEP_STORED_INPUTS = 8;
// A page holds whole consecutive steps: at most this many.
const MAX_PAGE_STEPS = 64;
// A plan summary names its Actions as runs of consecutive equal Actions, at most this many.
const MAX_SUMMARY_RUNS = 16;
const POINTER_RE = /^(?:\/(?:[^/~]|~[01])*)*$/;
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

// Each value once, as the list that renders them is keyed by it.
function distinct(values) {
  return new Set(values).size === values.length;
}

// Members each once, as a step's inputs render keyed by member.
function distinctMembers(items) {
  return distinct(items.map((item) => item.member));
}

function isPointer(value) {
  return typeof value === 'string' && codePointLength(value) <= 256 && POINTER_RE.test(value) &&
    !PLAN_UNSAFE_RE.test(value);
}

/** A selector constant as Team shows it: its JSON text with every control or invisible character escaped. */
function whereText(constant) {
  return escapedText(JSON.stringify(constant));
}

// A selector as shown: its member and its constant's escaped JSON text, a string or an integer.
function isWhere(value) {
  if (!exactKeys(value, ['member', 'value_json']) || !plain(value.member, 128) || !plain(value.value_json, MAX_WHERE_CHARS)) {
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
  if (!keys || !exactKeys(value, keys) || !plain(value.member, 128)) return false;
  if (value.source === 'literal') return plain(value.value, MAX_PREVIEW_CHARS);
  // The run date, or the preview of a dated text's template as a person reads it.
  if (value.source === 'run_clock') return plain(value.value, MAX_PREVIEW_CHARS);
  return isReference(value, position);
}

/** Whether a value is one projected step at exactly `position`, referring only to earlier positions. */
export function isPlanStep(value, position) {
  if (!exactKeys(value, ['position', 'assistant', 'action', 'read_only', 'inputs', 'stored_inputs'])) return false;
  const { inputs, stored_inputs: stored } = value;
  return (
    isPosition(position) &&
    value.position === position &&
    isAssistantId(value.assistant) &&
    isActionId(value.action) &&
    typeof value.read_only === 'boolean' &&
    Array.isArray(inputs) && inputs.length <= MAX_STEP_INPUTS && inputs.every((item) => isInput(item, position)) &&
    distinctMembers(inputs) &&
    Array.isArray(stored) && stored.length <= MAX_STEP_STORED_INPUTS &&
    stored.every(isIdentifier) && distinct(stored)
  );
}

/**
 * Whether a value is a revision's plan summary in Team's `routine.canonical_summary` form: its revision and digest, its
 * step count, its Actions as runs of `[assistant, action, count]`, and `more`, the steps after them.
 */
export function isSummary(value) {
  if (!exactKeys(value, ['revision', 'plan_digest', 'steps', 'actions', 'more'])) return false;
  const { actions: runs, more, steps: total } = value;
  return (
    whole(value.revision, 1, 2 ** 31 - 1) &&
    typeof value.plan_digest === 'string' && DIGEST_RE.test(value.plan_digest) &&
    whole(total, 1, MAX_ROUTINE_STEPS) &&
    Array.isArray(runs) && runs.length > 0 && runs.length <= MAX_SUMMARY_RUNS &&
    runs.every((run) => Array.isArray(run) && run.length === 3 && isAssistantId(run[0]) && isActionId(run[1]) &&
      isPosition(run[2])) &&
    whole(more, 0, MAX_ROUTINE_STEPS)
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
    next === (offset + steps.length === total ? null : offset + steps.length)
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
export async function readPlanSteps(call, teamId, routineId, plan, offset) {
  if (!isSummary(plan)) throw new RoutineError('routine-request-invalid');
  const body = await request(call, 'routines.plan_steps', {
    team_id: team(teamId),
    routine_id: opaque(routineId),
    revision: revisionPath(plan.revision),
    offset: offsetPath(offset),
  });
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

function isRunInput(value) {
  return exactKeys(value, ['member', 'source', 'value']) && plain(value.member, 128) &&
    RUN_INPUT_SOURCES.includes(value.source) && (value.value === null || plain(value.value, MAX_PREVIEW_CHARS));
}

/** Whether a value is a call's position: its step's 1-based position among `steps`. */
function isCallPosition(value, steps) {
  return whole(steps, 0, MAX_ROUTINE_STEPS) && isPosition(value, steps);
}

/** Whether a value is one run entry at exactly `position`: what its attempt did, or only that it never ran or is gone. */
export function isRunStep(value, position, steps) {
  if (!exactKeys(value, RUN_STEP_KEYS) || !isCallPosition(value.position, steps) || value.position !== position) {
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
      value.inputs.every(isRunInput) && distinctMembers(value.inputs)))
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
  if (!exactKeys(value, ['routine_id', 'revision', 'plan_digest', 'total'])) return false;
  const { routine_id: routineId, revision, plan_digest: digest, total } = value;
  const known = whole(revision, 1, 2 ** 31 - 1) && typeof digest === 'string' && DIGEST_RE.test(digest) &&
    whole(total, 1, MAX_ROUTINE_STEPS);
  return typeof routineId === 'string' && OPAQUE_ID_RE.test(routineId) &&
    (known || (revision === null && digest === null && total === null));
}

/**
 * One page of what a run did from `offset`, bound to the run's historical `binding` (`runBinding`) and to one
 * `snapshot` of its retained records. `latest` asks for the current snapshot, which the page names; any other page is
 * admitted only for exactly that snapshot, and Team refuses one whose records changed since (`routine-run-changed`).
 */
export async function readRunSteps(call, teamId, runId, binding, snapshot, offset) {
  if (!isBinding(binding) || (snapshot !== 'latest' && (typeof snapshot !== 'string' || !OPAQUE_ID_RE.test(snapshot)))) {
    throw new RoutineError('routine-request-invalid');
  }
  const body = await request(call, 'routines.run_steps', {
    team_id: team(teamId),
    run_id: opaque(runId),
    snapshot,
    offset: offsetPath(offset),
  });
  const keys = [
    'team_id', 'run_id', 'routine_id', 'revision', 'plan_digest', 'total', 'snapshot', 'ended', 'offset', 'steps',
    'next',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    whole(item.revision, 1, 2 ** 31 - 1) &&
    typeof item.plan_digest === 'string' && DIGEST_RE.test(item.plan_digest) &&
    Object.entries(binding).every(([key, expected]) => expected === null || item[key] === expected) &&
    typeof item.snapshot === 'string' && OPAQUE_ID_RE.test(item.snapshot) &&
    (snapshot === 'latest' || item.snapshot === snapshot) &&
    typeof item.ended === 'boolean' &&
    item.offset === offset &&
    isPageOf(item, (step, index) => isRunStep(step, index, item.total)));
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
// A number is its exact JSON text, so the browser never rounds it.
const MAX_OUTPUT_NUMBER_CHARS = 64;
const OUTPUT_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const SCALAR_NODES = {
  null: (node) => exactKeys(node, ['kind']),
  redacted: (node) => exactKeys(node, ['kind']),
  elided: (node) => exactKeys(node, ['kind']),
  bool: (node) => exactKeys(node, ['kind', 'value']) && typeof node.value === 'boolean',
  number: (node) =>
    exactKeys(node, ['kind', 'value']) &&
    typeof node.value === 'string' &&
    node.value.length <= MAX_OUTPUT_NUMBER_CHARS &&
    OUTPUT_NUMBER_RE.test(node.value),
  text: (node) =>
    exactKeys(node, ['kind', 'value', 'cut']) &&
    typeof node.cut === 'boolean' &&
    typeof node.value === 'string' &&
    codePointLength(node.value) <= MAX_OUTPUT_TEXT_CHARS &&
    !PLAN_UNSAFE_RE.test(node.value),
};

/**
 * Whether a plan's output disposition is closed: it names one of its `total` steps' positions when it shows one.
 */
export function isDisposition(value, total) {
  if (!exactKeys(value, ['mode', 'step']) || !OUTPUT_MODES.includes(value.mode)) return false;
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
    return exactKeys(node, ['kind', 'items', 'omitted']) && Array.isArray(node.items) &&
      node.items.length <= MAX_OUTPUT_ITEMS && node.items.every((item) => isOutputNode(item, depth + 1));
  }
  return exactKeys(node, ['kind', 'fields', 'omitted']) && Array.isArray(node.fields) &&
    node.fields.length <= MAX_OUTPUT_FIELDS &&
    node.fields.every((field) => Array.isArray(field) && field.length === 2 && plain(field[0], MAX_OUTPUT_KEY_CHARS) &&
      isOutputNode(field[1], depth + 1)) &&
    new Set(node.fields.map((field) => field[0])).size === node.fields.length;
}

/** Whether a completed run's output is Team's closed form: a shown projection, or unchanged or unavailable alone. */
export function isOutput(value) {
  return exactKeys(value, ['step', 'state', 'value', 'truncated']) &&
    isPosition(value.step) &&
    OUTPUT_STATES.includes(value.state) &&
    typeof value.truncated === 'boolean' &&
    (value.state === 'shown' ? isOutputNode(value.value, 0) : value.value === null);
}

// What a frozen run waits for: a person's answer or an Integration.
const REQUEST_KINDS = ['human', 'integrations'];

/** One live run: a frozen run names its request and its call; a leased or held one only that it is live. */
export function parseRunView(value) {
  const keys = ['run_id', 'routine_id', 'status', 'request_kind', 'assistant_id', 'action'];
  return view(value, keys, (item) => {
    const request = [item.request_kind, item.assistant_id, item.action];
    const frozen =
      REQUEST_KINDS.includes(item.request_kind) && isAssistantId(item.assistant_id) && isActionId(item.action);
    return (
      typeof item.run_id === 'string' &&
      OPAQUE_ID_RE.test(item.run_id) &&
      typeof item.routine_id === 'string' &&
      OPAQUE_ID_RE.test(item.routine_id) &&
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

/** One unresolved incident of a held run (ADR-0092): its Routine and the call whose effect is unknown. */
export function parseIncidentView(value) {
  const keys = ['run_id', 'routine_id', 'assistant_id', 'action', 'position', 'steps'];
  return view(value, keys, (item) =>
    typeof item.run_id === 'string' &&
    OPAQUE_ID_RE.test(item.run_id) &&
    typeof item.routine_id === 'string' &&
    OPAQUE_ID_RE.test(item.routine_id) &&
    isHeldStep(item));
}

// One Routine operation over the Admin session socket (ADR-0114): `call(method, params)` answers as the socket does.
// A change the socket lost before Admin answered rejects with `outcome-unknown` and is never replayed.
async function request(call, method, params) {
  if (typeof call !== 'function') throw new RoutineError('routine-request-invalid');
  return admitted(await call(method, params));
}

// The refusal an answer names: its safe code and how long to wait before asking again, if it says so.
function refusal(response, body) {
  const code = typeof body.code === 'string' && ERROR_CODE_RE.test(body.code) ? body.code : 'routine-request-failed';
  const retryAfter = Number.isInteger(body.retry_after) && body.retry_after > 0 && body.retry_after <= 3600 ? body.retry_after : 0;
  return new RoutineError(code, response.status, retryAfter);
}

// Admin's answer, a session socket result: its body, or the refusal it names.
async function admitted(response) {
  const body = await jsonObject(response);
  if (!response.ok) throw refusal(response, body);
  return body;
}

function team(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new RoutineError('routine-request-invalid');
  return teamId;
}

function opaque(value) {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) throw new RoutineError('routine-request-invalid');
  return value;
}

/** The browser's IANA timezone, the default zone of a Routine a chat message creates, or null when it is unknown. */
export function browserTimezone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimezone(zone) ? zone : null;
}

function deleted(body, teamId, routineId = null) {
  if (
    !exactKeys(body, ['team_id', 'routine_id', 'deleted']) ||
    body.team_id !== teamId ||
    typeof body.deleted !== 'boolean' ||
    typeof body.routine_id !== 'string' ||
    !OPAQUE_ID_RE.test(body.routine_id) ||
    (routineId !== null && body.routine_id !== routineId)
  ) {
    throw new RoutineError('routine-response-invalid');
  }
  return { deleted: body.deleted };
}

export async function listRoutines(read, teamId) {
  const body = await request(read, 'routines.list', { team_id: team(teamId) });
  if (
    !exactKeys(body, ['team_id', 'routines', 'runs', 'incidents']) ||
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
export async function beginRoutineDeletion(call, teamId, routineId, password) {
  if (typeof password !== 'string' || password.length < 1) throw new RoutineError('routine-request-invalid');
  const body = await request(call, 'routines.deletion', {
    team_id: team(teamId),
    routine_id: opaque(routineId),
    body: { password },
  });
  const methods = body.methods;
  const passkey = Array.isArray(methods) && methods.length === 2 && methods[0] === 'totp' && methods[1] === 'passkey';
  const totpOnly = Array.isArray(methods) && methods.length === 1 && methods[0] === 'totp';
  if (totpOnly && exactKeys(body, ['methods'])) return { passkey: null };
  if (passkey && exactKeys(body, ['methods', 'passkey_options']) && body.passkey_options && typeof body.passkey_options === 'object') {
    return { passkey: body.passkey_options };
  }
  throw new RoutineError('routine-response-invalid');
}

/** Spend the started deletion on exactly one second factor, `{ code }` or `{ credential }`; Admin then asks Team. */
export async function deleteRoutine(call, teamId, routineId, proof) {
  const byCode = exactKeys(proof, ['code']) && /^[0-9]{6}$/.test(proof.code);
  const byPasskey = exactKeys(proof, ['credential']) && proof.credential && typeof proof.credential === 'object';
  if (!byCode && !byPasskey) throw new RoutineError('routine-request-invalid');
  const params = { team_id: team(teamId), routine_id: opaque(routineId), body: proof };
  return deleted(await request(call, 'routines.delete', params), teamId, routineId);
}

async function setPaused(call, teamId, routineId, paused) {
  const params = { team_id: team(teamId), routine_id: opaque(routineId) };
  const body = await request(call, paused ? 'routines.pause' : 'routines.resume', params);
  if (!exactKeys(body, ['team_id', 'routine_id', 'paused']) || body.team_id !== teamId || body.routine_id !== routineId
    || body.paused !== paused) {
    throw new RoutineError('routine-response-invalid');
  }
  return paused;
}

/** Turn a paused Routine's dispatch back on; an unresolved incident still holds it until its card settles it. */
export function resumeRoutine(call, teamId, routineId) {
  return setPaused(call, teamId, routineId, false);
}

/** Turn a Routine's dispatch off until it is resumed; a run already going finishes. */
export function pauseRoutine(call, teamId, routineId) {
  return setPaused(call, teamId, routineId, true);
}

// Exactly Team's unsafe set (`routine.escaped`): controls, bidi and zero-width formatting, line and paragraph
// separators, the BOM, and, in this Unicode-mode class, a lone surrogate.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ud800-\udfff\ufeff]/gu;

/** Text with every character in Team's unsafe set written back as its JSON unicode escape, as Team writes it. */
export function escapedText(text) {
  return text.replace(UNSAFE_TEXT_RE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// A held run's recovery card (ADR-0092 section 7, ADR-0101): Rodar and Excluir, in this order, none recommended. Team
// answers Rodar; Excluir is the Routine's own confirmed deletion. The card carries the entity tag of the held run's state,
// which Rodar names alone so Team applies it only to exactly that state (RFC 9110 If-Match).
const TAG_RE = /^[0-9a-f]{64}$/;
const CARD_EVIDENCE = ['recorded', 'absent', 'unavailable'];

// The held operation's latest diagnostic, exactly when Team recorded one.
function isCardEvidence(item) {
  if (!CARD_EVIDENCE.includes(item.evidence) || (item.diagnostic === null) === (item.evidence === 'recorded')) {
    return false;
  }
  return item.diagnostic === null || isDiagnostic(item.diagnostic);
}

function parseCard(body, teamId, runId) {
  const keys = [
    'team_id', 'run_id', 'routine_id', 'revision', 'assistant_id', 'action', 'position', 'steps', 'evidence',
    'diagnostic', 'tag',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    typeof item.routine_id === 'string' &&
    OPAQUE_ID_RE.test(item.routine_id) &&
    Number.isInteger(item.revision) &&
    item.revision >= 1 &&
    isAssistantId(item.assistant_id) &&
    isActionId(item.action) &&
    isCallPosition(item.position, item.steps) &&
    isCardEvidence(item) &&
    typeof item.tag === 'string' &&
    TAG_RE.test(item.tag));
}

/** Open a held run's recovery card for the signed-in person, with the tag of the state it shows. */
export async function openRoutineCard(call, teamId, runId) {
  const body = await request(call, 'routines.card', { team_id: team(teamId), run_id: opaque(runId) });
  return parseCard(body, teamId, runId);
}

/**
 * Answer an open card with Rodar, its tag alone; Team sets the held run aside and requests one fresh run. Team refuses
 * it as `routine-card-stale` once the held run's state no longer has the card's tag. Excluir is the confirmed deletion.
 */
export async function answerRoutineCard(call, teamId, runId, card) {
  if (typeof card?.tag !== 'string' || !TAG_RE.test(card.tag)) {
    throw new RoutineError('routine-request-invalid');
  }
  const body = await request(call, 'routines.card_answer', {
    team_id: team(teamId),
    run_id: opaque(runId),
    body: { tag: card.tag },
  });
  return view(body, ['team_id', 'run_id'], (item) => item.team_id === teamId && item.run_id === runId);
}

const MAX_NAME_CHARS = 80;
// The recording agent's plain-language description on a card (Team's MAX_ROUTINE_DESCRIPTION_CHARS).
const MAX_DESCRIPTION_CHARS = 600;
const PAUSE_REASONS = ['exhausted', 'policy', 'evidence'];

function closedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum && value.trim() === value;
}

// The summary of the plan a completed run carried out, never an input, and the result it shows, if any.
function isCompleted(detail) {
  return isSummary(detail.plan) && (detail.output === null || isOutput(detail.output));
}

const COMPLETED_KEYS = ['plan', 'output'];
// Consecutive failed runs that pause a Routine (ADR-0092 section 6).
const MAX_FAILURE_STREAK = 3;
const NOTHING = [[], () => true];

// What Admin keeps of each notice it stores: only the detail a view renders. A Routine's change, deletion, and scope
// change show nowhere, so Admin never stores them.
const NOTICE_DETAILS = {
  done: [COMPLETED_KEYS, isCompleted],
  recovered: [COMPLETED_KEYS, isCompleted],
  held: NOTHING,
  paused: [['reason'], (detail) => PAUSE_REASONS.includes(detail.reason)],
  // A person set the held run aside: Rodar, or the deletion of its Routine.
  'user-skipped': NOTHING,
  skipped: [['missed'], (detail) => Number.isInteger(detail.missed) && detail.missed >= 1],
  healthy: [['runs'], (detail) => whole(detail.runs, 1, MAX_ROLLUP_RUNS)],
  frozen: [['request_kind'], (detail) => REQUEST_KINDS.includes(detail.request_kind)],
  failed: [['code'], (detail) => typeof detail.code === 'string' && ERROR_CODE_RE.test(detail.code)],
  denied: NOTHING,
  stopped: NOTHING,
  // A Routine's creation names it and says nothing else (ADR-0101).
  created: NOTHING,
  // Its consecutive failed runs paused the Routine, and how many.
  'streak-paused': [['failures'], (detail) => whole(detail.failures, 1, MAX_FAILURE_STREAK)],
};

// `healthy` rolls up a continuous Routine's healthy runs that ended in one minute (ADR-0092 section 9); `streak-paused`
// says a failure streak paused it (ADR-0092 section 6).
const ROUTINE_OUTCOMES = ['skipped', 'created', 'healthy', 'streak-paused'];

/** Whether a value is a Routine name in Team's closed form: one plain NFC line of at most 80 characters. */
export function isName(value, maximum = MAX_NAME_CHARS) {
  return closedText(value, maximum) && !FORBIDDEN_RE.test(value) && value.normalize('NFC') === value;
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
    !exactKeys(value, keys) ||
    value.kind !== 'routine-run' ||
    !rule ||
    typeof value.notice_id !== 'string' ||
    !OPAQUE_ID_RE.test(value.notice_id) ||
    value.id !== `${value.notice_id}:routine` ||
    typeof value.routine_id !== 'string' ||
    !OPAQUE_ID_RE.test(value.routine_id) ||
    !isName(value.name) ||
    (value.run_id !== null && (typeof value.run_id !== 'string' || !OPAQUE_ID_RE.test(value.run_id))) ||
    !isInstant(value.created_at) ||
    !Number.isInteger(value.version) ||
    value.version < 1 ||
    !exactKeys(value.detail, rule[0]) ||
    !rule[1](value.detail) ||
    typeof value.protection_lost !== 'boolean'
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

/**
 * Open a frozen run's fresh challenge, or learn that it waits for an Integration. Team renders the request copy in the
 * interface language named here, so a different language always opens a fresh challenge (ADR-0091).
 */
export async function openRoutineChallenge(call, teamId, runId, locale, parseChallenge) {
  if (!isLocale(locale)) throw new RoutineError('routine-request-invalid');
  const body = await request(call, 'routines.challenge', { team_id: team(teamId), run_id: opaque(runId), body: { locale } });
  if (exactKeys(body, ['team_id', 'run_id', 'status']) && body.status === 'integrations-required'
    && body.team_id === teamId && body.run_id === runId) {
    return { status: 'integrations-required' };
  }
  if (!exactKeys(body, ['team_id', 'run_id', 'status', 'challenge']) || body.status !== 'human-required'
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
  // card shows no input rows (ADR-0101 §6).
  if (challenge.locale !== locale || challenge.input) {
    throw new RoutineError('routine-response-invalid');
  }
  return { status: 'human-required', challenge };
}

function resumed(body, teamId, runId) {
  if (
    !exactKeys(body, ['team_id', 'run_id', 'status']) ||
    body.team_id !== teamId ||
    body.run_id !== runId ||
    !['done', 'recovered', 'failed', 'denied', 'stopped', 'frozen', 'held'].includes(body.status)
  ) throw new RoutineError('routine-response-invalid');
  return body.status;
}

/**
 * Answer the open challenge with chat's exact human-response frame; the run then resumes or ends. Admin answers once the
 * run stops again, which may take as long as the run's active time; a socket lost meanwhile leaves the outcome unknown.
 */
export async function answerRoutineChallenge(call, teamId, runId, frame) {
  if (typeof call !== 'function') throw new RoutineError('routine-request-invalid');
  const response = await call('routines.human', { team_id: team(teamId), run_id: opaque(runId), body: frame });
  const body = await jsonObject(response);
  // A wrong password keeps the challenge open, as in chat.
  if (response.status === 409 && ['authentication-denied', 'authentication-locked'].includes(body.code)) {
    const { code: _code, ...rejection } = body;
    return { rejection };
  }
  if (!response.ok) throw refusal(response, body);
  return { status: resumed(body, teamId, runId) };
}

export async function resumeRoutineIntegrations(call, teamId, runId) {
  const body = await request(call, 'routines.integrations', { team_id: team(teamId), run_id: opaque(runId) });
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
    exactKeys(value, ['error_type', 'message', 'provider', 'http_status', 'response_excerpt', 'redacted', 'truncated']) &&
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
    exactKeys(value, ['operation_id', 'attempt', 'assistant_id', 'action', 'position', 'recorded_at', 'failure', 'condition']) &&
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

/** One run's execution details for exactly the Team and run asked for, each attempt once, in Team's order. */
export async function readRunDiagnostics(call, teamId, runId) {
  const body = await request(call, 'routines.diagnostics', { team_id: team(teamId), run_id: opaque(runId) });
  return view(body, ['team_id', 'run_id', 'diagnostics'], (item) =>
    item.team_id === teamId &&
    item.run_id === runId &&
    Array.isArray(item.diagnostics) &&
    item.diagnostics.length <= MAX_RUN_DIAGNOSTICS &&
    item.diagnostics.every(isDiagnostic) &&
    distinct(item.diagnostics.map((entry) => `${entry.operation_id}:${entry.attempt}`))).diagnostics;
}

// The confirmation card of a recorded Routine (ADR-0101, amended 2026-10-15), mirroring Team's
// `routine.canonical_proposal`: the recording agent's description, which states the schedule and the output, and every
// step with its effect, every literal complete and escaped, every source and selector described completely. Nothing in
// it is paged or cut.
const INPUT_ORIGINS = ['request', 'assistant', 'clock', 'step', 'selector'];
const CARD_INPUT_KEYS = ['member', 'origin', 'value', 'step', 'pointer', 'where', 'item'];

function isCardInput(value, position) {
  if (!exactKeys(value, CARD_INPUT_KEYS) || !INPUT_ORIGINS.includes(value.origin) || !plain(value.member, 128)) return false;
  const others = (keys) => keys.every((key) => value[key] === null);
  if (value.origin === 'request' || value.origin === 'assistant') {
    return typeof value.value === 'string' && !PLAN_UNSAFE_RE.test(value.value) &&
      others(['step', 'pointer', 'where', 'item']);
  }
  if (value.origin === 'clock') {
    // The run date alone, or a text template complete, each of its dates in braces.
    const template = value.value === null ||
      (typeof value.value === 'string' && value.value.includes('{') && !PLAN_UNSAFE_RE.test(value.value));
    return template && others(['step', 'pointer', 'where', 'item']);
  }
  return value.value === null && (value.where !== null) === (value.origin === 'selector') && isReference(value, position);
}

function isCardStep(value, position) {
  return exactKeys(value, ['position', 'assistant', 'action', 'read_only', 'inputs']) &&
    value.position === position &&
    isAssistantId(value.assistant) &&
    isActionId(value.action) &&
    typeof value.read_only === 'boolean' &&
    Array.isArray(value.inputs) && value.inputs.length <= MAX_STEP_INPUTS &&
    value.inputs.every((item) => isCardInput(item, position)) && distinctMembers(value.inputs);
}

/**
 * The Routine card a recording turn's reply carries, admitted exactly as Team's closed form, or a thrown
 * `routine-response-invalid`. It is the one thing the person confirms.
 */
export function parseRoutineProposal(value) {
  const keys = ['proposal_id', 'expires_at', 'replaces', 'name', 'description', 'steps'];
  return view(value, keys, (item) => {
    const { steps } = item;
    return (
      typeof item.proposal_id === 'string' && OPAQUE_ID_RE.test(item.proposal_id) &&
      isInstant(item.expires_at) &&
      (item.replaces === null || (typeof item.replaces === 'string' && OPAQUE_ID_RE.test(item.replaces))) &&
      isName(item.name) &&
      isName(item.description, MAX_DESCRIPTION_CHARS) &&
      Array.isArray(steps) && steps.length > 0 && steps.length <= MAX_ROUTINE_STEPS &&
      steps.every((step, index) => isCardStep(step, index + 1))
    );
  });
}

/** Why a recording turn made no card: one closed code; nothing was created. */
export function parseRoutineRefusal(value) {
  return view(value, ['code'], (item) => typeof item.code === 'string' && ERROR_CODE_RE.test(item.code));
}

// What Team asks the person before a recording can become a card (ADR-0101): the span is kept, and the person's answer
// is an ordinary send. Only an ambiguous binding offers targets; an interval over budget carries the shortest that fits;
// what to do with each run's result is answered with the Team protocol's own three labels, which Team reads back.
export const QUESTION_CODES = [
  'routine-schedule-unstated',
  'routine-interval-over-budget',
  'routine-binding-ambiguous',
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
  return exactKeys(value, ['value', 'label']) && questionTarget(value.value) !== null &&
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

function answered(body, teamId, proposalId, statuses) {
  if (
    !exactKeys(body, ['team_id', 'proposal_id', 'routine_id', 'status']) ||
    body.team_id !== teamId ||
    body.proposal_id !== proposalId ||
    !statuses.includes(body.status) ||
    (body.status === 'revoked'
      ? body.routine_id !== null
      : typeof body.routine_id !== 'string' || !OPAQUE_ID_RE.test(body.routine_id))
  ) throw new RoutineError('routine-response-invalid');
  return { status: body.status, routineId: body.routine_id };
}

/** Criar: the person's one confirmation that creates or changes the Routine a card shows. */
export async function confirmRoutineProposal(call, teamId, proposalId) {
  const body = await request(call, 'routines.proposal_confirm', { team_id: team(teamId), proposal_id: opaque(proposalId) });
  return answered(body, teamId, proposalId, ['created', 'changed']);
}

/** Cancelar: revoke a card, so nothing it shows can be created; an absent card is already revoked. */
export async function revokeRoutineProposal(call, teamId, proposalId) {
  const body = await request(call, 'routines.proposal_revoke', { team_id: team(teamId), proposal_id: opaque(proposalId) });
  // A card already confirmed answers with the Routine its confirmation created or changed.
  return answered(body, teamId, proposalId, ['revoked', 'created', 'changed']);
}
