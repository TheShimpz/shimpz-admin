// An Assistant uninstall in the chat (ADR-0090): its proposal card, which expires on its own and keeps a snapshot of
// the Assistant's icon, the Supervisor's decision on it, and its outcome, announced only once Team's inventory confirms
// the Assistant is gone. A read that fails keeps the outcome deferred, with its error, until the chat's Retry reads the
// inventory again. The chat page owns one; its cards are turns of the page's transcript.
import { get } from 'svelte/store';
import { refreshTeamInventory, teamContext } from '#lib/teams/context.js';
import { expiredTurns, lifecycleTurnIndex, lifecycleTurns } from '../turns.js';
import { snapshotIcon } from './snapshot.js';

// How long an icon snapshot may take before the card goes on without it.
const ICON_CAPTURE_MS = 2000;

export class UninstallLifecycle {
  // The outcome being confirmed against Team's inventory: its Team, proposal, and Assistant.
  outcomePending = $state(null);
  // Whether a decision on a proposal is being sent.
  decisionPending = $state(false);
  #expiryTimers = new Map();
  #iconCaptures = new Map();
  #deferred = null;
  #transcript;
  #host;

  /**
   * `transcript` holds the cards. `host` is the page: its Team (`teamId()`), its words (`words()`), its error notice
   * (`error()`, `setError`, `clearError`), its chat channel (`socket()`), and `submit(decision)`, which sends a decision.
   */
  constructor(transcript, host) {
    this.#transcript = transcript;
    this.#host = host;
  }

