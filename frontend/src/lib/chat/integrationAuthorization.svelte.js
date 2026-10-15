// The Integration request a chat turn waits on and the Supervisor's authorization of it: the request (`challenge`),
// whether its dialog is open, and the authorization under way (`working`: the requirement being authorized, or
// `complete` while a completion code is sent). The chat page owns one per channel and words its errors.
import { flushSync } from 'svelte';
import {
  authorizeAssistantIntegration,
  cancelAssistantIntegrationAuthorization,
  completeAssistantIntegration,
} from '#lib/assistants/integrations.js';

export class IntegrationAuthorization {
  challenge = $state();
  dialogOpen = $state(false);
  working = $state('');
  #host;

  /**
   * `host` is the page: its Team (`teamId()`), the OAuth completion mode its session expects (`completionMode()`), the
   * Integrations' words (`words()`), its error notice (`setError`), and how a failure reads (`failureDetail`).
   */
  constructor(host) {
    this.#host = host;
  }

  /** Nothing is pending any more. */
  reset() {
    this.challenge = undefined;
    this.dialogOpen = false;
    this.working = '';
  }

  /** Shows an admitted request in its dialog. */
  accept(incoming) {
    this.challenge = incoming;
    this.dialogOpen = true;
  }

  #fail(teamId, message, reason) {
    if (this.#host.teamId() === teamId) this.#host.setError(message, this.#host.failureDetail(reason, message));
  }

  /** Starts the provider's authorization of one requirement of the pending request. */
  authorize = async (challengeId, requirement) => {
    const teamId = this.#host.teamId();
    if (
      !teamId ||
      this.working ||
      !this.challenge ||
      this.challenge.challenge_id !== challengeId ||
      !this.challenge.requirements.some((candidate) => (
        candidate.assistant_id === requirement?.assistant_id &&
        candidate.integration_id === requirement?.integration_id
      ))
    ) throw new Error(this.#host.words().authorizationFailed);
    this.working = `${requirement.assistant_id}/${requirement.integration_id}`;
    flushSync();
    const expectedCompletionMode = this.#host.completionMode();
    // Code completion needs a separate tab opened while this click still owns browser activation.
    const authorizationWindow = expectedCompletionMode === 'code'
      ? window.open('about:blank', '_blank')
      : null;
    if (authorizationWindow) authorizationWindow.opener = null;
    let authorizationStarted = false;
    try {
      const authorization = await authorizeAssistantIntegration(
        teamId,
        challengeId,
        requirement.assistant_id,
        requirement.integration_id,
      );
      authorizationStarted = true;
      if (this.#host.teamId() !== teamId || this.challenge?.challenge_id !== challengeId) {
        throw new Error(this.#host.words().authorizationFailed);
      }
      if (authorization.completion_mode !== expectedCompletionMode) {
        throw new Error(this.#host.words().authorizationFailed);
      }
      if (authorization.completion_mode === 'code') {
        if (!authorizationWindow || authorizationWindow.closed) {
          throw new Error(this.#host.words().authorizationFailed);
        }
        authorizationWindow.location.replace(authorization.authorization_url);
        this.working = '';
        return authorization;
      }
      location.assign(authorization.authorization_url);
      return authorization;
    } catch (reason) {
      authorizationWindow?.close();
      if (authorizationStarted) {
        try {
          await cancelAssistantIntegrationAuthorization(teamId, challengeId);
        } catch {
          // Bounded server-side expiry remains the fail-closed fallback.
        }
      }
      this.#fail(teamId, this.#host.words().authorizationFailed, reason);
      this.working = '';
      throw reason;
    }
  };

  /** Sends the completion code the provider showed, then returns to the chat. */
  complete = async (challengeId, completionCode) => {
    const teamId = this.#host.teamId();
    if (
      !teamId ||
      this.working ||
      this.challenge?.challenge_id !== challengeId
    ) throw new Error(this.#host.words().completionFailed);
    this.working = 'complete';
    try {
      await completeAssistantIntegration(teamId, challengeId, completionCode);
      if (this.#host.teamId() !== teamId || this.challenge?.challenge_id !== challengeId) {
        throw new Error(this.#host.words().completionFailed);
      }
      location.assign('/chat');
    } catch (reason) {
      if (this.#host.teamId() === teamId) this.working = '';
      this.#fail(teamId, this.#host.words().completionFailed, reason);
      throw reason;
    }
  };

  /** Abandons an authorization the Supervisor left. */
  cancel = async (challengeId) => {
    const teamId = this.#host.teamId();
    if (!teamId || this.challenge?.challenge_id !== challengeId) return;
    try {
      await cancelAssistantIntegrationAuthorization(teamId, challengeId);
    } catch {
      // Expiry remains bounded and a new authorization uses a fresh binding.
    } finally {
      if (this.#host.teamId() === teamId) this.working = '';
    }
  };
}
