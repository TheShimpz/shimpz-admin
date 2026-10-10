import { LocalApiError, safeApiError } from './localApi.js';
import { exactKeys, jsonObject, TEAM_ID_RE } from './validate.js';

// A Team's Action confirmation setting (ADR-0112): while on, Team asks the Supervisor to confirm each mutating Action
// that declares no authorization before it runs. Only a Supervisor session reads or changes it; it is on by default.

function path(teamId) {
  return `/api/teams/${encodeURIComponent(teamId)}/action-confirmation`;
}

async function setting(response, teamId, fallback) {
  const body = await jsonObject(response);
  if (!response.ok) throw new LocalApiError(safeApiError(body, fallback), response.status);
  if (!exactKeys(body, ['team_id', 'confirm_mutating']) || body.team_id !== teamId
    || typeof body.confirm_mutating !== 'boolean') {
    throw new LocalApiError('The Action confirmation setting is invalid.', response.status);
  }
  return body.confirm_mutating;
}

/** Whether Team confirms this Team's mutating Actions before they run. */
export async function loadActionConfirmation(fetcher, teamId) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId)) {
    throw new LocalApiError('Invalid Action confirmation request.');
  }
  const response = await fetcher(path(teamId), { cache: 'no-store', headers: { Accept: 'application/json' } });
  return setting(response, teamId, 'The Action confirmation setting is unavailable.');
}

/** Turn the confirmation on or off; resolves to the setting Team saved. */
export async function saveActionConfirmation(fetcher, teamId, enabled) {
  if (typeof fetcher !== 'function' || !TEAM_ID_RE.test(teamId) || typeof enabled !== 'boolean') {
    throw new LocalApiError('Invalid Action confirmation request.');
  }
  const response = await fetcher(path(teamId), {
    method: 'PUT',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_mutating: enabled }),
  });
  const saved = await setting(response, teamId, 'The Action confirmation setting could not be saved.');
  if (saved !== enabled) throw new LocalApiError('The Action confirmation setting is invalid.', response.status);
  return saved;
}