  #mapLifecycle(matches, change) {
    this.#transcript.turns = this.#transcript.turns.map((turn, index) => (
      matches(turn, index) ? { ...turn, lifecycle: { ...turn.lifecycle, ...change } } : turn
    ));
  }

  /** Keeps the proposal's Assistant icon on its card; a capture under way is shared. */
  captureIcon(proposalId, assistantId, teamId) {
    const existing = this.#iconCaptures.get(proposalId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ICON_CAPTURE_MS);
    let captured = false;
    const promise = snapshotIcon(teamId, assistantId, controller.signal).then((snapshot) => {
      if (!snapshot) return;
      captured = true;
      this.#mapLifecycle(
        (turn) => turn.lifecycle?.proposal_id === proposalId && turn.lifecycle.assistant.id === assistantId,
        { iconSnapshot: snapshot },
      );
    }).catch(() => undefined).finally(() => {
      clearTimeout(timer);
      if (!captured && this.#iconCaptures.get(proposalId)?.promise === promise) {
        this.#iconCaptures.delete(proposalId);
      }
    });
    this.#iconCaptures.set(proposalId, { controller, promise });
    return promise;
  }

  /** Stops every icon capture under way. */
  forgetIcons() {
    for (const capture of this.#iconCaptures.values()) capture.controller.abort();
    this.#iconCaptures.clear();
  }

  #clearExpiry(proposalId) {
    const timer = this.#expiryTimers.get(proposalId);
    if (timer) clearTimeout(timer);
    this.#expiryTimers.delete(proposalId);
  }

  #scheduleExpiry(proposalId, expiresIn) {
    this.#clearExpiry(proposalId);
    this.#expiryTimers.set(proposalId, setTimeout(() => {
      this.#expiryTimers.delete(proposalId);
      this.#mapLifecycle(
        (turn) => turn.lifecycle?.proposal_id === proposalId && turn.lifecycle.state === 'proposed',
        { state: 'expired' },
      );
    }, expiresIn * 1000));
  }

  /** The connection that proposed them ended: no proposal of it can be decided any more. */
  expireAll() {
    for (const timer of this.#expiryTimers.values()) clearTimeout(timer);
    this.#expiryTimers.clear();
    this.#transcript.turns = expiredTurns(this.#transcript.turns);
  }

  /**
   * A proposal adds its card, with its expiry and icon snapshot; a later frame moves it on. True when the uninstall
   * ended.
   */
  apply(incoming, receipt) {
    let terminal = false;
    this.#transcript.extend((key) => {
      const next = lifecycleTurns(this.#transcript.turns, incoming, receipt, key, this.#host.words());
      terminal = next.terminal;
      return next.turns;
    });
    if (incoming.state !== 'proposed') {
      this.#clearExpiry(incoming.proposal_id);
      return terminal;
    }
    this.#scheduleExpiry(incoming.proposal_id, incoming.expires_in);
    void this.captureIcon(incoming.proposal_id, incoming.assistant.id, incoming.team_id);
    return terminal;
  }

  async #announce(incoming) {
    const { installedAssistants } = await refreshTeamInventory();
    const pending = this.outcomePending;
    if (
      pending?.teamId !== incoming.team_id ||
      pending?.proposalId !== incoming.proposal_id ||
      pending?.assistantId !== incoming.assistant_id ||
      this.#host.teamId() !== incoming.team_id
    ) return;
    const turns = this.#transcript.turns;
    const index = lifecycleTurnIndex(turns, incoming.proposal_id);
    if (index < 0) return;
    const uninstall = turns[index].lifecycle;
    if (
      uninstall.state !== 'uninstalled' ||
      uninstall.assistant.id !== incoming.assistant_id ||
      uninstall.completionAnnounced
    ) return;
    const context = get(teamContext);
    const team = context.teams.find((entry) => entry.id === incoming.team_id);
    const stillInstalled = installedAssistants.some((entry) => entry.assistant === incoming.assistant_id);
    const stillProjected = context.installedAssistants.some((entry) => entry.assistant === incoming.assistant_id);
    if (
      stillInstalled ||
      stillProjected ||
      !team ||
      context.phase !== 'ready' ||
      context.selectedTeamId !== incoming.team_id ||
      context.activeAssistantIds.includes(incoming.assistant_id)
    ) throw new Error('uninstalled Assistant inventory mismatch');
    this.#mapLifecycle((_turn, turnIndex) => turnIndex === index, { completionAnnounced: true });
    void this.#transcript.reveal();
  }

  /** Announces an uninstall's outcome once Team's inventory confirms it; a failed read defers it with its error. */
  confirm(incoming) {
    this.#deferred = null;
    this.outcomePending = {
      teamId: incoming.team_id,
      proposalId: incoming.proposal_id,
      assistantId: incoming.assistant_id,
    };
    const refreshFailed = this.#host.words().uninstall.refreshFailed;
    const current = () => (
      this.outcomePending?.teamId === incoming.team_id &&
      this.outcomePending?.proposalId === incoming.proposal_id
    );
    return this.#announce(incoming)
      .then(() => {
        if (current() && this.#host.error() === refreshFailed) this.#host.clearError();
      })
      .catch(() => {
        if (!current()) return;
        this.#deferred = incoming;
        this.#host.setError(refreshFailed);
      })
      .finally(() => {
        if (current()) this.outcomePending = null;
      });
  }

  /** Confirms again the outcome deferred for `teamId`, or answers null when none is. */
  retry(teamId) {
    return this.#deferred?.team_id === teamId ? this.confirm(this.#deferred) : null;
  }

  /** Another Team opened: no outcome of the last one is confirmed any more. */
  reset() {
    this.outcomePending = null;
    this.#deferred = null;
  }

  #proposed(proposalId) {
    return this.#transcript.turns.some((turn) => (
      turn.lifecycle?.proposal_id === proposalId && turn.lifecycle.state === 'proposed'
    ));
  }

  /** Sends the Supervisor's decision on the pending proposal; an approval first keeps the Assistant's icon. */
  decide = async (decision) => {
    if (this.decisionPending) return false;
    this.decisionPending = true;
    try {
      const pendingUninstall = this.#transcript.turns.findLast((turn) => (
        turn.lifecycle?.state === 'proposed'
      ))?.lifecycle;
      const teamId = this.#host.teamId();
      if (decision === 'yes' && pendingUninstall && teamId) {
        const active = this.#host.socket();
        await this.captureIcon(pendingUninstall.proposal_id, pendingUninstall.assistant.id, teamId);
        // The approval answers only the proposal it was given for, on the connection that proposed it: a Team change,
        // a reconnect, or an expiry while the icon was captured leaves nothing to approve.
        if (
          this.#host.teamId() !== teamId ||
          this.#host.socket() !== active ||
          !this.#proposed(pendingUninstall.proposal_id)
        ) return false;
      }
      return this.#host.submit(decision);
    } finally {
      this.decisionPending = false;
    }
  };
}
