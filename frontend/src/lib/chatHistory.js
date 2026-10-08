import { parseFileReferences, parseRestrictedActions } from './attachments.js';
import { parseClarification, renderClarification } from './clarification.js';
import { parseRoutineReply } from './localChat.js';
import { parseRoutineRunEntry } from './routine.js';
import { parseTaskUsage } from './taskUsage.js';
import { LocalApiError, safeApiError } from './localApi.js';
import {
  ASSISTANT_ID_RE,
  codePointLength,
  exactKeys,
  isInstant,
  jsonObject,
  TEAM_ID_RE,
} from './validate.js';

const CHAT_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PUBLIC_TEXT_CONTROL_RE = /[\p{C}\p{Zl}\p{Zp}]/u;
const ENTRY_ID_RE = /^([0-9a-f]{32}):(user|reply|install|uninstall|guidance|routine)$/;
const HISTORY_CURSOR_RE = /^(?!A{11}$)[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/;
const SEMANTIC_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_PAGE_ENTRIES = 64;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_REPLY_CHARS = 60_000;
const MAX_GUIDANCE_REPLY_CHARS = 240;
const MAX_TEAM_NAME_CHARS = 80;
const MAX_ASSISTANTS = 4;
const MAX_PROVIDERS = 32;

function invalidHistory(status = 0) {
  return new LocalApiError('The Team chat history is invalid.', status);
}

function boundedText(value, maximum, controls, status) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    codePointLength(value) > maximum ||
    controls.test(value)
  ) throw invalidHistory(status);
  return value;
}

function publicText(value, maximum, status) {
  return boundedText(value, maximum, PUBLIC_TEXT_CONTROL_RE, status);
}

function assistantId(value, status) {
  if (typeof value !== 'string' || value.length > 80 || !ASSISTANT_ID_RE.test(value)) {
    throw invalidHistory(status);
  }
  return value;
}

function publicAssistant(value, status) {
  if (!exactKeys(value, ['id', 'name', 'version'])) throw invalidHistory(status);
  if (typeof value.version !== 'string' || !SEMANTIC_VERSION_RE.test(value.version)) {
    throw invalidHistory(status);
  }
  return {
    id: assistantId(value.id, status),
    name: publicText(value.name, 80, status),
    version: value.version,
  };
}

function installAssistant(value, status) {
  if (!exactKeys(value, ['id', 'name', 'providers', 'provenance', 'status', 'summary'])) {
    throw invalidHistory(status);
  }
  if (
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDERS ||
    !['local', 'published'].includes(value.provenance) ||
    !['pending', 'installed', 'failed'].includes(value.status)
  ) throw invalidHistory(status);
  const providers = value.providers.map((provider) => assistantId(provider, status));
  if (providers.some((provider, index) => index > 0 && providers[index - 1] >= provider)) {
    throw invalidHistory(status);
  }
  return {
    id: assistantId(value.id, status),
    name: publicText(value.name, 80, status),
    summary: publicText(value.summary, 160, status),
    providers,
    provenance: value.provenance,
    status: value.status,
  };
}

