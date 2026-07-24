import {
  ASSISTANT_ID_RE,
  CONTROL_RE,
  jsonObject,
  LocalApiError,
  TEAM_ID_RE,
} from './validate.js';

const ASSISTANT_HELP_LOCALES = new Set(['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar']);
const RUNTIME_STATUS_RE = /^[a-z]{2,24}$/;
const MAX_INSTALLED_ASSISTANTS = 128;
const MAX_ASSISTANT_HELP_BYTES = 32 * 1024;
const HELP_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export { LocalApiError };

export function safeApiError(body, fallback) {
  const candidate = body?.error ?? body?.detail;
  return typeof candidate === 'string' && candidate.length <= 300 ? candidate : fallback;
}

/** Project the controller-owned registry onto display-only Assistant identities. */
export async function listAssistantCatalog(fetcher) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid local Assistant request.');
  const response = await fetcher('/api/assistants', {
    cache: 'no-store', headers: { Accept: 'application/json' },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The local Assistant catalog is unavailable.'),
      response.status,
    );
  }
  if (!Array.isArray(body.assistants) || body.assistants.length > MAX_INSTALLED_ASSISTANTS) {
    throw new LocalApiError('The local Assistant catalog is invalid.', response.status);
  }
  const seen = new Set();
  return body.assistants.map((entry) => {
    const id = entry?.id;
    const name = entry?.title;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof id !== 'string' ||
      id.length > 80 ||
      !ASSISTANT_ID_RE.test(id) ||
      typeof name !== 'string' ||
      name !== name.trim() ||
      !name ||
      name.length > 80 ||
      CONTROL_RE.test(name) ||
      seen.has(id)
    ) {
      throw new LocalApiError('The local Assistant catalog is invalid.', response.status);
    }
    seen.add(id);
    return { id, name };
  });
}

/** Read the controller-owned runtime inventory; never turn an invalid response into an empty list. */
export async function listInstalledAssistants(fetcher, teamId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistants`,
    { cache: 'no-store', headers: { Accept: 'application/json' } },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The installed Assistant inventory is unavailable.'),
      response.status,
    );
  }
  if (!Array.isArray(body.assistants) || body.assistants.length > MAX_INSTALLED_ASSISTANTS) {
    throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
  }

  const seen = new Set();
  return body.assistants.map((entry) => {
    const assistant = entry?.assistant;
    const status = entry?.status;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      !RUNTIME_STATUS_RE.test(status) ||
      seen.has(assistant)
    ) {
      throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
    }
    seen.add(assistant);
    return { assistant, status };
  });
}

/** Load Help only for one installed Assistant; Markdown remains untrusted display input. */
export async function getAssistantHelp(fetcher, teamId, assistantId, locale = 'en') {
  if (
    typeof fetcher !== 'function' ||
    !TEAM_ID_RE.test(teamId) ||
    typeof assistantId !== 'string' ||
    assistantId.length > 80 ||
    !ASSISTANT_ID_RE.test(assistantId) ||
    !ASSISTANT_HELP_LOCALES.has(locale)
  ) {
    throw new LocalApiError('Invalid local Assistant Help request.');
  }

  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistants/${encodeURIComponent(assistantId)}/help?locale=${locale}`,
    { cache: 'no-store', headers: { Accept: 'application/json' } },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The installed Assistant Help is unavailable.'),
      response.status,
    );
  }
  const markdown = body.markdown;
  if (
    body.assistant !== assistantId ||
    typeof markdown !== 'string' ||
    !markdown.trim() ||
    HELP_CONTROL_RE.test(markdown) ||
    new TextEncoder().encode(markdown).length > MAX_ASSISTANT_HELP_BYTES
  ) {
    throw new LocalApiError('The installed Assistant Help is invalid.', response.status);
  }
  return { assistant: assistantId, markdown };
}

/** Install or reconcile one allowlisted Assistant without invoking a Power or starting a chat turn. */
export async function installAssistant(fetcher, teamId, assistantId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof assistantId !== 'string' || assistantId.length > 80 || !ASSISTANT_ID_RE.test(assistantId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const base = `/api/teams/${encodeURIComponent(teamId)}/assistants`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const installResponse = await fetcher(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ assistant: assistantId }),
  });
  const installBody = await jsonObject(installResponse);
  if (!installResponse.ok) {
    throw new LocalApiError(
      safeApiError(installBody, 'The local Assistant could not be installed.'),
      installResponse.status,
    );
  }
  if (installBody.assistant !== assistantId || typeof installBody.installed !== 'boolean') {
    throw new LocalApiError('The local Assistant installation returned an invalid response.', installResponse.status);
  }
  return { assistant: assistantId, installed: installBody.installed };
}
