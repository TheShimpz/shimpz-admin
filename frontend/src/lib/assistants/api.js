import { ASSISTANT_LIMIT_REACHED, exactEnvelope, exactKeys, jsonObject, LocalApiError, safeApiError } from '../api.js';
import { isAscending, isShownText, isUniqueList } from '../grammar.js';
import {
  DIGEST_RE,
  isAssistantId,
  isIdentifier,
  isPublicCreator,
  SEMANTIC_VERSION_RE,
  TEAM_ID_RE,
} from '../ids.js';
import { socketReads } from '../session/socket.js';
import { AssistantPageError, canonicalPageCopy, SUMMARY_CHARS } from './page.js';
import { isLocale } from '../i18n/locales.js';

const RUNTIME_STATUS_RE = /^[a-z]{2,24}$/;
const MAX_INSTALLED_ASSISTANTS = 128;
const MAX_LOCAL_ASSISTANTS = 50;
const LOCAL_ADMISSION_REASONS = Object.freeze(['declaration-invalid', 'image-inconsistent', 'labels-invalid']);
// The producer contract: Store and Developers admit up to 1,000 public Assistants.
const MAX_PUBLIC_ASSISTANTS = 1000;
// A catalog that changes while its pages are read is read again from its first page, at most this many more times.
const MAX_CATALOG_RESTARTS = 2;
const CATALOG_CURSOR_RE = /^[1-9][0-9]{0,3}\.[0-9a-f]{32}$/;
// The Assistant summary is a short description of at most 80 characters, in every interface language.
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CREATOR_RE = /^@[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const isDeclaredCreator = (value) => typeof value === 'string' && CREATOR_RE.test(value);

/**
 * Project the controller-owned registry onto display-only Assistant identities. Admin sends only each identity and
 * name: Team's registry summary is the canonical English text it plans with, never shown in the interface. `call` is
 * the synced value's own, which records the revision its answer reflects.
 */
export async function listAssistantCatalog(call = socketReads.call) {
  const response = await call('assistants.registry', {});
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
      !isAssistantId(id) ||
      !isShownText(name, 80) ||
      seen.has(id)
    ) {
      throw new LocalApiError('The local Assistant catalog is invalid.', response.status);
    }
    seen.add(id);
    return { id, name };
  });
}

/** One bounded page of the public catalog, or `changed` when it changed since the first page was read. */
async function catalogPage(locale, cursor, call) {
  const response = await call('store.catalog', cursor ? { locale, cursor } : { locale });
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
async function catalogPages(locale, call) {
  for (let attempt = 0; attempt <= MAX_CATALOG_RESTARTS; attempt += 1) {
    const assistants = [];
    let cursor = null;
    let status = 200;
    let changed = false;
    do {
      const page = await catalogPage(locale, cursor, call);
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
 * refused. `call` asks Admin for each page, as a synced value's read passes it.
 */
export async function listPublicAssistantCatalog(locale, call = socketReads.call) {
  if (!isLocale(locale)) throw new LocalApiError('Invalid Assistant catalog request.');
  const { assistants, status } = await catalogPages(locale, call);
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
      !isAssistantId(entry.assistant_id) ||
      typeof entry.assistant_version !== 'string' ||
      !SEMANTIC_VERSION_RE.test(entry.assistant_version) ||
      !isShownText(entry.name, 80) ||
      !isShownText(entry.summary, SUMMARY_CHARS) ||
      !isUniqueList(entry.creators, 1, 16, isPublicCreator) ||
      !DIGEST_RE.test(entry.source_digest) ||
      !DIGEST_RE.test(entry.icon_digest) ||
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
export async function listInstalledAssistants(teamId, call = socketReads.call) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }

  const response = await call('assistants.list', { team_id: teamId });
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
      !isAssistantId(assistant) ||
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
  if (!isAssistantId(assistantId)) {
    throw new LocalApiError('Invalid local Assistant request.');
  }
  if (typeof sourceDigest !== 'string' || !DIGEST_RE.test(sourceDigest)) {
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
    DIGEST_RE.test(entry.image_id) &&
    ['linux/amd64', 'linux/arm64'].includes(entry.platform) &&
    entry.provenance === 'local' &&
    entry.unpublished === true &&
    LOCAL_LABEL_FIELDS.every((key) => entry[key] === null)
  );
}

/**
 * List bounded unpublished snapshots with explicitly unverified display declarations and Team's verdict; `call` asks
 * Admin, as a synced value's read passes it.
 */
export async function listLocalAssistantSnapshots(call = socketReads.call) {
  const response = await call('snapshots.list', {});
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(
      safeApiError(body, 'Local Assistant snapshots are unavailable.'),
      response.status,
    );
  }
  if (
    !exactEnvelope(body, ['assistants']) ||
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
      !isShownText(entry.name, 80) ||
      !isShownText(entry.summary, SUMMARY_CHARS) ||
      !isUniqueList(entry.actions, 1, 128, isIdentifier) ||
      !isAscending(entry.actions) ||
      !isUniqueList(entry.integrations, 0, 16, isIdentifier) ||
      !isAscending(entry.integrations) ||
      !isUniqueList(entry.declared_creators, 1, 4, isDeclaredCreator) ||
      typeof entry.created_at !== 'string' ||
      !CREATED_AT_RE.test(entry.created_at) ||
      Number.isNaN(Date.parse(entry.created_at)) ||
      !DIGEST_RE.test(entry.image_id) ||
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
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId) || typeof imageId !== 'string' || !DIGEST_RE.test(imageId)) {
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
  if (
    !exactEnvelope(body, keys) ||
    !isAssistantId(body.assistant) ||
    body.image_id !== imageId ||
    typeof body.installed !== 'boolean' ||
    ('updated' in body && typeof body.updated !== 'boolean') ||
    body.provenance !== 'local' ||
    body.unpublished !== true
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
    !isAssistantId(assistantId)
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
  if (
    !exactEnvelope(body, ['assistant', 'uninstalled']) ||
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
