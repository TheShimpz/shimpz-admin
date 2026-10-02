// Team Routines (ADR-0086, ADR-0092) as the browser admits them. Each parser mirrors Team's closed protocol view and
// throws on any other shape; nothing here schedules or authorizes: Team creates a Routine from the user's own message.

import { isLocale } from './locales.js';
import { jsonObject, TEAM_ID_RE } from './validate.js';

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

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_ROUTINES = 8;
// The unresolved incidents a Team holds at most (ADR-0092); each settles through its recovery card.
export const MAX_INCIDENTS = 32;
export const MAX_DAILY_RUNS = 24;

/** A failed Routine request, named by the safe code Admin forwards. */
export class RoutineError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'RoutineError';
    this.code = code;
    this.status = status;
  }
}

function isInstant(value) {
  // Date.parse rolls impossible dates such as February 30 forward, so the instant must round-trip exactly.
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().replace('.000Z', 'Z') === value;
}

function view(value, keys, valid) {
  if (!exact(value, keys) || !valid(value)) throw new RoutineError('routine-response-invalid');
  return structuredClone(value);
}

/** One confirmed Routine as a Supervisor sees it. */
export function parseRoutineView(value) {
  const keys = [
    'routine_id', 'name', 'quote', 'steps', 'schedule', 'timezone', 'assistant_ids', 'next_run_at', 'needs_reconfirm',
    'deleting', 'paused',
  ];
  return view(value, keys, (item) =>
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isName(item.name) &&
    isSteps(item.steps) &&
    isQuote(item.quote) &&
    isSchedule(item.schedule) &&
    isTimezone(item.timezone) &&
    isAssistants(item.assistant_ids, 1) &&
    isInstant(item.next_run_at) &&
    typeof item.needs_reconfirm === 'boolean' &&
    typeof item.deleting === 'boolean' &&
    typeof item.paused === 'boolean');
}

// A Routine plan's safe projection, mirroring Team's `routine.canonical_steps` (ADR-0092): each step's Action, every
// input's source with a bounded literal preview, and the Stored Inputs its Action uses by name only.
const MAX_PREVIEW_CHARS = 120;
const MAX_STEP_INPUTS = 64;
const MAX_STEP_STORED_INPUTS = 8;
const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const POINTER_RE = /^(?:\/(?:[^/~]|~[01])*)*$/;
const CLOCK_FORMATS = ['date', 'time', 'datetime', 'epoch_seconds'];
const PLAN_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const INPUT_KEYS = {
  literal: ['member', 'source', 'value'],
  run_clock: ['member', 'source', 'value'],
  step_output: ['member', 'source', 'step', 'pointer'],
};

function plain(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !PLAN_UNSAFE_RE.test(value);
}

function isInput(value, earlier) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? INPUT_KEYS[value.source] : undefined;
  if (!keys || !exact(value, keys) || !plain(value.member, 128)) return false;
  if (value.source === 'literal') return plain(value.value, MAX_PREVIEW_CHARS);
  if (value.source === 'run_clock') return CLOCK_FORMATS.includes(value.value);
  return earlier.includes(value.step) && typeof value.pointer === 'string' && value.pointer.length <= 256 &&
    POINTER_RE.test(value.pointer) && !PLAN_UNSAFE_RE.test(value.pointer);
}

function isStep(value, earlier) {
  if (!exact(value, ['id', 'assistant', 'action', 'inputs', 'stored_inputs'])) return false;
  const { inputs, stored_inputs: stored } = value;
  if (
    typeof value.id !== 'string' || !STEP_ID_RE.test(value.id) || earlier.includes(value.id) ||
    typeof value.assistant !== 'string' || !ASSISTANT_ID_RE.test(value.assistant) ||
    typeof value.action !== 'string' || !ACTION_ID_RE.test(value.action) ||
    !Array.isArray(inputs) || inputs.length > MAX_STEP_INPUTS || !inputs.every((item) => isInput(item, earlier)) ||
    !Array.isArray(stored) || stored.length > MAX_STEP_STORED_INPUTS
  ) return false;
  const members = inputs.map((item) => item.member);
  const sortedMembers = [...new Set(members)].sort();
  const sortedStored = [...new Set(stored)].sort();
  return (
    JSON.stringify(members) === JSON.stringify(sortedMembers) &&
    stored.every((item) => typeof item === 'string' && ASSISTANT_ID_RE.test(item)) &&
    JSON.stringify(stored) === JSON.stringify(sortedStored)
  );
}

