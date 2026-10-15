// The human request a chat turn waits on (ADR-0091): the request shown, Team's refusal of a password it asked for, an
// answer Team is still checking, a request that expired and is being reconciled, and the interface language a
// reconciling sync asked Team to render the pending request in. The chat page owns one per channel and words its errors.
import { createHumanResponseFrame, createSyncFrame } from './protocol.js';

export class HumanRequest {
  challenge = $state();
  rejection = $state();
  // A password answer Team is still checking.
  working = $state(false);
  // The request that expired, until Team says what is pending instead.
  expiredId = $state('');
  // The interface language a reconciling sync asked Team to render the pending request in.
  relocalizing = $state('');
  #host;

  /**
   * `host` is the page: its `liveTurn`, its open chat channel (`channel()`, null while closed) and Team (`teamId()`),
   * the selected language (`locale()`), its error notice (`setError`, `clearError`, and `failSend(reason)`, which also
   * closes the channel), the expiry's words (`expired()`), and `focusStop()`.
   */
  constructor(host) {
    this.#host = host;
  }

  /** Whether the dialog shows the request: one that expired is reconciled instead. */
  get open() {
    return Boolean(this.challenge) && this.challenge.challenge_id !== this.expiredId;
  }

  /** Nothing is pending any more. */
  reset() {
    this.dismiss();
    this.relocalizing = '';
  }

  /** Another request took the turn's place (an Integration request): this one is no longer shown. */
  dismiss() {
    this.challenge = undefined;
    this.rejection = undefined;
    this.working = false;
    this.expiredId = '';
  }

  /**
   * A request Admin opened, in exactly the language a reconciling sync named; it throws on any other language, and the
   * page then fails the channel.
   */
  admitLocale(incoming) {
    if (!this.relocalizing) return;
    if (incoming.locale !== this.relocalizing) throw new Error('unexpected human request language');
    this.relocalizing = '';
  }

  /** Shows an admitted request; one that answers a reconciled expiry also clears the expiry's error. */
  accept(incoming) {
    const reconciledExpiry = this.expiredId === incoming.challenge_id;
    this.expiredId = '';
    if (reconciledExpiry) this.#host.clearError();
    this.challenge = incoming;
    this.rejection = undefined;
    this.working = false;
  }

  /** Team refused the password the request asked for; an expired request is reconciled instead. */
  rejected(incoming) {
    if (
      !this.working ||
      this.challenge?.challenge_id !== incoming.challenge_id ||
      this.challenge?.request?.kind !== 'auth:password'
    ) throw new Error('unexpected human response rejection');
    this.working = false;
    if (this.expiredId === incoming.challenge_id) {
      this.reconcileExpired(incoming.challenge_id);
      return;
    }
    this.rejection = incoming;
  }

  /** Team's progress after an answer ends the request it answered; the page then gives the Stop the focus. */
  progressed() {
    const answered = this.working;
    if (answered) {
      this.challenge = undefined;
      this.working = false;
      this.expiredId = '';
    }
    this.rejection = undefined;
    if (answered) void this.#host.focusStop();
  }

  /** Sends the Supervisor's answer; a password answer waits for Team's verdict. */
  respond(response) {
    const teamId = this.#host.teamId();
    const challenge = this.challenge;
    const channel = this.#host.channel();
    if (!teamId || !challenge || this.working || !channel) return;
    try {
      channel.send(createHumanResponseFrame(teamId, challenge.challenge_id, response.decision, response.value));
      const waitForAuthentication = response.decision === 'submit' && challenge.request.kind === 'auth:password';
      if (waitForAuthentication) {
        this.working = true;
      } else {
        this.challenge = undefined;
        this.working = false;
      }
      this.rejection = undefined;
      this.#host.clearError();
      if (!waitForAuthentication) void this.#host.focusStop();
    } catch (reason) {
      this.working = false;
      this.#host.failSend(reason);
    }
  }

  /** The password may be entered again after Team refused it. */
  retry() {
    if (this.challenge?.request?.kind === 'auth:password') this.rejection = undefined;
  }

  /** The request expired: the turn ends, and Admin is asked what is pending now. */
  reconcileExpired(challengeId) {
    const { liveTurn } = this.#host;
    if (this.challenge?.challenge_id !== challengeId || this.working) return;
    this.expiredId = challengeId;
    liveTurn.busy = false;
    liveTurn.stopping = false;
    this.challenge = undefined;
    this.rejection = undefined;
    this.#host.setError(this.#host.expired());
    const channel = this.#host.channel();
    if (!channel || liveTurn.syncing) return;
    liveTurn.syncing = true;
    liveTurn.resetProgress();
    try {
      channel.send(createSyncFrame(this.#host.teamId(), this.#host.locale()));
    } catch {
      liveTurn.syncing = false;
      channel.close();
    }
  }

  /**
   * A pending or restored request in another language than the one selected is replaced by a fresh challenge in the
   * selected language before it can be answered. A reply that arrives after yet another switch is reconciled again.
   */
  relocalize(selected) {
    const { liveTurn } = this.#host;
    const channel = this.#host.channel();
    this.relocalizing = selected;
    liveTurn.syncing = true;
    try {
      channel.send(createSyncFrame(this.#host.teamId(), selected));
    } catch {
      this.relocalizing = '';
      liveTurn.syncing = false;
      channel.close();
    }
  }

  /** The dialog says the request expired: it is reconciled once no answer is being checked. */
  expire(challengeId) {
    if (this.challenge?.challenge_id !== challengeId || this.expiredId === challengeId) return;
    this.expiredId = challengeId;
    if (!this.working) this.reconcileExpired(challengeId);
  }
}
