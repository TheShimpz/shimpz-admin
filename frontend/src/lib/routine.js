// Team Routines (ADR-0086) as the browser admits them. Each parser mirrors Team's closed protocol view and throws on
// any other shape; nothing here schedules or authorizes: a Routine exists only after a Supervisor confirms it.

import { isLocale } from './locales.js';
import { jsonObject, TEAM_ID_RE } from './validate.js';

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

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RATE_RE = /^(?:0|[1-9][0-9]*)(?:\/[1-9][0-9]*)?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_ROUTINES = 8;
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

/** Whether a live preview shows exactly the proposal a card saved; only then may the card confirm it. */
export function previewMatches(proposal, preview) {
  return (
    preview.proposal_id === proposal.proposal_id &&
    preview.op === proposal.op &&
    preview.quote === proposal.quote &&
    JSON.stringify(preview.schedule) === JSON.stringify(proposal.schedule) &&
    preview.routine_id === proposal.routine_id &&
    JSON.stringify(preview.assistant_ids) === JSON.stringify(proposal.assistant_ids) &&
    (proposal.timezone === null || preview.timezone === proposal.timezone)
  );
}

/** A proposal with its card's live facts: the timezone, the next runs, and the Team's daily run budget. */
export function parseRoutinePreview(value) {
  const facts = ['timezone', 'next_runs', 'daily_runs', 'max_daily_runs', 'fits'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !facts.every((key) => Object.hasOwn(value, key))) {
    throw new RoutineError('routine-response-invalid');
  }
  const proposal = { ...value };
  for (const key of facts) delete proposal[key];
  let parsed;
  try {
    // The proposal's own keys are exact, so the preview holds exactly those and its facts.
    parsed = parseRoutineProposal({ ...proposal, timezone: value.op === 'propose' ? null : value.timezone });
  } catch {
    throw new RoutineError('routine-response-invalid');
  }
  const runs = value.next_runs;
  const valid = parsed.op === 'cancel'
    ? value.timezone === null && Array.isArray(runs) && runs.length === 0 && value.daily_runs === null
      && value.max_daily_runs === null && value.fits === true
    : isTimezone(value.timezone) &&
      Array.isArray(runs) &&
      runs.length > 0 &&
      runs.length <= 3 &&
      runs.every(isInstant) &&
      runs.every((item, index) => index === 0 || runs[index - 1] < item) &&
      typeof value.daily_runs === 'string' &&
      RATE_RE.test(value.daily_runs) &&
      value.max_daily_runs === MAX_DAILY_RUNS &&
      typeof value.fits === 'boolean';
  if (!valid) throw new RoutineError('routine-response-invalid');
  return {
    ...parsed,
    timezone: value.timezone,
    next_runs: [...runs],
    daily_runs: value.daily_runs,
    max_daily_runs: value.max_daily_runs,
    fits: value.fits,
  };
}

/** One confirmed Routine as a Supervisor sees it. */
export function parseRoutineView(value) {
  const keys = ['routine_id', 'quote', 'schedule', 'timezone', 'assistant_ids', 'next_run_at', 'needs_reconfirm', 'deleting'];
  return view(value, keys, (item) =>
    typeof item.routine_id === 'string' &&
    ID_RE.test(item.routine_id) &&
    isQuote(item.quote) &&
    isSchedule(item.schedule) &&
    isTimezone(item.timezone) &&
    isAssistants(item.assistant_ids, 1) &&
    isInstant(item.next_run_at) &&
    typeof item.needs_reconfirm === 'boolean' &&
    typeof item.deleting === 'boolean');
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

/** One live run: a frozen run names its request; an uncertain one its batch and the Actions it may have run. */
export function parseRunView(value) {
  const keys = [
    'run_id', 'routine_id', 'status', 'scheduled_at', 'request_kind', 'assistant_id', 'action', 'batch_fingerprint', 'actions',
  ];
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
      ['leased', 'frozen', 'uncertain'].includes(item.status) &&
      (item.status === 'frozen' ? frozen : request.every((part) => part === null)) &&
      (item.status === 'uncertain'
        ? typeof item.batch_fingerprint === 'string' && HEX64_RE.test(item.batch_fingerprint)
        : item.batch_fingerprint === null) &&
      isActions(item.actions) &&
      (item.status === 'uncertain' || item.actions.length === 0)
    );
  });
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

