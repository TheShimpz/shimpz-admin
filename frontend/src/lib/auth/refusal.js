import { LocalApiError } from '#lib/api.js';
import { fill } from '#lib/i18n/fill.js';
import { outcomeUnknown } from '#lib/session/socket.js';

// Admin refused the proof itself (ADR-0051), so the operation was never asked, and how each refusal is shown.
const REFUSED = {
  'password-incorrect': (words) => ({ clear: 'password', focus: 'password', passwordError: words.passwordIncorrect }),
  'code-incorrect': (words) => ({ clear: 'code', focus: 'code', codeError: words.codeIncorrect }),
  'authentication-locked': (words, failure) => ({ error: fill(words.locked, { seconds: failure.retryAfter || 60 }) }),
  'code-locked': (words) => ({ clear: 'code', error: words.codeLocked }),
  'authentication-expired': (words) => ({ error: words.expired }),
  'passkey-failed': (words) => ({ error: words.passkeyFailed }),
  'passkey-suspended': (words) => ({ error: words.passkeyFailed }),
  'authentication-unavailable': (words) => ({ error: words.unavailable }),
  'authentication-origin-refused': (words) => ({ error: words.unavailable }),
};

/** The refusal codes of the proof itself: the operation was never asked, so what was typed may stay for another try. */
export const AUTHENTICATION_REFUSALS = new Set(Object.keys(REFUSED));

/**
 * How a password-and-second-factor form shows one refusal (ADR-0051): what to fix where it is fixed, never echoing
 * anything typed. It answers `{ clear, focus, passwordError, codeError, error }`: the field to empty, the field to
 * focus, and the words beside each field or for the whole form.
 *
 * `reason` is the refusal code the operation's own error carried, or '' for any other failure. `words` are the
 * security words with the operation's own where they differ, plus `outcomeUnknown`. `operation(failure)` words a
 * failure of the operation's own error type that is no authentication refusal, or returns null for any other failure;
 * a socket lost before Admin answered, a request that never left, and a passkey ceremony that failed follow it, which
 * `ceremony(failure)` reads as `canceled` or another failure (passkey.js's `passkeyFailure`).
 */
export function secondFactorRefusal(failure, { reason, words, operation, ceremony }) {
  if (AUTHENTICATION_REFUSALS.has(reason)) return REFUSED[reason](words, failure);
  const own = operation(failure);
  if (own !== null) return { error: own };
  if (outcomeUnknown(failure)) return { error: words.outcomeUnknown };
  // The socket dropped before the request left: nothing was asked, and the form stays for another try.
  if (failure instanceof LocalApiError) return { error: words.unavailable };
  return { error: words[ceremony(failure) === 'canceled' ? 'passkeyCanceled' : 'passkeyFailed'] };
}
