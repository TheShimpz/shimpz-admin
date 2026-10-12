import {
  ASSISTANT_ID_RE,
  ASSISTANT_LIMIT_REACHED,
  codePointLength,
  CONTROL_RE,
  exactKeys,
  isAssistantId,
  isIdentifier,
  jsonObject,
  LocalApiError,
  TEAM_ID_RE,
  TRACE_ID_RE,
} from './validate.js';
import { socketReads } from './adminSocket.js';
import { AssistantPageError, canonicalPageCopy } from './assistantPage.js';
import { isLocale } from './locales.js';

const RUNTIME_STATUS_RE = /^[a-z]{2,24}$/;
const SEMANTIC_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_INSTALLED_ASSISTANTS = 128;
const MAX_LOCAL_ASSISTANTS = 50;
const LOCAL_ADMISSION_REASONS = Object.freeze(['declaration-invalid', 'image-inconsistent', 'labels-invalid']);
// The producer contract: Store and Developers admit up to 1,000 public Assistants.
const MAX_PUBLIC_ASSISTANTS = 1000;
// A catalog that changes while its pages are read is read again from its first page, at most this many more times.
const MAX_CATALOG_RESTARTS = 2;
const CATALOG_CURSOR_RE = /^[1-9][0-9]{0,3}\.[0-9a-f]{32}$/;
// The Assistant summary is a short description of at most 80 characters, in every interface language.
const ASSISTANT_SUMMARY_CHARS = 80;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREATOR_RE = /^@[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const PUBLIC_CREATOR_RE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export { LocalApiError };

export function safeApiError(body, fallback) {
  const candidate = body?.error ?? body?.detail;
  return typeof candidate === 'string' && candidate.length <= 300 ? candidate : fallback;
}

/**
 * Project the controller-owned registry onto display-only Assistant identities. Admin sends only each identity and
 * name: Team's registry summary is the canonical English text it plans with, never shown in the interface.
 */
export async function listAssistantCatalog() {
  const response = await socketReads.call('assistants.registry', {});
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
      !exactKeys(entry, ['id', 'title']) ||
      typeof id !== 'string' ||
      id.length > 80 ||
      !ASSISTANT_ID_RE.test(id) ||
      typeof name !== 'string' ||
      name !== name.trim() ||
      !name ||
      codePointLength(name) > 80 ||
      CONTROL_RE.test(name) ||
      seen.has(id)
    ) {
      throw new LocalApiError('The local Assistant catalog is invalid.', response.status);
    }
    seen.add(id);
    return { id, name };
  });
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('The Assistant catalog request was aborted.', 'AbortError');
}

/** One bounded page of the public catalog, or `changed` when it changed since the first page was read. */
async function catalogPage(locale, cursor, signal) {
  aborted(signal);
  const response = await socketReads.call('store.catalog', cursor ? { locale, cursor } : { locale });
  aborted(signal);
  const body = await jsonObject(response);
  if (response.status === 409 && body.code === 'catalog-changed' && cursor) return { changed: true };
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'The Assistant catalog is unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['assistants', 'locale', 'next', 'version']) ||
    body.version !== 1 ||
    body.locale !== locale ||
    !Array.isArray(body.assistants) ||
    body.assistants.length > MAX_PUBLIC_ASSISTANTS ||
    (body.next !== null && (typeof body.next !== 'string' || !CATALOG_CURSOR_RE.test(body.next))) ||
    (body.next !== null && !body.assistants.length)
  ) {
    throw new LocalApiError('The Assistant catalog is invalid.', response.status);
  }
  return { assistants: body.assistants, next: body.next, status: response.status };
}

/** Every page of one catalog, joined; a catalog that changed between pages is read again from the start. */
async function catalogPages(locale, signal) {
  for (let attempt = 0; attempt <= MAX_CATALOG_RESTARTS; attempt += 1) {
    const assistants = [];
    let cursor = null;
    let status = 200;
    let changed = false;
    do {
      const page = await catalogPage(locale, cursor, signal);
      if (page.changed) {
        changed = true;
        break;
      }
      assistants.push(...page.assistants);
      if (assistants.length > MAX_PUBLIC_ASSISTANTS) {
        throw new LocalApiError('The Assistant catalog is invalid.', page.status);
      }
      ({ next: cursor, status } = page);
    } while (cursor);
    if (!changed) return { assistants, status };
  }
  throw new LocalApiError('The Assistant catalog kept changing while it was read.', 409);
}

