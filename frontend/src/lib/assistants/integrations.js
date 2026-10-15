// The Integrations and Stored Inputs an Assistant declares, as a Team's chat shows and manages them (ADR-0090, ADR-0114):
// their inventory, clearing a Stored Input, and the OAuth authorization that connects an Integration, whose start
// address must be one Admin or shimpz.com trusts for exactly the reviewed Cloudflare scopes.

import { socketReads } from '../session/socket.js';
import { exactKeys, jsonObject, LocalApiError, safeApiError } from '../api.js';
import { canonicalId, canonicalIntegrationScopes, canonicalPublicText, requireTeam } from '../chat/protocol.js';
import { CONTROL_RE, isAscending } from '../grammar.js';
import { ASSISTANT_ID_RE, isIdentifier, OPAQUE_ID_RE, SEMANTIC_VERSION_RE } from '../ids.js';
import { synced } from '../session/synced.js';

const MAX_INTEGRATIONS = 512;
const MAX_STORED_INPUTS = 128;

const CLOUDFLARE_SCOPES = new Set(['dns.read', 'dns.write', 'offline_access', 'zone.read']);
const OAUTH_SCOPE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function assistantIntegrationProviderLabel(provider) {
  if (typeof provider !== 'string' || !ASSISTANT_ID_RE.test(provider)) return '';
  if (provider === 'x') return 'X';
  if (provider === 'whatsapp') return 'WhatsApp';
  return provider.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function canonicalSemanticVersion(value) {
  if (typeof value !== 'string' || !SEMANTIC_VERSION_RE.test(value)) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return value;
}

function canonicalOptionalPublicText(value, maximum) {
  return value === null ? null : canonicalPublicText(value, maximum);
}

function trustedCloudflareScopes(value) {
  if (typeof value !== 'string') return false;
  const scopes = value.split(' ');
  return (
    scopes.length >= 1 &&
    scopes.length <= CLOUDFLARE_SCOPES.size &&
    scopes.every((scope) => OAUTH_SCOPE_RE.test(scope) && CLOUDFLARE_SCOPES.has(scope)) &&
    isAscending(scopes)
  );
}

function canonicalIntegrationIntegration(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['id', 'name', 'username'])
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return {
    id: canonicalPublicText(value.id, 160),
    name: canonicalOptionalPublicText(value.name, 160),
    username: canonicalOptionalPublicText(value.username, 160),
  };
}

function canonicalIntegrationExpiry(value) {
  if (value === null) return null;
  const match = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/)
    : null;
  if (
    !match ||
    value.length > 40 ||
    value !== value.trim() ||
    CONTROL_RE.test(value)
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const [, year, month, day, hour, minute, second, , offsetHour = '00', offsetMinute = '00'] = match;
  const maximumDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > maximumDay ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour) > 23 ||
    Number(offsetMinute) > 59
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  return value;
}

function canonicalIntegrationInventoryItem(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'assistant_id',
      'assistant_name',
      'assistant_version',
      'id',
      'provider',
      'name',
      'scopes',
      'status',
      'integration',
      'expires_at',
    ]) ||
    !['missing', 'connected', 'expired', 'reauthorization-required'].includes(value.status)
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.');
  }
  const integration = canonicalIntegrationIntegration(value.integration);
  return {
    assistant_id: canonicalId(value.assistant_id, 'The Assistant integration inventory is invalid.'),
    assistant_name: canonicalPublicText(value.assistant_name, 80),
    assistant_version: canonicalSemanticVersion(value.assistant_version),
    id: canonicalId(value.id, 'The Assistant integration inventory is invalid.', isIdentifier),
    provider: canonicalId(value.provider, 'The Assistant integration inventory is invalid.', isIdentifier),
    name: canonicalPublicText(value.name, 80),
    scopes: canonicalIntegrationScopes(value.scopes),
    status: value.status,
    integration,
    expires_at: canonicalIntegrationExpiry(value.expires_at),
  };
}

