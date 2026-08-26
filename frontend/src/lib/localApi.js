import {
  ASSISTANT_ID_RE,
  CONTROL_RE,
  exactKeys,
  jsonObject,
  LocalApiError,
  TEAM_ID_RE,
  TRACE_ID_RE,
} from './validate.js';

const RUNTIME_STATUS_RE = /^[a-z]{2,24}$/;
const SEMANTIC_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_INSTALLED_ASSISTANTS = 128;

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
    const summary = entry?.summary;
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
      typeof summary !== 'string' ||
      summary !== summary.trim() ||
      !summary ||
      summary.length > 160 ||
      CONTROL_RE.test(summary) ||
      seen.has(id)
    ) {
      throw new LocalApiError('The local Assistant catalog is invalid.', response.status);
    }
    seen.add(id);
    return { id, name, summary };
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
    const assistantVersion = entry?.assistant_version;
    const status = entry?.status;
    if (
      !exactKeys(entry, ['assistant', 'assistant_version', 'status']) ||
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      typeof assistantVersion !== 'string' ||
      !SEMANTIC_VERSION_RE.test(assistantVersion) ||
      !RUNTIME_STATUS_RE.test(status) ||
      seen.has(assistant)
    ) {
      throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
    }
    seen.add(assistant);
    return { assistant, assistant_version: assistantVersion, status };
  });
}

/** Install or reconcile one allowlisted Assistant without invoking an Action or starting a chat turn. */
export async function installAssistant(fetcher, teamId, assistantId, sourceDigest) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof assistantId !== 'string' || assistantId.length > 80 || !ASSISTANT_ID_RE.test(assistantId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(sourceDigest)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const base = `/api/teams/${encodeURIComponent(teamId)}/assistants`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const installResponse = await fetcher(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ assistant_id: assistantId, source_digest: sourceDigest }),
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

/** Remove one Team-owned Assistant and validate the exact controller acknowledgement. */
export async function uninstallAssistant(fetcher, teamId, assistantId) {
  if (
    typeof fetcher !== 'function' ||
    typeof teamId !== 'string' ||
    !TEAM_ID_RE.test(teamId) ||
    typeof assistantId !== 'string' ||
    assistantId.length > 80 ||
    !ASSISTANT_ID_RE.test(assistantId)
  ) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistants/${encodeURIComponent(assistantId)}`,
    { method: 'DELETE', headers: { Accept: 'application/json' } },
  );
  const body = await jsonObject(response);
  if (response.status !== 200) {
    throw new LocalApiError(
      safeApiError(body, 'The local Assistant could not be uninstalled.'),
      response.status,
    );
  }
  const expectedKeys = 'trace_id' in body
    ? ['assistant', 'trace_id', 'uninstalled']
    : ['assistant', 'uninstalled'];
  if (
    !exactKeys(body, expectedKeys) ||
    ('trace_id' in body && (typeof body.trace_id !== 'string' || !TRACE_ID_RE.test(body.trace_id))) ||
    body.assistant !== assistantId ||
    typeof body.uninstalled !== 'boolean'
  ) {
    throw new LocalApiError(
      'The local Assistant uninstall returned an invalid response.',
      response.status,
    );
  }
  return { assistant: assistantId, uninstalled: body.uninstalled };
}
