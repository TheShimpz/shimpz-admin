import { exactKeys } from '../api.js';

// The second factor that confirms an operation the Supervisor password started (ADR-0051): what Admin offers after
// the password, and the one proof that spends it. Every client of a confirmed operation reads them here.
const CODE_RE = /^[0-9]{6}$/;

/** Whether a value is an authenticator code: exactly six digits. */
export function isFactorCode(value) {
  return CODE_RE.test(value);
}

/**
 * The second factors Admin offers once the password is right: `{ passkey: null }` when only an authenticator code may
 * answer, `{ passkey: options }` when a passkey may too, or null for any other answer.
 */
export function factorOffer(body) {
  const methods = JSON.stringify(body.methods);
  if (methods === '["totp"]' && exactKeys(body, ['methods'])) return { passkey: null };
  if (methods === '["totp","passkey"]' && exactKeys(body, ['methods', 'passkey_options']) && body.passkey_options
    && typeof body.passkey_options === 'object') {
    return { passkey: body.passkey_options };
  }
  return null;
}

/** Whether a proof is exactly one second factor: `{ code }` with an authenticator code, or `{ credential }`. */
export function isFactorProof(proof) {
  const byCode = exactKeys(proof, ['code']) && isFactorCode(proof.code);
  const byPasskey = exactKeys(proof, ['credential']) && proof.credential && typeof proof.credential === 'object';
  return Boolean(byCode || byPasskey);
}