/** Whether a value is a Routine plan's safe projection: one to eight ordered steps, each naming only earlier ones. */
export function isSteps(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STEPS) return false;
  const earlier = [];
  for (const step of value) {
    if (!isStep(step, earlier)) return false;
    earlier.push(step.id);
  }
  return true;
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

// The step a held run stopped at, or both null when it sealed no plan before it was held.
function isHeldStep(assistantId, action) {
  if (assistantId === null && action === null) return true;
  return typeof assistantId === 'string' && ASSISTANT_ID_RE.test(assistantId) &&
    typeof action === 'string' && ACTION_ID_RE.test(action);
}

/** One unresolved incident of a held run, which outlives a deleted Routine (ADR-0092). */
export function parseIncidentView(value) {
  const keys = ['incident_id', 'routine_id', 'quote', 'created_at', 'assistant_id', 'action'];
  return view(value, keys, (item) =>
    typeof item.incident_id === 'string' &&
    ID_RE.test(item.incident_id) &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isQuote(item.quote) &&
    isInstant(item.created_at) &&
    isHeldStep(item.assistant_id, item.action));
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
    throw new RoutineError(code, response.status);
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

export async function deleteRoutine(fetcher, teamId, routineId) {
  return deleted(
    await request(fetcher, teamPath(teamId, `/${opaque(routineId)}`), { method: 'DELETE' }),
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

/** Turn a paused Routine's dispatch back on; an unresolved incident still holds it until its card settles it. */
export async function resumeRoutine(fetcher, teamId, routineId) {
  const body = await request(fetcher, teamPath(teamId, `/${opaque(routineId)}/resume`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!exact(body, ['team_id', 'routine_id', 'paused']) || body.team_id !== teamId || body.routine_id !== routineId
    || body.paused !== false) {
    throw new RoutineError('routine-response-invalid');
  }
  return false;
}

// A held run's recovery card (ADR-0092 section 7): exactly Verificar, Pular, and Pausar, the recommended one first.
export const CARD_CHOICES = ['verify', 'skip', 'pause'];
const CARD_VERDICTS = [
  'occurred', 'absent', 'none', 'inconclusive', 'unverifiable', 'exhausted', 'policy', 'unquiesced', 'unclassified',
];
const CARD_RUN_STATUSES = ['recovered', 'held', 'frozen', 'failed', 'stopped'];

function parseCard(body, teamId, incidentId) {
  const keys = [
    'team_id', 'incident_id', 'routine_id', 'revision', 'assistant_id', 'action', 'nonce', 'expires_in', 'choices',
    'recommended',
  ];
  return view(body, keys, (item) =>
    item.team_id === teamId &&
    item.incident_id === incidentId &&
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    Number.isInteger(item.revision) &&
    item.revision >= 1 &&
    isHeldStep(item.assistant_id, item.action) &&
    item.assistant_id !== null &&
    typeof item.nonce === 'string' &&
    NONCE_RE.test(item.nonce) &&
    item.expires_in === 300 &&
    Array.isArray(item.choices) &&
    item.choices.length === CARD_CHOICES.length &&
    CARD_CHOICES.every((choice) => item.choices.includes(choice)) &&
    ['verify', 'pause'].includes(item.recommended) &&
    item.choices[0] === item.recommended);
}

/** Open a held run's recovery card for the signed-in person; its nonce answers it once within five minutes. */
export async function openRoutineCard(fetcher, teamId, incidentId) {
  const body = await request(fetcher, teamPath(teamId, `/incidents/${opaque(incidentId)}/card`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return parseCard(body, teamId, incidentId);
}

/** Answer an open card with exactly one choice; returns Verificar's verdict and how the run went on. */
export async function answerRoutineCard(fetcher, teamId, incidentId, card, choice) {
  if (!CARD_CHOICES.includes(choice) || typeof card?.nonce !== 'string' || !NONCE_RE.test(card.nonce)) {
    throw new RoutineError('routine-request-invalid');
  }
  const body = await request(fetcher, teamPath(teamId, `/incidents/${opaque(incidentId)}/answer`), {
    method: 'POST',
    body: JSON.stringify({ nonce: card.nonce, choice }),
  });
  return view(body, ['team_id', 'incident_id', 'choice', 'verdict', 'status'], (item) => {
    if (item.team_id !== teamId || item.incident_id !== incidentId || item.choice !== choice) return false;
    if (choice === 'verify') {
      return CARD_VERDICTS.includes(item.verdict) && (item.status === null || CARD_RUN_STATUSES.includes(item.status));
    }
    return item.verdict === null && item.status === (choice === 'skip' ? 'skipped' : 'paused');
  });
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** A schedule in words for the viewer's locale; wall-clock times are in the Routine's own timezone. */
export function scheduleWords(schedule, copy, locale) {
  if (schedule.kind === 'hourly') {
    return schedule.every === 1 ? copy.hour : fill(copy.hours, { every: schedule.every });
  }
  if (schedule.kind === 'daily') return fill(copy.daily, { time: schedule.time });
  if (schedule.kind === 'weekly') {
    // 2024-01-01 was a Monday, weekday 0 in the Routine grammar.
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, 1 + schedule.weekday)),
    );
    return fill(copy.weekly, { weekday, time: schedule.time });
  }
  return fill(copy.monthly, { day: schedule.day, time: schedule.time });
}

/** A UTC instant shown in a Routine's timezone for the viewer's locale. */
export function instantWords(value, locale, timeZone) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
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
    'routine-run-not-found': copy.ended,
    'routine-incident-unavailable': copy.ended,
    'routine-card-expired': copy.expired,
    'routine-card-stale': copy.stale,
    'routine-state-unavailable': copy.unavailable,
    'team-context-unavailable': copy.unavailable,
  };
  return byCode[code] ?? copy.generic;
}

export { fill as fillRoutineCopy };

const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_NAME_CHARS = 80;
const PAUSE_REASONS = ['decided', 'unavailable', 'exhausted', 'person', 'policy', 'evidence'];
const MAX_STEPS = 8;

function closedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum && value.trim() === value;
}

// The ordered Assistant Actions a completed run carried out; never their input or result.
function isCompleted(detail) {
  return isActions(detail.actions) && detail.actions.length > 0 && detail.actions.length <= MAX_STEPS;
}

const NOTICE_DETAILS = {
  done: [['actions'], isCompleted],
  recovered: [['actions'], isCompleted],
  held: [['assistant_id', 'action'], (detail) => isHeldStep(detail.assistant_id, detail.action)],
  paused: [
    ['assistant_id', 'action', 'reason'],
    (detail) => isHeldStep(detail.assistant_id, detail.action) && PAUSE_REASONS.includes(detail.reason),
  ],
  'user-skipped': [['assistant_id', 'action'], (detail) => isHeldStep(detail.assistant_id, detail.action)],
  skipped: [['missed'], (detail) => Number.isInteger(detail.missed) && detail.missed >= 1],
  'scope-changed': [['assistants'], (detail) => isAssistantList(detail.assistants)],
  frozen: [
    ['request_kind', 'assistant_id', 'action'],
    (detail) =>
      ['human', 'integrations'].includes(detail.request_kind) &&
      typeof detail.assistant_id === 'string' &&
      ASSISTANT_ID_RE.test(detail.assistant_id) &&
      typeof detail.action === 'string' &&
      ACTION_ID_RE.test(detail.action),
  ],
  failed: [
    ['code', 'actions'],
    (detail) => typeof detail.code === 'string' && ERROR_CODE_RE.test(detail.code) && isActions(detail.actions),
  ],
  denied: [['actions'], (detail) => isActions(detail.actions)],
  stopped: [['actions'], (detail) => isActions(detail.actions)],
  created: [['name', 'steps', 'schedule', 'timezone'], isDefinition],
  changed: [['name', 'steps', 'schedule', 'timezone'], isDefinition],
};

const ROUTINE_OUTCOMES = ['skipped', 'scope-changed', 'created', 'changed'];

function isName(value) {
  return closedText(value, MAX_NAME_CHARS) && !FORBIDDEN_RE.test(value) && value.normalize('NFC') === value;
}

function isDefinition(detail) {
  return isName(detail.name) && isSteps(detail.steps) && isSchedule(detail.schedule) && isTimezone(detail.timezone);
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
    throw new RoutineError(code, response.status);
  }
  return { status: resumed(body, teamId, runId) };
}

export async function resumeRoutineIntegrations(fetcher, teamId, runId) {
  const body = await request(fetcher, teamPath(teamId, `/runs/${opaque(runId)}/integrations`), { method: 'POST' });
  return resumed(body, teamId, runId);
}
