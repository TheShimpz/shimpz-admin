import { parseFileReferences } from './attachments/files.js';
import { parseClarification, renderClarification } from './clarification.js';
import {
  CHAT_TEXT_CONTROL_RE,
  GUIDANCE_CODES,
  MAX_GUIDANCE_REPLY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_REPLY_CHARS,
  parseRoutineReply,
} from './protocol.js';
import { parseRoutineRunEntry } from '../routines/protocol.js';
import { parseTaskUsage } from './usage.js';
import { sessionFamily } from '../session/family.js';
import { synced } from '../session/synced.js';
import { ASSISTANT_LIMIT_REACHED, exactKeys, jsonObject, LocalApiError, safeApiError } from '../api.js';
import { isInstant, isShownText } from '../grammar.js';
import {
  isAssistantId,
  isIdentifier,
  MAX_TEAM_NAME_CHARS,
  OPAQUE_ID_RE,
  PUBLIC_CREATOR_RE,
  SEMANTIC_VERSION_RE,
  TEAM_ID_RE,
} from '../ids.js';

const PUBLIC_TEXT_CONTROL_RE = /[\p{C}\p{Zl}\p{Zp}]/u;
const ENTRY_ID_RE = /^([0-9a-f]{32}):(user|reply|install|uninstall|guidance|routine)$/;
const HISTORY_CURSOR_RE = /^(?!A{11}$)[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/;
const MAX_PAGE_ENTRIES = 64;
const MAX_ASSISTANTS = 4;
const MAX_PROVIDERS = 32;

function invalidHistory(status = 0) {
  return new LocalApiError('The Team chat history is invalid.', status);
}

function boundedText(value, maximum, controls, status) {
  if (!isShownText(value, maximum, controls)) throw invalidHistory(status);
  return value;
}

function publicText(value, maximum, status) {
  return boundedText(value, maximum, PUBLIC_TEXT_CONTROL_RE, status);
}

function assistantId(value, status) {
  if (!isAssistantId(value)) throw invalidHistory(status);
  return value;
}

function providerId(value, status) {
  if (!isIdentifier(value)) throw invalidHistory(status);
  return value;
}

function publicAssistant(value, status) {
  if (!exactKeys(value, ['creator', 'id', 'name', 'provenance', 'version'])) throw invalidHistory(status);
  if (
    typeof value.version !== 'string' ||
    !SEMANTIC_VERSION_RE.test(value.version) ||
    typeof value.creator !== 'string' ||
    !PUBLIC_CREATOR_RE.test(value.creator) ||
    !['local', 'published'].includes(value.provenance)
  ) {
    throw invalidHistory(status);
  }
  return {
    id: assistantId(value.id, status),
    name: publicText(value.name, 80, status),
    version: value.version,
    creator: value.creator,
    provenance: value.provenance,
  };
}

function installAssistant(value, status) {
  if (!exactKeys(value, ['creator', 'id', 'name', 'providers', 'provenance', 'status', 'summary', 'version'])) {
    throw invalidHistory(status);
  }
  if (
    typeof value.creator !== 'string' ||
    !PUBLIC_CREATOR_RE.test(value.creator) ||
    typeof value.version !== 'string' ||
    !SEMANTIC_VERSION_RE.test(value.version) ||
    !Array.isArray(value.providers) ||
    value.providers.length > MAX_PROVIDERS ||
    !['local', 'published'].includes(value.provenance) ||
    !['pending', 'installed', 'failed'].includes(value.status)
  ) throw invalidHistory(status);
  const providers = value.providers.map((provider) => providerId(provider, status));
  if (providers.some((provider, index) => index > 0 && providers[index - 1] >= provider)) {
    throw invalidHistory(status);
  }
  return {
    id: assistantId(value.id, status),
    name: publicText(value.name, 80, status),
    summary: publicText(value.summary, 80, status),
    creator: value.creator,
    version: value.version,
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
      ...routineKeys,
    ]
    : ['id', 'kind', 'role', 'text', ...(attached ? ['files'] : [])];
  let usage = null;
  let files = null;
  let routine = {};
  try {
    if (used) usage = parseTaskUsage(value.usage);
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
    ...(files ? { files } : {}),
    ...routine,
  };
}

function installEntry(value, suffix, status) {
  const failed = value.state === 'failed';
  const limited = failed && 'code' in value;
  const alreadyInstalled = value.outcome === 'already-installed';
  if (
    suffix !== 'install' ||
    !exactKeys(value, failed
      ? ['assistants', 'id', 'kind', 'state', 'status', ...(limited ? ['code'] : [])]
      : alreadyInstalled
        ? ['assistants', 'id', 'kind', 'outcome', 'state']
        : ['assistants', 'id', 'kind', 'state']) ||
    !['installed', 'failed', 'stopped'].includes(value.state) ||
    (alreadyInstalled && value.state !== 'installed') ||
    !Array.isArray(value.assistants) ||
    value.assistants.length < 1 ||
    value.assistants.length > MAX_ASSISTANTS ||
    (failed && (!Number.isInteger(value.status) || value.status < 400 || value.status > 599)) ||
    (limited && (value.status !== 409 || value.code !== ASSISTANT_LIMIT_REACHED))
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
    ...(limited ? { code: value.code } : {}),
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
  if (
    suffix !== 'guidance' ||
    !exactKeys(value, ['code', 'id', 'kind', 'reply']) ||
    !GUIDANCE_CODES.has(value.code)
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
export async function listChatHistory(read, teamId, before = null, { routine = null } = {}) {
  if (
    typeof read !== 'function' ||
    typeof teamId !== 'string' ||
    !TEAM_ID_RE.test(teamId) ||
    (before !== null && (typeof before !== 'string' || !HISTORY_CURSOR_RE.test(before))) ||
    (routine !== null && (typeof routine !== 'string' || !OPAQUE_ID_RE.test(routine)))
  ) throw new LocalApiError('Invalid Team chat history request.');
  const params = { team_id: teamId };
  if (before !== null) params.before = before;
  if (routine !== null) params.routine = routine;
  const response = await read('history.page', params);
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
 * MAX_REFRESH_PAGES of them; `reached` says whether a marked row was found. A refresh that reaches its page bound first
 * returns every row it read and the cursor it stopped at as `before`, so what lies between stays reachable; otherwise
 * `before` is null.
 */
export async function historySince(read, teamId, seen, { routine = null } = {}) {
  const pages = [];
  let cursor = null;
  for (let page = 0; page < MAX_REFRESH_PAGES; page += 1) {
    const { entries, before } = await listChatHistory(read, teamId, cursor, { routine });
    const known = entries.findLastIndex((entry) => seen.has(historyMark(entry)));
    pages.unshift(entries.slice(known + 1));
    if (known !== -1 || before === null) return { entries: pages.flat(), before: null, reached: known !== -1 };
    cursor = before;
  }
  return { entries: pages.flat(), before: cursor, reached: false };
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
function isRoutineRun(entry, routineId) {
  return entry.kind === 'routine-run' && entry.routineId === routineId &&
    (entry.runId !== null || entry.outcome === 'healthy' || entry.outcome === 'skipped');
}

/**
 * One page of a Routine's own history from `before` (null for the newest), newest first, with the cursor to its older
 * runs, or null once there are none. `seen`, when given, receives the marks of the newest page, oldest first: the
 * boundary a later refresh reads back to.
 */
export async function routineRuns(read, teamId, routineId, { before = null, seen = null } = {}) {
  const { entries, before: older } = await listChatHistory(read, teamId, before, { routine: routineId });
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

// A kept view of the chat holds at most this many rows, and this many UTF-8 bytes of them; a larger one is dropped, and
// the chat then opens from the newest page again.
export const MAX_VIEW_ROWS = 4 * MAX_PAGE_ENTRIES;
export const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

function rowBytes(entries) {
  return encoder.encode(JSON.stringify(entries)).byteLength;
}

// The chat's view as a reload would open it: `entries` (oldest first) and the cursor to the rows before them, or null
// once it outgrew its bounds.
function chatView(entries, before) {
  if (entries.length > MAX_VIEW_ROWS) return null;
  const bytes = rowBytes(entries);
  return bytes > MAX_VIEW_BYTES ? null : { entries, before, bytes };
}

// The view with the rows written since it was read: a row written again (a Routine's newer version) moves to the end.
function grownView(view, arrived) {
  if (!view) return null;
  if (!arrived.length) return view;
  const moved = new Set(arrived.map((entry) => entry.id));
  return chatView([...view.entries.filter((entry) => !moved.has(entry.id)), ...arrived], view.before);
}

/**
 * The newest rows of a Team's history as one synced value (`synced.js`) on the Team's history topic: the chat's view,
 * or with `routine` that Routine's own. Its first read is the newest page; each later read is the rows written since
 * the newest it read, back to them. A value is `{ restart: true, entries, before }` when it replaces what is shown
 * (the newest page and its cursor, or, in the chat's view, every row a refresh read when more was written than it
 * reads or when none of the rows it read before is there any more, and the cursor it stopped at), or
 * `{ restart: false, entries }` with the rows written since, oldest first. Each value is read after the one before
 * it, so a screen applies them in order. In the chat's view each value also carries `view`: the whole conversation as
 * a reload would open it (see `chatView`), or null once it outgrew its bounds. Every value carries `marks`, where the
 * next read reads back to, and `restarted`, how many restarts it answers; a value is built only from the one before
 * it, so a read whose era ended changes nothing.
 * `restart()` reads the newest page again, and `retain` keeps the value for the session (`synced.js`), with `size()`
 * the bytes it holds.
 */
export function historyHead(teamId, { routine = null, retain = null } = {}) {
  // Restarts asked for so far; a value carries how many of them it answers, so only a value shown answers one.
  let restartsAsked = 0;
  const chat = routine === null;
  const newest = async (call) => {
    const asked = restartsAsked;
    const page = await listChatHistory(call, teamId, null, { routine });
    return {
      restarted: asked,
      restart: true,
      entries: page.entries,
      before: page.before,
      marks: historyBoundary(new Set(), page.entries),
      view: chat ? chatView(page.entries, page.before) : null,
    };
  };
  const read = async (call, last) => {
    if (!last || last.restarted < restartsAsked) return newest(call);
    const since = await historySince(call, teamId, last.marks, { routine });
    // More was written than one refresh reads, or none of the rows read before is there any more (the history was
    // cleared): what the refresh read replaces what is shown.
    const replaced = since.before !== null || (!since.reached && last.marks.size > 0);
    if (replaced) {
      if (!chat) return newest(call);
      return {
        restarted: last.restarted,
        restart: true,
        entries: since.entries,
        before: since.before,
        marks: historyBoundary(new Set(), since.entries),
        view: chatView(since.entries, since.before),
      };
    }
    return {
      restarted: last.restarted,
      restart: false,
      entries: since.entries,
      marks: historyBoundary(last.marks, since.entries),
      view: chat ? grownView(last.view, since.entries) : null,
    };
  };
  // It measures what its value holds: its view, or the rows it holds without one.
  const measure = (value) => value.view?.bytes ?? rowBytes(value.entries);
  const head = synced(`team/${teamId}/history`, read, { retain, measure });
  return {
    subscribe: head.subscribe,
    refresh: head.refresh,
    current: head.current,
    restart() {
      restartsAsked += 1;
      return head.refresh();
    },
    reset: head.reset,
    size: head.size,
  };
}

// A session keeps the chat's view of the Teams shown last, so returning to one shows its conversation at once; it is
// read again only when Admin says the history changed meanwhile (ADR-0114, values a session keeps).
const MAX_KEPT_CHATS = 4;
const MAX_KEPT_CHAT_BYTES = 8 * 1024 * 1024;
// Only a value that can open the conversation is kept: one whose view outgrew its bounds holds the rows it read, up to
// MAX_REFRESH_PAGES pages of them, and is forgotten when the chat is left, so the next visit reads the newest page.
const chats = sessionFamily(
  (teamId) => historyHead(teamId, { retain: { maxAgeMs: Infinity, keeps: (value) => value.view !== null } }),
  { maxEntries: MAX_KEPT_CHATS, maxBytes: MAX_KEPT_CHAT_BYTES },
);

/** One Team's chat history head, kept for the session (see `historyHead`). */
export function chatHistory(teamId) {
  return chats.get(teamId);
}

/** Forget the kept chat of every Team but these: a Team no longer listed shows nothing from memory again. */
export function forgetChatHistoriesExcept(teamIds) {
  chats.forgetExcept(teamIds);
}

/** The session ended: forget every kept chat. */
export function clearChatHistories() {
  chats.clear();
}
