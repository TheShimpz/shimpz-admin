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
const MAX_LOCAL_ASSISTANTS = 50;
const MAX_PUBLIC_ASSISTANTS = 256;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREATOR_RE = /^@[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const PUBLIC_CREATOR_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

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

/** Read the exact bounded public Store projection used by the native Admin catalog. */
export async function listPublicAssistantCatalog(fetcher, signal) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Assistant catalog request.');
  const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
  if (signal) options.signal = signal;
  const response = await fetcher('/api/assistant-catalog', options);
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The Assistant catalog is unavailable.'),
      response.status,
    );
  }
  if (
    !exactKeys(body, ['assistants', 'version']) ||
    body.version !== 1 ||
    !Array.isArray(body.assistants) ||
    body.assistants.length > MAX_PUBLIC_ASSISTANTS
  ) {
    throw new LocalApiError('The Assistant catalog is invalid.', response.status);
  }
  const seen = new Set();
  return body.assistants.map((entry) => {
    if (
      !exactKeys(entry, [
        'assistant_id',
        'assistant_version',
        'creators',
        'icon_digest',
        'name',
        'source_digest',
        'summary',
      ]) ||
      typeof entry.assistant_id !== 'string' ||
      entry.assistant_id.length > 80 ||
      !ASSISTANT_ID_RE.test(entry.assistant_id) ||
      typeof entry.assistant_version !== 'string' ||
      !SEMANTIC_VERSION_RE.test(entry.assistant_version) ||
      typeof entry.name !== 'string' ||
      entry.name !== entry.name.trim() ||
      !entry.name ||
      entry.name.length > 80 ||
      CONTROL_RE.test(entry.name) ||
      typeof entry.summary !== 'string' ||
      entry.summary !== entry.summary.trim() ||
      !entry.summary ||
      entry.summary.length > 160 ||
      CONTROL_RE.test(entry.summary) ||
      !Array.isArray(entry.creators) ||
      entry.creators.length < 1 ||
      entry.creators.length > 16 ||
      entry.creators.some((creator) => typeof creator !== 'string' || !PUBLIC_CREATOR_RE.test(creator)) ||
      new Set(entry.creators).size !== entry.creators.length ||
      !SHA256_RE.test(entry.source_digest) ||
      !SHA256_RE.test(entry.icon_digest) ||
      seen.has(entry.assistant_id)
    ) {
      throw new LocalApiError('The Assistant catalog is invalid.', response.status);
    }
    seen.add(entry.assistant_id);
    return { ...entry, creators: [...entry.creators] };
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
      !exactKeys(entry, ['assistant', 'assistant_version', 'provenance', 'status']) ||
      typeof assistant !== 'string' ||
      assistant.length > 80 ||
      !ASSISTANT_ID_RE.test(assistant) ||
      typeof assistantVersion !== 'string' ||
      !SEMANTIC_VERSION_RE.test(assistantVersion) ||
      !RUNTIME_STATUS_RE.test(status) ||
      !['local', 'published'].includes(entry.provenance) ||
      seen.has(assistant)
    ) {
      throw new LocalApiError('The installed Assistant inventory is invalid.', response.status);
    }
    seen.add(assistant);
    return { assistant, assistant_version: assistantVersion, status, provenance: entry.provenance };
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
  if (typeof sourceDigest !== 'string' || !SHA256_RE.test(sourceDigest)) {
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

/** List bounded unpublished snapshots with explicitly unverified display declarations. */
export async function listLocalAssistantSnapshots(fetcher, signal) {
  if (typeof fetcher !== 'function') throw new LocalApiError('Invalid Local Assistant snapshot request.');
  const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
  if (signal) options.signal = signal;
  const response = await fetcher('/api/local-assistants', options);
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'Local Assistant snapshots are unavailable.'),
      response.status,
    );
  }
  const responseKeys = 'trace_id' in body ? ['assistants', 'trace_id'] : ['assistants'];
  if (
    !exactKeys(body, responseKeys) ||
    ('trace_id' in body && (typeof body.trace_id !== 'string' || !TRACE_ID_RE.test(body.trace_id))) ||
    !Array.isArray(body.assistants) ||
    body.assistants.length > MAX_LOCAL_ASSISTANTS
  ) {
    throw new LocalApiError('The Local Assistant snapshot inventory is invalid.', response.status);
  }
  const seen = new Set();
  return body.assistants.map((entry) => {
    if (
      !exactKeys(entry, [
        'assistant_id',
        'assistant_version',
        'actions',
        'created_at',
        'declared_creators',
        'image_id',
        'integrations',
        'name',
        'platform',
        'provenance',
        'summary',
        'unpublished',
      ]) ||
      typeof entry.assistant_id !== 'string' ||
      !ASSISTANT_ID_RE.test(entry.assistant_id) ||
      typeof entry.assistant_version !== 'string' ||
      !SEMANTIC_VERSION_RE.test(entry.assistant_version) ||
      typeof entry.name !== 'string' ||
      entry.name !== entry.name.trim() ||
      !entry.name ||
      entry.name.length > 80 ||
      CONTROL_RE.test(entry.name) ||
      typeof entry.summary !== 'string' ||
      entry.summary !== entry.summary.trim() ||
      !entry.summary ||
      entry.summary.length > 160 ||
      CONTROL_RE.test(entry.summary) ||
      !Array.isArray(entry.actions) ||
      entry.actions.length < 1 ||
      entry.actions.length > 128 ||
      entry.actions.some((action) => typeof action !== 'string' || action.length > 80 || !ASSISTANT_ID_RE.test(action)) ||
      new Set(entry.actions).size !== entry.actions.length ||
      entry.actions.some((action, index) => index > 0 && entry.actions[index - 1] >= action) ||
      !Array.isArray(entry.integrations) ||
      entry.integrations.length > 16 ||
      entry.integrations.some((integration) => (
        typeof integration !== 'string' || integration.length > 80 || !ASSISTANT_ID_RE.test(integration)
      )) ||
      new Set(entry.integrations).size !== entry.integrations.length ||
      entry.integrations.some((integration, index) => index > 0 && entry.integrations[index - 1] >= integration) ||
      !Array.isArray(entry.declared_creators) ||
      entry.declared_creators.length < 1 ||
      entry.declared_creators.length > 4 ||
      entry.declared_creators.some((creator) => typeof creator !== 'string' || !CREATOR_RE.test(creator)) ||
      new Set(entry.declared_creators).size !== entry.declared_creators.length ||
      typeof entry.created_at !== 'string' ||
      !CREATED_AT_RE.test(entry.created_at) ||
      Number.isNaN(Date.parse(entry.created_at)) ||
      !SHA256_RE.test(entry.image_id) ||
      !['linux/amd64', 'linux/arm64'].includes(entry.platform) ||
      entry.provenance !== 'local' ||
      entry.unpublished !== true ||
      seen.has(entry.image_id)
    ) {
      throw new LocalApiError('The Local Assistant snapshot inventory is invalid.', response.status);
    }
    seen.add(entry.image_id);
    return { ...entry };
  });
}