/**
 * Read the exact bounded public Store projection used by the native Admin catalog and Assistant pages in one interface
 * language, joined from its bounded pages. Only the display copy (summary, description, Action descriptions, and
 * Stored Input labels) is localized, from the publication's own language pack; a catalog in any other language is
 * refused.
 */
export async function listPublicAssistantCatalog(locale, signal) {
  if (!isLocale(locale)) throw new LocalApiError('Invalid Assistant catalog request.');
  const { assistants, status } = await catalogPages(locale, signal);
  const seen = new Set();
  return assistants.map((entry) => {
    if (
      !exactKeys(entry, [
        'actions',
        'assistant_id',
        'assistant_version',
        'creators',
        'description',
        'icon_digest',
        'integrations',
        'links',
        'name',
        'source_digest',
        'stored_inputs',
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
      codePointLength(entry.name) > 80 ||
      CONTROL_RE.test(entry.name) ||
      typeof entry.summary !== 'string' ||
      entry.summary !== entry.summary.trim() ||
      !entry.summary ||
      codePointLength(entry.summary) > ASSISTANT_SUMMARY_CHARS ||
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
      throw new LocalApiError('The Assistant catalog is invalid.', status);
    }
    seen.add(entry.assistant_id);
    let page;
    try {
      page = canonicalPageCopy(entry);
    } catch (error) {
      if (error instanceof AssistantPageError) throw new LocalApiError('The Assistant catalog is invalid.', status);
      throw error;
    }
    return {
      assistant_id: entry.assistant_id,
      assistant_version: entry.assistant_version,
      creators: [...entry.creators],
      icon_digest: entry.icon_digest,
      name: entry.name,
      source_digest: entry.source_digest,
      summary: entry.summary,
      page,
    };
  });
}

/** Read the controller-owned runtime inventory; never turn an invalid response into an empty list. */
export async function listInstalledAssistants(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await socketReads.call('assistants.list', { team_id: teamId });
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

/** Team's closed Assistant-limit refusal of an install, or no code for any other failure. */
function installRefusalCode(response, body) {
  return response.status === 409 && body.code === ASSISTANT_LIMIT_REACHED ? ASSISTANT_LIMIT_REACHED : '';
}

/**
 * Install or reconcile one allowlisted Assistant without invoking an Action or starting a chat turn. The install stays
 * pending while Team works; `onProgress` hears once that it started. Its answer lost with the socket is an unknown
 * outcome (`outcome-unknown`), never replayed.
 */
export async function installAssistant(teamId, assistantId, sourceDigest, { onProgress } = {}) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof assistantId !== 'string' || assistantId.length > 80 || !ASSISTANT_ID_RE.test(assistantId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof sourceDigest !== 'string' || !SHA256_RE.test(sourceDigest)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const installResponse = await socketReads.call(
    'assistants.install',
    { team_id: teamId, body: { assistant_id: assistantId, source_digest: sourceDigest } },
    { onProgress },
  );
  const installBody = await jsonObject(installResponse);
  if (!installResponse.ok) {
    throw new LocalApiError(
      safeApiError(installBody, 'The local Assistant could not be installed.'),
      installResponse.status,
      installRefusalCode(installResponse, installBody),
    );
  }
  if (installBody.assistant !== assistantId || typeof installBody.installed !== 'boolean') {
    throw new LocalApiError('The local Assistant installation returned an invalid response.', installResponse.status);
  }
  return { assistant: assistantId, installed: installBody.installed };
}

/** Team's admission verdict for one staged snapshot: a closed reason exactly when it is inadmissible. */
function localAdmissionValid(admission, reason) {
  if (admission === 'inadmissible') return LOCAL_ADMISSION_REASONS.includes(reason);
  return ['admissible', 'unavailable'].includes(admission) && reason === null;
}

const LOCAL_LABEL_FIELDS = Object.freeze([
  'actions',
  'assistant_version',
  'created_at',
  'declared_creators',
  'integrations',
  'name',
  'summary',
]);

/** A staged identity whose stage labels Team refused: its id and image, and every label member null. */
function unlabeledSnapshotValid(entry) {
  return (
    exactKeys(entry, [
      ...LOCAL_LABEL_FIELDS,
      'admission',
      'assistant_id',
      'image_id',
      'platform',
      'provenance',
      'reason',
      'unpublished',
    ]) &&
    entry.admission === 'inadmissible' &&
    isAssistantId(entry.assistant_id) &&
    SHA256_RE.test(entry.image_id) &&
    ['linux/amd64', 'linux/arm64'].includes(entry.platform) &&
    entry.provenance === 'local' &&
    entry.unpublished === true &&
    LOCAL_LABEL_FIELDS.every((key) => entry[key] === null)
  );
}

/** List bounded unpublished snapshots with explicitly unverified display declarations and Team's verdict. */
export async function listLocalAssistantSnapshots(signal) {
  aborted(signal);
  const response = await socketReads.call('snapshots.list', {});
  aborted(signal);
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
  // A staged identity whose labels Team refused has nothing to show, yet it must still hide the publication of the
  // same Assistant; until the Assistants view can show it, the whole list stays unknown rather than dropping it.
  if (body.assistants.some((entry) => entry?.reason === 'labels-invalid' && unlabeledSnapshotValid(entry))) {
    throw new LocalApiError('The Local Assistant snapshot inventory is invalid.', response.status);
  }
  const seen = new Set();
  return body.assistants.map((entry) => {
    if (
      !exactKeys(entry, [
        'admission',
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
        'reason',
        'summary',
        'unpublished',
      ]) ||
      !localAdmissionValid(entry.admission, entry.reason) ||
      !isAssistantId(entry.assistant_id) ||
      typeof entry.assistant_version !== 'string' ||
      !SEMANTIC_VERSION_RE.test(entry.assistant_version) ||
      typeof entry.name !== 'string' ||
      entry.name !== entry.name.trim() ||
      !entry.name ||
      codePointLength(entry.name) > 80 ||
      CONTROL_RE.test(entry.name) ||
      typeof entry.summary !== 'string' ||
      entry.summary !== entry.summary.trim() ||
      !entry.summary ||
      codePointLength(entry.summary) > ASSISTANT_SUMMARY_CHARS ||
      CONTROL_RE.test(entry.summary) ||
      !Array.isArray(entry.actions) ||
      entry.actions.length < 1 ||
      entry.actions.length > 128 ||
      entry.actions.some((action) => !isIdentifier(action)) ||
      new Set(entry.actions).size !== entry.actions.length ||
      entry.actions.some((action, index) => index > 0 && entry.actions[index - 1] >= action) ||
      !Array.isArray(entry.integrations) ||
      entry.integrations.length > 16 ||
      entry.integrations.some((integration) => !isIdentifier(integration)) ||
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

/** Bind and run one exact unpublished snapshot in the selected Local Team; a long call, like `installAssistant`. */
export async function installLocalAssistant(teamId, imageId, { onProgress } = {}) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId) || typeof imageId !== 'string' || !SHA256_RE.test(imageId)) {
    throw new LocalApiError('Invalid Local Assistant snapshot request.');
  }
  const response = await socketReads.call(
    'assistants.install_local',
    { team_id: teamId, body: { image_id: imageId } },
    { onProgress },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'The Local Assistant snapshot could not be installed.'),
      response.status,
      installRefusalCode(response, body),
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
export async function uninstallAssistant(teamId, assistantId) {
  if (
    typeof teamId !== 'string' ||
    !TEAM_ID_RE.test(teamId) ||
    typeof assistantId !== 'string' ||
    assistantId.length > 80 ||
    !ASSISTANT_ID_RE.test(assistantId)
  ) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await socketReads.call('assistants.uninstall', { team_id: teamId, assistant_id: assistantId });
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