function messageEntry(value, suffix, status) {
  const assistant = value.role === 'assistant';
  const clarified = assistant && Object.hasOwn(value, 'clarification');
  // What the turn consumed is kept with its reply only; it is the same closed shape as the done frame's.
  const used = assistant && Object.hasOwn(value, 'usage');
  // The Actions withheld for the turn's attachments are kept with its reply only, in the done frame's closed shape.
  const withheld = assistant && Object.hasOwn(value, 'restricted_actions');
  // A recording turn's Routine card, question, or refusal is kept with its reply, so a reload shows it again (ADR-0101).
  const routineKeys = assistant
    ? ['routine_proposal', 'routine_refusal', 'routine_question'].filter((key) => Object.hasOwn(value, key))
    : [];
  // A user message keeps references to the files it carried, never their content.
  const attached = !assistant && Object.hasOwn(value, 'files');
  const expected = assistant
    ? [
      'author',
      'id',
      'kind',
      'role',
      'text',
      ...(clarified ? ['clarification'] : []),
      ...(used ? ['usage'] : []),
      ...(withheld ? ['restricted_actions'] : []),
      ...routineKeys,
    ]
    : ['id', 'kind', 'role', 'text', ...(attached ? ['files'] : [])];
  let usage = null;
  let restricted = null;
  let files = null;
  let routine = {};
  try {
    if (used) usage = parseTaskUsage(value.usage);
    if (withheld) restricted = parseRestrictedActions(value.restricted_actions);
    if (attached) files = parseFileReferences(value.files);
    if (routineKeys.length) routine = parseRoutineReply(value, value.clarification ?? null);
  } catch {
    throw invalidHistory(status);
  }
  let clarification = null;
  if (clarified) {
    try {
      clarification = parseClarification(value.clarification);
    } catch {
      throw invalidHistory(status);
    }
    if (clarification === null || value.text !== renderClarification(clarification)) throw invalidHistory(status);
  }
  if (
    !exactKeys(value, expected) ||
    !['user', 'assistant'].includes(value.role) ||
    suffix !== (assistant ? 'reply' : 'user')
  ) throw invalidHistory(status);
  return {
    id: value.id,
    kind: 'message',
    role: value.role,
    text: boundedText(
      value.text,
      assistant ? MAX_REPLY_CHARS : MAX_MESSAGE_CHARS,
      CHAT_TEXT_CONTROL_RE,
      status,
    ),
    ...(assistant ? { author: publicText(value.author, MAX_TEAM_NAME_CHARS, status) } : {}),
    ...(clarification ? { clarification } : {}),
    ...(usage ? { usage } : {}),
    ...(restricted ? { restricted_actions: restricted } : {}),
    ...(files ? { files } : {}),
    ...routine,
  };
}

function installEntry(value, suffix, status) {
  const failed = value.state === 'failed';
  const alreadyInstalled = value.outcome === 'already-installed';
  if (
    suffix !== 'install' ||
    !exactKeys(value, failed
      ? ['assistants', 'id', 'kind', 'state', 'status']
      : alreadyInstalled
        ? ['assistants', 'id', 'kind', 'outcome', 'state']
        : ['assistants', 'id', 'kind', 'state']) ||
    !['installed', 'failed', 'stopped'].includes(value.state) ||
    (alreadyInstalled && value.state !== 'installed') ||
    !Array.isArray(value.assistants) ||
    value.assistants.length < 1 ||
    value.assistants.length > MAX_ASSISTANTS ||
    (failed && (!Number.isInteger(value.status) || value.status < 400 || value.status > 599))
  ) throw invalidHistory(status);
  const assistants = value.assistants.map((assistant) => installAssistant(assistant, status));
  if (
    assistants.some((assistant, index) => index > 0 && assistants[index - 1].id >= assistant.id) ||
    (value.state === 'installed' && assistants.some((assistant) => assistant.status !== 'installed'))
  ) throw invalidHistory(status);
  return {
    id: value.id,
    kind: 'assistant-install',
    state: value.state,
    assistants,
    ...(alreadyInstalled ? { outcome: value.outcome } : {}),
    ...(failed ? { status: value.status } : {}),
  };
}

function uninstallEntry(value, suffix, status) {
  const expected = ['assistant', 'id', 'kind', 'state'];
  if (value.state === 'uninstalled') expected.push('uninstalled');
  else if (value.state === 'failed') expected.push('status');
  if (
    suffix !== 'uninstall' ||
    !exactKeys(value, expected) ||
    !['uninstalled', 'failed', 'cancelled', 'expired'].includes(value.state) ||
    (value.state === 'uninstalled' && typeof value.uninstalled !== 'boolean') ||
    (value.state === 'failed' && (
      !Number.isInteger(value.status) || value.status < 400 || value.status > 599
    ))
  ) throw invalidHistory(status);
  return {
    id: value.id,
    kind: 'assistant-uninstall',
    state: value.state,
    assistant: publicAssistant(value.assistant, status),
    ...(value.state === 'uninstalled' ? { uninstalled: value.uninstalled } : {}),
    ...(value.state === 'failed' ? { status: value.status } : {}),
  };
}