function trustedAuthorizationUrl(value, completionMode) {
  if (typeof value !== 'string' || value.length > 4096 || CONTROL_RE.test(value)) {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  const browserOrigin = globalThis.location?.origin;
  const localHandoff = (
    typeof browserOrigin === 'string' &&
    url.origin === browserOrigin &&
    url.pathname === '/api/oauth/cloudflare/start' &&
    [...url.searchParams.keys()].length === 1 &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get('handoff') ?? '')
  );
  const outOfBand = (
    url.protocol === 'https:' &&
    url.hostname === 'shimpz.com' &&
    !url.port &&
    url.pathname === '/api/oauth/cloudflare/start' &&
    [...url.searchParams.keys()].length === 4 &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') &&
    trustedCloudflareScopes(url.searchParams.get('scope')) &&
    url.searchParams.get('callback') === 'out-of-band'
  );
  const trusted = (
    (completionMode === 'automatic' && localHandoff) ||
    (completionMode === 'code' && outOfBand)
  );
  if (url.username || url.password || url.hash || !trusted) {
    throw new LocalApiError('The Assistant authorization response is invalid.');
  }
  return url.href;
}

export function oauthReturnFailure(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const pairs = [...url.searchParams.entries()];
  return (
    url.pathname === '/chat' &&
    !url.hash &&
    pairs.length === 1 &&
    pairs[0][0] === 'oauth' &&
    ['start-failed', 'callback-failed'].includes(pairs[0][1])
  );
}

export async function listAssistantIntegrations(teamId, call = socketReads.call) {
  requireTeam(teamId);
  const response = await call('integrations.list', { team_id: teamId });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant integrations are unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['integrations']) ||
    !Array.isArray(body.integrations) ||
    body.integrations.length > MAX_INTEGRATIONS
  ) {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  let integrations;
  try {
    integrations = body.integrations.map(canonicalIntegrationInventoryItem);
  } catch {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  const identities = integrations.map((integration) => `${integration.assistant_id}\u0000${integration.id}`);
  if (new Set(identities).size !== identities.length) {
    throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
  }
  const assistantMetadata = new Map();
  for (const integration of integrations) {
    const current = assistantMetadata.get(integration.assistant_id);
    const metadata = [integration.assistant_name, integration.assistant_version];
    if (current && current.some((value, index) => value !== metadata[index])) {
      throw new LocalApiError('The Assistant integration inventory is invalid.', response.status);
    }
    assistantMetadata.set(integration.assistant_id, metadata);
  }
  return { integrations };
}

function canonicalStoredInputMetadata(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['assistant_id', 'stored_input_id', 'status']) ||
    !['missing', 'stored'].includes(value.status)
  ) throw new LocalApiError('The Assistant Stored Input inventory is invalid.');
  try {
    return {
      assistant_id: canonicalId(value.assistant_id),
      stored_input_id: canonicalId(value.stored_input_id, undefined, isIdentifier),
      status: value.status,
    };
  } catch {
    throw new LocalApiError('The Assistant Stored Input inventory is invalid.');
  }
}

export async function listAssistantStoredInputs(teamId, call = socketReads.call) {
  requireTeam(teamId);
  const response = await call('stored_inputs.list', { team_id: teamId });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant Stored Inputs are unavailable.'), response.status);
  }
  if (
    !exactKeys(body, ['stored_inputs']) ||
    !Array.isArray(body.stored_inputs) ||
    body.stored_inputs.length > MAX_STORED_INPUTS
  ) throw new LocalApiError('The Assistant Stored Input inventory is invalid.', response.status);
  const storedInputs = body.stored_inputs.map(canonicalStoredInputMetadata);
  const identities = storedInputs.map((item) => `${item.assistant_id}\u0000${item.stored_input_id}`);
  if (!isAscending(identities)) {
    throw new LocalApiError('The Assistant Stored Input inventory is invalid.', response.status);
  }
  return { stored_inputs: storedInputs };
}

