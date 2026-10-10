// The Supervisor's sign-in security in the scenarios (ADR-0051, ADR-0087): the refused second-factor attempts a
// sign-in reported, kept until acknowledged.

export function securityStart(overrides = {}) {
  return { failedAttempts: 0, ...overrides };
}

const ok = (json) => ({ status: 200, json: structuredClone(json) });

function summary(security) {
  return { failed_second_factor_attempts: security.failedAttempts };
}

/** Answer the signed-in security routes, or null for a request they do not cover. */
export function securityRoutes(state, method, path, body) {
  if (!state.session.authenticated) return null;
  if (path === '/api/admin/security' && method === 'GET') return ok(summary(state.security));
  if (path === '/api/admin/security/failures' && method === 'POST') {
    const seen = body?.acknowledged;
    if (!Number.isSafeInteger(seen) || seen < 1 || Object.keys(body).length !== 1) {
      return { status: 400, json: { detail: 'request body must contain only a positive acknowledged count' } };
    }
    state.security.failedAttempts = Math.max(state.security.failedAttempts - seen, 0);
    return ok(summary(state.security));
  }
  return null;
}