function guidanceEntry(value, suffix, status) {
  const codes = new Set([
    'assistant-install-target-required',
    'assistant-uninstall-target-required',
    'assistant-lifecycle-ambiguous',
    'assistant-lifecycle-attachments',
    'assistant-capability-attachments',
  ]);
  if (
    suffix !== 'guidance' ||
    !exactKeys(value, ['code', 'id', 'kind', 'reply']) ||
    !codes.has(value.code)
  ) throw invalidHistory(status);
  return {
    id: value.id,
    kind: 'guidance',
    code: value.code,
    reply: publicText(value.reply, MAX_GUIDANCE_REPLY_CHARS, status),
  };
}

const ENTRY_PARSERS = {
  message: messageEntry,
  'assistant-install': installEntry,
  'assistant-uninstall': uninstallEntry,
  guidance: guidanceEntry,
};

function historyEntry(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidHistory(status);
  const match = typeof value.id === 'string' ? ENTRY_ID_RE.exec(value.id) : null;
  if (!match) throw invalidHistory(status);
  const parse = Object.hasOwn(ENTRY_PARSERS, value.kind) ? ENTRY_PARSERS[value.kind] : null;
  if (parse) {
    // Every row carries the UTC time Admin wrote it; a Routine notice's is its own instant, checked in its shape.
    const { created_at: createdAt, ...rest } = value;
    if (!isInstant(createdAt)) throw invalidHistory(status);
    return { ...parse(rest, match[2], status), createdAt };
  }
  if (value.kind === 'routine-run' && match[2] === 'routine') {
    try {
      return parseRoutineRunEntry(value);
    } catch {
      throw invalidHistory(status);
    }
  }
  throw invalidHistory(status);
}

function historyCursor(value, status) {
  if (value === null) return null;
  if (typeof value !== 'string' || !HISTORY_CURSOR_RE.test(value)) throw invalidHistory(status);
  return value;
}

const ROUTINE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Whether an entry belongs to the view it was read in: the chat's view holds, of a Team's Routine notices, only each
 * Routine's creation; a Routine's own view holds only that Routine's history.
 */
function inView(entry, routine) {
  return routine === null
    ? entry.kind !== 'routine-run' || entry.outcome === 'created'
    : isRoutineRun(entry, routine);
}

/**
 * One newest-first page of a Team's history: the chat's view of it, or with `routine` that Routine's own history (its
 * runs, healthy rollups, and missed runs), which only its panel reads.
 */
export async function listChatHistory(fetcher, teamId, before = null, { routine = null } = {}) {
  if (
    typeof fetcher !== 'function' ||
    typeof teamId !== 'string' ||
    !TEAM_ID_RE.test(teamId) ||
    (before !== null && (typeof before !== 'string' || !HISTORY_CURSOR_RE.test(before))) ||
    (routine !== null && (typeof routine !== 'string' || !ROUTINE_ID_RE.test(routine)))
  ) throw new LocalApiError('Invalid Team chat history request.');
  const query = new URLSearchParams();
  if (before !== null) query.set('before', before);
  if (routine !== null) query.set('routine', routine);
  const search = String(query);
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/chat/history${search && `?${search}`}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The Team chat history is unavailable.'),
      response.status,
    );
  }
  if (
    !exactKeys(body, ['before', 'entries']) ||
    !Array.isArray(body.entries) ||
    body.entries.length > MAX_PAGE_ENTRIES
  ) throw invalidHistory(response.status);
  const entries = body.entries.map((entry) => historyEntry(entry, response.status));
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    !entries.every((entry) => inView(entry, routine))
  ) {
    throw invalidHistory(response.status);
  }
  return { entries, before: historyCursor(body.before, response.status) };
}

// A refresh reads at most this many history pages, newest first, to reach the history it already read.
export const MAX_REFRESH_PAGES = 8;