export async function clearAssistantStoredInput(teamId, assistantId, storedInputId) {
  requireTeam(teamId);
  let assistant;
  let storedInput;
  try {
    assistant = canonicalId(assistantId, 'Invalid Assistant Stored Input request.');
    storedInput = canonicalId(storedInputId, 'Invalid Assistant Stored Input request.', isIdentifier);
  } catch {
    throw new LocalApiError('Invalid Assistant Stored Input request.');
  }
  const response = await socketReads.call(
    'stored_inputs.clear',
    { team_id: teamId, assistant_id: assistant, stored_input_id: storedInput },
  );
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant Stored Input could not be cleared.'), response.status);
  }
  if (!exactKeys(body, ['cleared']) || typeof body.cleared !== 'boolean') {
    throw new LocalApiError('The Assistant Stored Input clear response is invalid.', response.status);
  }
  return body.cleared;
}

export async function authorizeAssistantIntegration(teamId, challengeId, assistantId, integrationId) {
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  let assistant;
  let integration;
  try {
    assistant = canonicalId(assistantId, 'Invalid Assistant authorization request.');
    integration = canonicalId(integrationId, 'Invalid Assistant authorization request.', isIdentifier);
  } catch {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  const response = await socketReads.call('integrations.authorize', {
    team_id: teamId,
    challenge_id: challengeId,
    body: { assistant_id: assistant, integration_id: integration },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not start.'), response.status);
  }
  if (
    !exactKeys(body, ['authorization_url', 'completion_mode']) ||
    !['automatic', 'code'].includes(body.completion_mode)
  ) {
    throw new LocalApiError('The Assistant authorization response is invalid.', response.status);
  }
  return {
    authorization_url: trustedAuthorizationUrl(body.authorization_url, body.completion_mode),
    completion_mode: body.completion_mode,
  };
}

export async function completeAssistantIntegration(teamId, challengeId, completionCode) {
  requireTeam(teamId);
  if (
    typeof challengeId !== 'string' ||
    !OPAQUE_ID_RE.test(challengeId) ||
    typeof completionCode !== 'string' ||
    !/^c1\.[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/.test(completionCode)
  ) {
    throw new LocalApiError('Invalid Assistant completion code.');
  }
  const response = await socketReads.call('integrations.complete', {
    team_id: teamId,
    challenge_id: challengeId,
    body: { completion_code: completionCode },
  });
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not finish.'), response.status);
  }
  if (
    !exactKeys(body, ['connected', 'team_id', 'assistant_id', 'integration_id']) ||
    body.connected !== true ||
    body.team_id !== teamId
  ) {
    throw new LocalApiError('The Assistant completion response is invalid.', response.status);
  }
  return {
    connected: true,
    team_id: teamId,
    assistant_id: canonicalId(body.assistant_id, 'The Assistant completion response is invalid.'),
    integration_id: canonicalId(body.integration_id, 'The Assistant completion response is invalid.', isIdentifier),
  };
}

export async function cancelAssistantIntegrationAuthorization(teamId, challengeId) {
  requireTeam(teamId);
  if (typeof challengeId !== 'string' || !OPAQUE_ID_RE.test(challengeId)) {
    throw new LocalApiError('Invalid Assistant authorization request.');
  }
  const response = await socketReads.call('integrations.cancel', { team_id: teamId, challenge_id: challengeId });
  if (!response.ok) {
    const body = await jsonObject(response);
    throw new LocalApiError(safeApiError(body, 'Assistant authorization could not be cancelled.'), response.status);
  }
  if (response.status !== 204) {
    throw new LocalApiError('The Assistant cancellation response is invalid.', response.status);
  }
}

/**
 * One Team's Integrations and Stored Inputs as the chat's drawer shows them: each a synced value of its own read on the
 * Team's `team/{id}/integrations` topic, read while a screen shows them and again whenever Admin says either changed.
 */
export function teamIntegrations(teamId) {
  const topic = `team/${teamId}/integrations`;
  return {
    teamId,
    integrations: synced(topic, async (call) => (await listAssistantIntegrations(teamId, call)).integrations),
    storedInputs: synced(topic, async (call) => (await listAssistantStoredInputs(teamId, call)).stored_inputs),
  };
}
