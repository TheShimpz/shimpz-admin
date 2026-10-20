// A Team's Sign-in (ADR-0117, 2026-10-20 amendment): each Team has one browser session that keeps the logins a person
// saved into it. The person adds logins in a sign-in session, a Browser only they drive, restored from the Sign-in when
// there is one, and Saves it; deleting it takes the Supervisor's password and second factor, bound to the exact Sign-in
// shown. Every call goes over the session socket, and only Admin's exact answers are admitted. A refusal keeps its
// closed code so the page can say what to do.

import { exactKeys, jsonObject, LocalApiError, safeApiError } from '../../api.js';
import { factorOffer, isFactorProof } from '../../auth/factor.js';
import { TEAM_ID_RE } from '../../ids.js';
import { socketReads } from '../../session/socket.js';
import { synced } from '../../session/synced.js';

const ID_RE = /^[0-9a-f]{32}$/;
const INCARNATION_RE = /^[0-9a-f]{64}$/;
const SITE_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const STATES = new Set(['ready', 'needs-person']);
const MAX_SITES = 64;
const MAX_URL_CHARS = 2_048;
const SIGN_IN_KEYS = [
  'sign_in_id', 'state', 'generation', 'team_incarnation', 'sites', 'sites_truncated', 'created_at', 'saved_at',
  'last_used_at', 'expires_at',
];

const invalid = (status = 0) => new LocalApiError('The Sign-in answer is invalid.', status);

function requireTeam(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new LocalApiError('The Team is invalid.');
}

/** The https URL a person typed, `https://` added when they named a site alone; '' when it is no https URL. */
export function startUrl(value) {
  const typed = typeof value === 'string' ? value.trim() : '';
  if (!typed || typed.length > MAX_URL_CHARS || /\s/.test(typed)) return '';
  const url = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && SITE_RE.test(parsed.hostname)
      ? url
      : '';
  } catch {
    return '';
  }
}

function signIn(value) {
  if (!exactKeys(value, SIGN_IN_KEYS)) return null;
  const sites = value.sites;
  const valid = ID_RE.test(value.sign_in_id) && STATES.has(value.state) &&
    Number.isSafeInteger(value.generation) && value.generation >= 1 &&
    typeof value.team_incarnation === 'string' && INCARNATION_RE.test(value.team_incarnation) &&
    Array.isArray(sites) && sites.length <= MAX_SITES &&
    sites.every((site, index) => typeof site === 'string' && SITE_RE.test(site) && (index === 0 || sites[index - 1] < site)) &&
    typeof value.sites_truncated === 'boolean' &&
    [value.created_at, value.saved_at, value.last_used_at, value.expires_at]
      .every((moment) => typeof moment === 'string' && TIME_RE.test(moment)) &&
    value.created_at <= value.saved_at && value.saved_at < value.expires_at && value.created_at <= value.last_used_at;
  return valid ? value : null;
}

// Admin's answer: `admit(body)` when it is one, else its refusal with its closed code.
async function answered(response, admit, fallback) {
  const body = await jsonObject(response);
  if (!response.ok) {
    throw new LocalApiError(safeApiError(body, fallback), response.status, typeof body.code === 'string' ? body.code : '');
  }
  const admitted = admit(body);
  if (admitted === null) throw invalid(response.status);
  return admitted;
}

/** The Team's Sign-in, or null when it has none. */
export async function readSignIn(teamId, call = socketReads.call) {
  requireTeam(teamId);
  return answered(await call('sign_in.read', { team_id: teamId }), (body) => {
    if (!exactKeys(body, ['sign_in'])) return null;
    if (body.sign_in === null) return { signIn: null };
    const kept = signIn(body.sign_in);
    return kept ? { signIn: kept } : null;
  }, 'The browser session is unavailable.').then((read) => read.signIn);
}

/** One Team's Sign-in as a synced value, read again whenever Admin says it changed. */
export function teamSignIn(teamId) {
  requireTeam(teamId);
  return synced(`team/${teamId}/sign-in`, (call) => readSignIn(teamId, call));
}

/** Start a sign-in session at `url`: `{ sessionId, viewId, site }`. */
export async function startSignIn(teamId, url, locale, call = socketReads.call) {
  requireTeam(teamId);
  const body = { url: startUrl(url), locale };
  if (!body.url) throw new LocalApiError('The sign-in address is invalid.', 400, 'sign-in-url-invalid');
  return answered(await call('sign_in.start', { team_id: teamId, body }), (answer) => (
    exactKeys(answer, ['sign_in_session_id', 'view_id', 'site']) &&
    ID_RE.test(answer.sign_in_session_id) && ID_RE.test(answer.view_id) && SITE_RE.test(answer.site)
      ? { sessionId: answer.sign_in_session_id, viewId: answer.view_id, site: answer.site }
      : null
  ), 'The sign-in could not start.');
}

/** Save the session as the Sign-in's next generation: `{ signIn, recorded }`. */
export async function saveSignIn(teamId, sessionId, call = socketReads.call) {
  requireTeam(teamId);
  return answered(
    await call('sign_in.save', { team_id: teamId, body: { sign_in_session_id: sessionId } }),
    (answer) => {
      if (!exactKeys(answer, ['sign_in', 'recorded']) || typeof answer.recorded !== 'boolean') return null;
      const kept = signIn(answer.sign_in);
      return kept ? { signIn: kept, recorded: answer.recorded } : null;
    },
    'The browser session could not be saved.',
  );
}

/** End the session; a restored Sign-in then needs a person's Save before the agent uses it. */
export async function cancelSignIn(teamId, sessionId, call = socketReads.call) {
  requireTeam(teamId);
  const body = { sign_in_session_id: sessionId };
  return answered(
    await call('sign_in.cancel', { team_id: teamId, body }),
    (answer) => (exactKeys(answer, ['cancelled']) && answer.cancelled === true ? true : null),
    'The sign-in could not be cancelled.',
  );
}

/** Begin deleting the Team's Sign-in with the Supervisor password: the second factors Admin offers. */
export async function beginSignInDeletion(teamId, password, call = socketReads.call) {
  requireTeam(teamId);
  if (typeof password !== 'string' || password.length < 1) throw new LocalApiError('The password is required.');
  return answered(
    await call('sign_in.deletion', { team_id: teamId, body: { password } }),
    factorOffer,
    'The deletion could not start.',
  );
}

/** Delete exactly `signIn` with one second factor: `deleted`, or `pending` while Team completes it. */
export async function deleteSignIn(teamId, shown, proof, call = socketReads.call) {
  requireTeam(teamId);
  if (signIn(shown) === null || !isFactorProof(proof)) throw new LocalApiError('The deletion is invalid.');
  const params = {
    team_id: teamId,
    sign_in_id: shown.sign_in_id,
    generation: String(shown.generation),
    team_incarnation: shown.team_incarnation,
    body: proof,
  };
  return answered(
    await call('sign_in.delete', params),
    (answer) => (exactKeys(answer, ['deletion']) && ['deleted', 'pending'].includes(answer.deletion) ? answer.deletion : null),
    'The browser session could not be deleted.',
  );
}