/** Bind and run one exact unpublished snapshot in the selected Local Team. */
export async function installLocalAssistant(fetcher, teamId, imageId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId) || !SHA256_RE.test(imageId)) {
    throw new LocalApiError('Invalid Local Assistant snapshot request.');
  }
  const response = await fetcher(
    `/api/teams/${encodeURIComponent(teamId)}/assistants/local`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_id: imageId }),
    },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The Local Assistant snapshot could not be installed.'),
      response.status,
    );
  }
  const keys = ['assistant', 'image_id', 'installed', 'provenance', 'unpublished'];
  if ('updated' in body) keys.push('updated');
  if ('trace_id' in body) keys.push('trace_id');
  if (
    !exactKeys(body, keys) ||
    typeof body.assistant !== 'string' ||
    !ASSISTANT_ID_RE.test(body.assistant) ||
    body.image_id !== imageId ||
    typeof body.installed !== 'boolean' ||
    ('updated' in body && typeof body.updated !== 'boolean') ||
    body.provenance !== 'local' ||
    body.unpublished !== true ||
    ('trace_id' in body && (typeof body.trace_id !== 'string' || !TRACE_ID_RE.test(body.trace_id)))
  ) {
    throw new LocalApiError('The Local Assistant installation returned an invalid response.', response.status);
  }
  return {
    assistant: body.assistant,
    image_id: imageId,
    installed: body.installed,
    updated: body.updated === true,
  };
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
  return {
    assistant: assistantId,
    uninstalled: body.uninstalled,
  };
}