/** One history row as written: a Routine row is written again, at the end, with each newer version. */
export function historyMark(entry) {
  return entry.kind === 'routine-run' ? `${entry.id}@${entry.version}` : entry.id;
}

/**
 * The history written after the newest row `seen` marks, oldest first, in the chat's view or with `routine` in that
 * Routine's own. Pages are read newest first until one holds a marked row or the history ends, at most
 * MAX_REFRESH_PAGES of them. A refresh that reaches its page bound first returns every row it read and the cursor it
 * stopped at as `before`, so what lies between stays reachable; otherwise `before` is null.
 */
export async function historySince(fetcher, teamId, seen, { routine = null } = {}) {
  const pages = [];
  let cursor = null;
  for (let read = 0; read < MAX_REFRESH_PAGES; read += 1) {
    const { entries, before } = await listChatHistory(fetcher, teamId, cursor, { routine });
    const known = entries.findLastIndex((entry) => seen.has(historyMark(entry)));
    pages.unshift(entries.slice(known + 1));
    if (known !== -1 || before === null) return { entries: pages.flat(), before: null };
    cursor = before;
  }
  return { entries: pages.flat(), before: cursor };
}

// A refresh finds where the history it already read ends from the newest rows it read, so a reader keeps the marks of
// at most one full page of them: enough to find that boundary after some of them are written again as newer versions.
export const HISTORY_BOUNDARY_ROWS = MAX_PAGE_ENTRIES;

/**
 * The marks a later refresh reads back to: `marks` (oldest first, as a Set keeps them) followed by those of `entries`,
 * the rows read since (oldest first), kept to the newest HISTORY_BOUNDARY_ROWS.
 */
export function historyBoundary(marks, entries) {
  return new Set([...marks, ...entries.map(historyMark)].slice(-HISTORY_BOUNDARY_ROWS));
}

// A Routine's panel that stays open adds at most this many runs that end while it is open to the list it read; past
// that it reads its newest page again, so a Routine that keeps running cannot grow a panel without bound. A continuous
// Routine's healthy runs arrive as one rollup per minute with no run of its own, and count as one entry, as do the
// runs a Routine missed.
export const MAX_ARRIVED_RUNS = MAX_PAGE_ENTRIES;

/**
 * Whether a history entry is one of this Routine's runs, a rollup of its healthy continuous runs, or the runs it
 * missed: the Routine's own history, which only its panel shows (the chat shows only its creation).
 */
export function isRoutineRun(entry, routineId) {
  return entry.kind === 'routine-run' && entry.routineId === routineId &&
    (entry.runId !== null || entry.outcome === 'healthy' || entry.outcome === 'skipped');
}

/**
 * One page of a Routine's own history from `before` (null for the newest), newest first, with the cursor to its older
 * runs, or null once there are none. `seen`, when given, receives the marks of the newest page, oldest first: the
 * boundary a later refresh reads back to.
 */
export async function routineRuns(fetcher, teamId, routineId, { before = null, seen = null } = {}) {
  const { entries, before: older } = await listChatHistory(fetcher, teamId, before, { routine: routineId });
  for (const entry of entries) seen?.add(historyMark(entry));
  return { runs: [...entries].reverse(), before: older };
}

/**
 * A Routine's listed runs, newest first, with the rows written since (`arrived`, oldest first) merged in: each new run,
 * or newer version of a listed one, moves to the top, where the newest history shows it. No listed run is dropped, so
 * the cursor to older runs still reaches every run the list does not hold.
 */
export function mergedRoutineRuns(runs, arrived, routineId) {
  const listed = new Map(runs.map((entry) => [entry.id, entry.version]));
  const fresh = arrived
    .filter((entry) => isRoutineRun(entry, routineId) && !(listed.get(entry.id) >= entry.version))
    .reverse();
  if (fresh.length === 0) return runs;
  const moved = new Set(fresh.map((entry) => entry.id));
  return [...fresh, ...runs.filter((entry) => !moved.has(entry.id))];
}
