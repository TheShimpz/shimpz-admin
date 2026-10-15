import { LocalApiError } from '#lib/api.js';
import { fill } from '#lib/i18n/fill.js';
import { outcomeUnknown } from '#lib/session/socket.js';

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
  if (reason === 'password-incorrect') {
    return { clear: 'password', focus: 'password', passwordError: words.passwordIncorrect };
  }
  if (reason === 'code-incorrect') return { clear: 'code', focus: 'code', codeError: words.codeIncorrect };
  if (reason === 'authentication-locked') return { error: fill(words.locked, { seconds: failure.retryAfter || 60 }) };
  if (reason === 'code-locked') return { clear: 'code', error: words.codeLocked };
  if (reason === 'authentication-expired') return { error: words.expired };
  if (reason === 'passkey-failed' || reason === 'passkey-suspended') return { error: words.passkeyFailed };
  if (reason === 'authentication-unavailable' || reason === 'authentication-origin-refused') {
    return { error: words.unavailable };
  }
  const own = operation(failure);
  if (own !== null) return { error: own };
  if (outcomeUnknown(failure)) return { error: words.outcomeUnknown };
  // The socket dropped before the request left: nothing was asked, and the form stays for another try.
  if (failure instanceof LocalApiError) return { error: words.unavailable };
  return { error: words[ceremony(failure) === 'canceled' ? 'passkeyCanceled' : 'passkeyFailed'] };
}
