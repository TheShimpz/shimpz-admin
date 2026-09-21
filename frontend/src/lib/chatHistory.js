import { LocalApiError, safeApiError } from './localApi.js';
import {
  ASSISTANT_ID_RE,
  exactKeys,
  jsonObject,
  TEAM_ID_RE,
} from './validate.js';

const CHAT_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PUBLIC_TEXT_CONTROL_RE = /[\p{C}\p{Zl}\p{Zp}]/u;
const ENTRY_ID_RE = /^([0-9a-f]{32}):(user|reply|install|uninstall|guidance)$/;
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
    value.length > maximum ||
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
  if (!exactKeys(value, ['id', 'name', 'summary', 'version'])) throw invalidHistory(status);
  if (typeof value.version !== 'string' || !SEMANTIC_VERSION_RE.test(value.version)) {
    throw invalidHistory(status);
  }
  return {
    id: assistantId(value.id, status),
    name: publicText(value.name, 80, status),
    summary: publicText(value.summary, 160, status),
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
  const expected = assistant
    ? ['author', 'id', 'kind', 'role', 'text']
    : ['id', 'kind', 'role', 'text'];
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

function historyEntry(value, status) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidHistory(status);
  const match = typeof value.id === 'string' ? ENTRY_ID_RE.exec(value.id) : null;
  if (!match) throw invalidHistory(status);
  if (value.kind === 'message') return messageEntry(value, match[2], status);
  if (value.kind === 'assistant-install') return installEntry(value, match[2], status);
  if (value.kind === 'assistant-uninstall') return uninstallEntry(value, match[2], status);
  if (value.kind === 'guidance') return guidanceEntry(value, match[2], status);
  throw invalidHistory(status);
}

function historyCursor(value, status) {
  if (value === null) return null;
  if (typeof value !== 'string' || !HISTORY_CURSOR_RE.test(value)) throw invalidHistory(status);
  return value;
}

export async function listChatHistory(fetcher, teamId, before = null) {
  if (
    typeof fetcher !== 'function' ||
    typeof teamId !== 'string' ||
    !TEAM_ID_RE.test(teamId) ||
    (before !== null && (typeof before !== 'string' || !HISTORY_CURSOR_RE.test(before)))
  ) throw new LocalApiError('Invalid Team chat history request.');
  const query = before === null ? '' : `?before=${encodeURIComponent(before)}`;
  const response = await fetcher(`/api/teams/${encodeURIComponent(teamId)}/chat/history${query}`, {
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
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw invalidHistory(response.status);
  }
  return { entries, before: historyCursor(body.before, response.status) };
}
