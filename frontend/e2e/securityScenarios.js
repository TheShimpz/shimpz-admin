// The Supervisor's sign-in security in the scenarios (ADR-0051, ADR-0087): first setup with its recovery codes, sign-in
// with an authenticator code or a recovery code and the re-enrollment it begins, the refused second-factor attempts a
// sign-in reported, and replacing the recovery codes. Any password but `wrong password` is the Supervisor's, any
// six-digit code but `000000` is the authenticator's, and only a code of the current set is a recovery code.

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const ENROLLMENT = Object.freeze({
  secret: SECRET,
  uri: `otpauth://totp/Shimpz%20Supervisor?secret=${SECRET}&issuer=Shimpz&digits=6&period=30`,
});
const CODE_STEMS = ['7f3k-q9xd', 'm2hv-8tcz', 'b6wn-4pyr', 'k8ds-2vgh', 'x4tq-7nmb', 'p9cf-3hwk', 'h5zr-6dqt', 'w3mb-9kfp',
  'd7yn-5xsc', 'g2kp-8rwv'];
const SET_MARKS = '0123456789abcdefghjkmnpqrstvwxyz';

/** The recovery set a scenario issues as its `index`th: ten distinct codes in the written form Admin shows. */
export function recoveryCodeSet(index) {
  const mark = SET_MARKS[index % SET_MARKS.length];
  return CODE_STEMS.map((stem, position) => `${stem}-${mark}${SET_MARKS[position]}${mark}${mark}`);
}

export function securityStart(overrides = {}) {
  return {
    failedAttempts: 0,
    sets: 1,
    codes: recoveryCodeSet(0),
    used: [],
    ticket: null,
    signIns: { previous: { at: '2026-10-08T21:14:00Z', origin: 'http://127.0.0.1:7777' }, failures_since: 0 },
    ...overrides,
  };
}

const ok = (json) => ({ status: 200, json: structuredClone(json) });
const accepted = (json) => ({ status: 202, json: structuredClone(json) });
const refused = (status, json) => ({ status, json });
const SIGNED_IN = Object.freeze({
  profile: 'local',
  authenticated: true,
  initialized: true,
  authentication_state: 'configured',
  authentication_method: 'totp',
  origin_admitted: true,
  oauth_completion_mode: 'automatic',
  passkey_enrollment_available: false,
  passkey_registered: false,
});

function summary(security) {
  return {
    failed_second_factor_attempts: security.failedAttempts,
    recovery_codes_remaining: security.codes.length - security.used.length,
    sign_in_history: structuredClone(security.signIns),
  };
}

function freshSet(security) {
  security.codes = recoveryCodeSet(security.sets);
  security.sets += 1;
  security.used = [];
  return [...security.codes];
}

const password = (body) => typeof body?.password === 'string' && body.password !== 'wrong password';
const authenticatorCode = (body) => /^[0-9]{6}$/.test(body?.code ?? '') && body.code !== '000000';
const writtenCode = (value) => (typeof value === 'string' ? value.toLowerCase().replace(/[\s-]/g, '') : '');

function signIn(state) {
  state.session = structuredClone(SIGNED_IN);
  state.security.ticket = null;
}

function setupRoutes(state, method, path, body) {
  if (method !== 'POST') return null;
  if (path === '/api/admin/setup' && state.session.authentication_state === 'uninitialized') {
    if (!password(body)) return refused(400, { code: 'password-too-short', detail: 'password is too short' });
    state.security.ticket = 'totp-enrollment';
    return accepted({ enrollment: ENROLLMENT });
  }
  if (path === '/api/admin/setup/totp' && state.security.ticket === 'totp-enrollment') {
    if (!authenticatorCode(body)) {
      state.security.ticket = null;
      return refused(401, { detail: 'invalid verification code' });
    }
    signIn(state);
    return ok({ ok: true, method: 'totp', recovery_codes: state.security.codes });
  }
  return null;
}

function loginRoutes(state, method, path, body) {
  const security = state.security;
  if (method !== 'POST' || state.session.authenticated) return null;
  if (path === '/api/login' && state.session.authentication_state === 'configured') {
    if (!password(body)) return refused(401, { detail: 'invalid Supervisor credentials' });
    security.ticket = 'login';
    return accepted({ methods: security.reenrolling ? ['recovery-code'] : ['totp', 'recovery-code'] });
  }
  if (path === '/api/login/totp' && security.ticket === 'login' && !security.reenrolling) {
    security.ticket = null;
    if (!authenticatorCode(body)) {
      security.failedAttempts += 1;
      return refused(401, { detail: 'invalid verification code' });
    }
    signIn(state);
    return ok({ ok: true, method: 'totp' });
  }
  if (path === '/api/login/recovery' && security.ticket === 'login') {
    security.ticket = null;
    const typed = writtenCode(body?.code);
    const match = security.codes.find((code) => writtenCode(code) === typed && !security.used.includes(code));
    if (!match) {
      security.failedAttempts += 1;
      return refused(401, { detail: 'invalid recovery code' });
    }
    security.used.push(match);
    security.reenrolling = true;
    security.ticket = 'recovery-enrollment';
    return accepted({ enrollment: ENROLLMENT });
  }
  if (path === '/api/login/recovery/totp' && security.ticket === 'recovery-enrollment') {
    if (!authenticatorCode(body)) {
      security.failedAttempts += 1;
      return refused(401, { detail: 'invalid verification code' });
    }
    security.reenrolling = false;
    signIn(state);
    return ok({ ok: true, method: 'totp', recovery_codes: freshSet(security) });
  }
  return null;
}

function signedInRoutes(state, method, path, body) {
  if (!state.session.authenticated) return null;
  const security = state.security;
  if (path === '/api/admin/security' && method === 'GET') return ok(summary(security));
  if (path === '/api/admin/security/failures' && method === 'POST') {
    const seen = body?.acknowledged;
    if (!Number.isSafeInteger(seen) || seen < 1 || Object.keys(body).length !== 1) {
      return refused(400, { detail: 'request body must contain only a positive acknowledged count' });
    }
    security.failedAttempts = Math.max(security.failedAttempts - seen, 0);
    return ok(summary(security));
  }
  if (path === '/api/admin/recovery-codes/confirmation' && method === 'POST') {
    if (!password(body)) return refused(401, { code: 'password-incorrect' });
    security.ticket = 'operation';
    return accepted({ methods: ['totp'] });
  }
  if (path === '/api/admin/recovery-codes' && method === 'POST') {
    if (security.ticket !== 'operation') return refused(401, { code: 'authentication-expired' });
    security.ticket = null;
    if (!authenticatorCode(body)) return refused(401, { code: 'code-incorrect' });
    return ok({ recovery_codes: freshSet(security) });
  }
  return null;
}

/** Answer the authentication and security routes, or null for a request they do not cover. */
export function securityRoutes(state, method, path, body) {
  return setupRoutes(state, method, path, body) ?? loginRoutes(state, method, path, body) ??
    signedInRoutes(state, method, path, body);
}
