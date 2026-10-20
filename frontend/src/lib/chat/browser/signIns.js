// A Team's Sign-ins (ADR-0117, Sign-ins amendment): the person signs in to one site in a Browser only they drive (a
// sign-in session) and Saves it as a Sign-in, the Team's sealed copy of that browser profile; the Team lists them and
// forgets one. Every call goes over the session socket, and only Admin's exact answers are admitted. A refusal keeps
// its closed code so the page can say what to do.

import { exactKeys, jsonObject, LocalApiError, safeApiError } from '../../api.js';
import { CONTROL_RE } from '../../grammar.js';
import { TEAM_ID_RE } from '../../ids.js';
import { socketReads } from '../../session/socket.js';
import { synced } from '../../session/synced.js';

const ID_RE = /^[0-9a-f]{32}$/;
const SITE_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_LABEL_CHARS = 64;
const MAX_SIGN_INS = 16;
const MAX_URL_CHARS = 2_048;
const SIGN_IN_KEYS = ['sign_in_id', 'site', 'label', 'created_at', 'last_used_at', 'expires_at'];

const invalid = (status = 0) => new LocalApiError('The Sign-in answer is invalid.', status);

function requireTeam(teamId) {
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) throw new LocalApiError('The Team is invalid.');
}

/** A label as Team keeps it: trimmed, printable, 1 to 64 characters; '' when it is none. */
export function canonicalLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return label.length > 0 && label.length <= MAX_LABEL_CHARS && !CONTROL_RE.test(label) ? label : '';
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
  const times = [value.created_at, value.last_used_at, value.expires_at];
  const valid = typeof value.sign_in_id === 'string' && ID_RE.test(value.sign_in_id) &&
    typeof value.site === 'string' && SITE_RE.test(value.site) &&
    canonicalLabel(value.label) === value.label &&
    times.every((moment) => typeof moment === 'string' && TIME_RE.test(moment)) &&
    value.created_at <= value.last_used_at && value.last_used_at < value.expires_at;
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

/** The Team's Sign-ins, oldest first as Team lists them. */
export async function listSignIns(teamId, call = socketReads.call) {
  requireTeam(teamId);
  return answered(await call('sign_ins.list', { team_id: teamId }), (body) => {
    if (!exactKeys(body, ['sign_ins']) || !Array.isArray(body.sign_ins) || body.sign_ins.length > MAX_SIGN_INS) return null;
    const listed = body.sign_ins.map(signIn);
    const ids = new Set(listed.map((item) => item?.sign_in_id));
    return listed.every(Boolean) && ids.size === listed.length ? listed : null;
  }, 'The Sign-ins are unavailable.');
}

/** One Team's Sign-ins as a synced value, read again whenever Admin says they changed. */
export function teamSignIns(teamId) {
  requireTeam(teamId);
  return synced(`team/${teamId}/sign-ins`, (call) => listSignIns(teamId, call));
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

/** Save the session as a Sign-in under `label`: the saved Sign-in. */
export async function saveSignIn(teamId, sessionId, label, call = socketReads.call) {
  requireTeam(teamId);
  const kept = canonicalLabel(label);
  if (!kept) throw new LocalApiError('The Sign-in label is invalid.', 400, 'sign-in-label-invalid');
  const body = { sign_in_session_id: sessionId, label: kept };
  return answered(await call('sign_in.save', { team_id: teamId, body }), signIn, 'The Sign-in could not be saved.');
}

/** End the session, keeping nothing. */
export async function cancelSignIn(teamId, sessionId, call = socketReads.call) {
  requireTeam(teamId);
  const body = { sign_in_session_id: sessionId };
  return answered(
    await call('sign_in.cancel', { team_id: teamId, body }),
    (answer) => (exactKeys(answer, ['cancelled']) && answer.cancelled === true ? true : null),
    'The sign-in could not be cancelled.',
  );
}

/** Forget one Sign-in; false when it was already gone. */
export async function forgetSignIn(teamId, signInId, call = socketReads.call) {
  requireTeam(teamId);
  return answered(
    await call('sign_ins.forget', { team_id: teamId, body: { sign_in_id: signInId } }),
    (answer) => (exactKeys(answer, ['forgotten']) && typeof answer.forgotten === 'boolean' ? answer.forgotten : null),
    'The Sign-in could not be forgotten.',
  );
}