/** The browser's IANA timezone, used only when the user named none in the request. */
export function browserTimezone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimezone(zone) ? zone : 'UTC';
}

export async function previewRoutine(fetcher, teamId, proposalId, timezone) {
  const body = await request(fetcher, teamPath(teamId, `/proposals/${opaque(proposalId)}/preview`), {
    method: 'POST',
    body: JSON.stringify({ timezone }),
  });
  const preview = parseRoutinePreview(body);
  // The card confirms exactly the proposal it previewed.
  if (preview.proposal_id !== proposalId) throw new RoutineError('routine-response-invalid');
  return preview;
}

/** Confirm a card: a proposal creates its Routine; a cancel card deletes one. */
export async function confirmRoutine(fetcher, teamId, proposalId, timezone) {
  const body = await request(fetcher, teamPath(teamId), {
    method: 'POST',
    body: JSON.stringify({ proposal_id: opaque(proposalId), timezone }),
  });
  if (exact(body, ['team_id', 'routine']) && body.team_id === teamId) {
    return { routine: parseRoutineView(body.routine) };
  }
  return deleted(body, teamId);
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
    !exact(body, ['team_id', 'routines', 'runs']) ||
    body.team_id !== teamId ||
    !Array.isArray(body.routines) ||
    !Array.isArray(body.runs) ||
    body.routines.length > MAX_ROUTINES ||
    body.runs.length > MAX_ROUTINES
  ) throw new RoutineError('routine-response-invalid');
  return { routines: body.routines.map(parseRoutineView), runs: body.runs.map(parseRunView) };
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

export function resolveRoutineRun(fetcher, teamId, runId, batchFingerprint) {
  if (typeof batchFingerprint !== 'string' || !HEX64_RE.test(batchFingerprint)) {
    return Promise.reject(new RoutineError('routine-request-invalid'));
  }
  return decideRun(fetcher, teamId, runId, 'resolve', { batch_fingerprint: batchFingerprint }, 'resolved');
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
    'routine-proposal-unavailable': copy.gone,
    'team-context-changed': copy.changed,
    // The run's request no longer renders against the Team's reviewed Assistant; it stays frozen (ADR-0091).
    'human-request-invalid': copy.changed,
    'assistant-language-drift': copy.unavailable,
    'routine-limit': copy.full,
    'routine-rate-limit': copy.full,
    'routine-run-uncertain': copy.uncertain,
    'routine-run-not-found': copy.ended,
    'routine-run-not-uncertain': copy.ended,
    'routine-state-unavailable': copy.unavailable,
    'team-context-unavailable': copy.unavailable,
  };
  return byCode[code] ?? copy.generic;
}

export { fill as fillRoutineCopy };

const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_NOTICE_REPLY_CHARS = 16000;
const MAX_NOTICE_QUESTION_CHARS = 240;

function closedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= maximum && value.trim() === value;
}

const NOTICE_DETAILS = {
  done: [['reply'], (detail) => closedText(detail.reply, MAX_NOTICE_REPLY_CHARS)],
  'needs-input': [['question'], (detail) => closedText(detail.question, MAX_NOTICE_QUESTION_CHARS)],
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
  uncertain: [['actions'], (detail) => isActions(detail.actions)],
};

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
    (value.run_id === null) !== ['skipped', 'scope-changed'].includes(value.outcome) ||
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
  };
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
    !['done', 'failed', 'denied', 'uncertain', 'stopped', 'needs-input', 'frozen'].includes(body.status)
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
