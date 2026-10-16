import { get } from 'svelte/store';

import { isFactorCode } from '#lib/auth/factor.js';
import { authenticateWithPasskey, passkeyFailure } from '#lib/auth/passkey.js';
import { AUTHENTICATION_REFUSALS, secondFactorRefusal } from '#lib/auth/refusal.js';
import { sessionContext } from '#lib/session/context.js';
import { commandsReady } from '#lib/session/socket.js';
import { focusMark, regainFocus } from '#lib/shell/focus.js';

/**
 * One Supervisor confirmation's state and run (ADR-0051): the Supervisor password, then one second factor bound to the
 * operation, a code by default and a passkey beside it only where this address has one. Its host owns the operation
 * and the form around SecondFactor (whose fields `id` prefixes):
 * - `words()`: the security words with the operation's own where they differ, plus `outcomeUnknown`;
 * - `begin(password)` resolves to the offer, `complete(proof)` to what `ondone` receives;
 * - `errorType` is the operation's own error, whose `code` names its refusal, and `failureWords(failure)` words one
 *   that is no authentication refusal;
 * - `spendsProof`: a failure once the proof was sent, other than an authentication refusal, empties what was typed.
 */
export class Confirmation {
  password = $state('');
  code = $state('');
  method = $state('totp');
  passkeyOffered = $state(get(sessionContext).passkeyRegistered);
  passwordError = $state('');
  codeError = $state('');
  error = $state('');
  busy = $state(false);
  ready = $derived(this.password.length > 0 && (this.method === 'passkey' || isFactorCode(this.code)));

  #id;
  #host;
  #live = true;
  // The field a refusal leaves to fix takes the focus once the controls the request disabled are enabled again; focus
  // the person moved meanwhile (since `#mark`) stays where it is.
  #refocus = '';
  #mark = 0;

  constructor(id, host) {
    this.#id = id;
    this.#host = host;
  }

  /** For an effect: the password takes the focus when the confirmation opens, and nothing is focused once it closed. */
  open() {
    document.getElementById(`${this.#id}-password`)?.focus();
    return () => { this.#live = false; };
  }

  #regain() {
    const field = this.#refocus;
    this.#refocus = '';
    void regainFocus(() => document.getElementById(`${this.#id}-${field}`), {
      shown: () => this.#live,
      since: this.#mark,
    });
  }

  #own(failure) {
    return failure instanceof this.#host.errorType;
  }

  // Each refusal says what to fix where it is fixed; nothing typed is ever echoed back.
  #refused(failure) {
    const shown = secondFactorRefusal(failure, {
      reason: this.#own(failure) ? failure.code : '',
      words: this.#host.words(),
      operation: (other) => (this.#own(other) ? this.#host.failureWords(other) : null),
      ceremony: passkeyFailure,
    });
    if (shown.clear === 'password') this.password = '';
    if (shown.clear === 'code') this.code = '';
    this.passwordError = shown.passwordError ?? '';
    this.codeError = shown.codeError ?? '';
    this.error = shown.error ?? '';
    // A refusal of the whole form names no field: the password, enabled again, takes the focus.
    this.#refocus = shown.focus ?? 'password';
  }

  async #proof(offer) {
    if (this.method === 'totp') return { code: this.code };
    if (!offer.passkey) {
      this.passkeyOffered = false;
      this.method = 'totp';
      this.error = this.#host.words().passkeyMissing;
      this.#refocus = 'code';
      return null;
    }
    return { credential: await authenticateWithPasskey(offer.passkey) };
  }

  /** The form's submit handler. */
  submit = async (event) => {
    event.preventDefault();
    if (this.busy || !this.ready || !get(commandsReady)) return;
    this.busy = true;
    this.#mark = focusMark();
    this.passwordError = this.codeError = this.error = '';
    let sent = false;
    try {
      const offer = await this.#host.begin(this.password);
      const factor = this.#live ? await this.#proof(offer) : null;
      // A confirmation closed while the passkey was asked for never runs the operation.
      if (!factor || !this.#live) return;
      sent = true;
      const result = await this.#host.complete(factor);
      this.password = this.code = '';
      this.#host.ondone(result);
    } catch (failure) {
      // Admin refused the proof itself, so the operation was never asked: what was typed stays for the next try.
      const refusedProof = this.#own(failure) && AUTHENTICATION_REFUSALS.has(failure.code);
      if (sent && this.#host.spendsProof && !refusedProof) this.password = this.code = '';
      this.#refused(failure);
    } finally {
      this.busy = false;
      if (this.#refocus) this.#regain();
    }
  };
}
