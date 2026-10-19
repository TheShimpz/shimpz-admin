// The open Team's transcript (ADR-0114): its turns, each with a render identity it keeps, and the history behind them.
// Opening a Team follows its history head (`chatHistory`) and its Routines: the history is first read once its
// subscription is in place, so a Routine notice written meanwhile is never missed. The session keeps the head, so a
// conversation shown before opens at once; the chat connects only once the head says it is current, and until then
// every value the head reads replaces the conversation, so nothing the channel restores is ever laid on a conversation
// older than Admin's. Earlier pages load on request, in front of what is shown, without moving the reader.
import { tick } from 'svelte';
import { showTeamRoutines } from '#lib/routines/context.js';
import { call } from '#lib/session/socket.js';
import { chatHistory, listChatHistory, newerRoutineEntries, withArrived } from './history.js';
import { historyTurn } from './turns.js';

// A reader at most this far from the end follows a new row.
const FOLLOW_SLACK = 48;

export class Transcript {
  // Every change replaces the list or the turn it changes, never a field in place, so no turn needs a deep proxy.
  turns = $state.raw([]);
  // The cursor to the history before the first turn, or null once there is none.
  before = $state(null);
  // Whether the Team's history has not opened the conversation yet.
  loading = $state(true);
  // A conversation the session kept shows at once, readable, while the head checks it is still current: the chat
  // connects, and the composer opens, only after that.
  checking = $state(false);
  // Whether an earlier page is being read.
  working = $state(false);
  // Earlier history loads when the top of the transcript is in view, only after the opening scroll has settled.
  olderArmed = $state(false);
  olderFailed = $state(false);
  // How many head values wait for the conversation to be idle.
  waiting = $state(0);
  // The scrolling transcript element.
  viewport = $state();
  #nextKey = 0;
  #generation = 0;
  #scrollRequest = 0;
  #queue = [];
  #applying = false;
  #stopTopics = () => {};
  #resync = () => {};
  #host;

  /**
   * `host` is the page: the Team it shows (`teamId()`), whether it is mounted (`mounted()`), a listed Team by id
   * (`team(id)`), its transcript words (`words()`), its error notice (`error()`, `setError`, `clearError`, and the
   * history's own failure `loadFailed()`), and `connect(teamId)`, which attaches the Team's chat channel.
   */
  constructor(host) {
    this.#host = host;
  }

  /** The render identity the next turn takes. */
  get nextKey() {
    return this.#nextKey;
  }

  /** Adds one turn at the end, with the next render identity. */
  append(turn) {
    this.turns = [...this.turns, { renderKey: this.#nextKey++, ...turn }];
  }

  /** Replaces the turns with those `make(key)` returns; a turn it adds takes the next render identity, `key`. */
  extend(make) {
    const next = make(this.#nextKey);
    if (next.length > this.turns.length) this.#nextKey += 1;
    this.turns = next;
  }

  /** Shows the newest exchange from its start, at once or with the reader's motion preference. */
  async reveal({ instant = false } = {}) {
    const request = ++this.#scrollRequest;
    await tick();
    if (request !== this.#scrollRequest || !this.viewport) return;
    const latest = this.viewport.querySelector('.exchange:last-of-type');
    if (!latest) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    latest.scrollIntoView({
      block: 'start',
      behavior: instant || reducedMotion ? 'auto' : 'smooth',
    });
  }

  /** Opens `teamId`'s conversation, or none, and follows its history and Routines. */
  open(teamId) {
    this.turns = [];
    this.before = null;
    this.working = false;
    this.olderArmed = false;
    this.olderFailed = false;
    this.loading = Boolean(teamId);
    this.#scrollRequest += 1;
    this.#watch(teamId, ++this.#generation);
  }

  /** Shows the conversation as a reload would, when this page missed how a turn ended (ADR-0119). */
  resync() {
    this.#resync();
  }

  /** A message last in the history that a running turn of its Team now answers is no longer unfinished. */
  clearUnfinished() {
    if (this.turns.some((turn) => turn.unfinished)) {
      this.turns = this.turns.map(({ unfinished: _unfinished, ...turn }) => turn);
    }
  }

  /** The page left: nothing it followed answers any more. */
  close() {
    this.#generation += 1;
    this.#stopTopics();
  }

  // History rows as new turns, each with the next render identity unless `keys` holds the one its row already has. A
  // message last in the history has no ending yet: it ended while Admin restarted, or its turn still runs, which the
  // chat then says (ADR-0119).
  #fresh(entries, team, keys = new Map()) {
    const turns = entries.map((entry) => historyTurn(entry, team.name, keys.get(entry.id) ?? this.#nextKey++, this.#host.words()));
    const last = turns.at(-1);
    if (last?.role === 'user') turns[turns.length - 1] = { ...last, unfinished: true };
    return turns;
  }

  // The turns of history rows, keeping the render identity of a row already shown.
  #kept(entries, team) {
    return this.#fresh(entries, team, new Map(
      this.turns.filter((turn) => turn.historyId).map((turn) => [turn.historyId, turn.renderKey]),
    ));
  }

  // Whether the reader is at the end of the transcript, so a new row keeps them there.
  #atEnd() {
    const viewport = this.viewport;
    return Boolean(viewport) && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_SLACK;
  }

  #reportFailure(reason) {
    const loadFailed = this.#host.loadFailed();
    this.#host.setError(loadFailed, reason instanceof Error ? reason.message : loadFailed);
  }

  #clearFailure() {
    if (this.#host.error() === this.#host.loadFailed()) this.#host.clearError();
  }

  // The Team's conversation as its head holds it (`view`, as a reload would open it) opens the transcript. A history
  // that could not be read says why and the chat connects without it; once the head reads it after all, the
  // conversation opens from it.
  async #hydrate(teamId, generation, view, connect) {
    try {
      const team = this.#host.team(teamId);
      if (!team) throw new Error(this.#host.loadFailed());
      this.turns = this.#kept(view.entries, team);
      this.before = view.before;
      this.loading = false;
      if (this.turns.length > 0) await this.reveal({ instant: true });
      return true;
    } catch (reason) {
      this.#fail(teamId, generation, reason, connect);
      return false;
    }
  }

  #fail(teamId, generation, reason, connect) {
    if (generation !== this.#generation || this.#host.teamId() !== teamId) return;
    this.loading = false;
    this.#reportFailure(reason);
    connect();
  }

  /** Reads the page before the first turn and shows it in front, leaving the reader where they are. */
  async loadOlder() {
    const teamId = this.#host.teamId();
    const before = this.before;
    if (!teamId || !before || this.working) return;
    this.working = true;
    const generation = this.#generation;
    const current = () => generation === this.#generation && this.#host.teamId() === teamId;
    try {
      const page = await listChatHistory(call, teamId, before);
      if (!current()) return;
      // An older page must move the cursor, or automatic loading would request the same page forever.
      if (page.before === before || (page.entries.length === 0 && page.before !== null)) {
        throw new Error(this.#host.loadFailed());
      }
      const known = new Set(this.turns.map((turn) => turn.historyId).filter(Boolean));
      if (page.entries.some((entry) => known.has(entry.id))) throw new Error(this.#host.loadFailed());
      const team = this.#host.team(teamId);
      if (!team) throw new Error(this.#host.loadFailed());
      // Measure where the reader is now, not when the request started, so prepending never moves their view.
      const viewport = this.viewport;
      const previousHeight = viewport?.scrollHeight ?? 0;
      const previousTop = viewport?.scrollTop ?? 0;
      this.turns = [...this.#fresh(page.entries, team), ...this.turns];
      this.before = page.before;
      // The loading status leaves in the same update, so the correction measures the layout the reader will see.
      this.working = false;
      await tick();
      if (viewport && viewport === this.viewport) {
        viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
      }
      // Only an earlier page's own failure ends with it; any other error on screen stays.
      this.#clearFailure();
    } catch (reason) {
      if (current()) {
        this.olderFailed = true;
        this.#reportFailure(reason);
      }
    } finally {
      if (current()) this.working = false;
    }
  }

  /** Reads the earlier page again after its failure; settles once that read did. */
  retryOlder() {
    this.olderFailed = false;
    return this.loadOlder();
  }

  // Admin delivers Routine notices on its own schedule (ADR-0086) and says so on the session socket (ADR-0114): while a
  // Local Team's conversation is open, its history head (`historyHead`) reads the history written since it last read,
  // and the Team's Routines follow their own topic. The chat's view of the history holds, of the Routine notices, only
  // each Routine's creation; its runs are its own history, which its panel reads. Only Routine rows merge into the
  // transcript, by identity and version: a new row, or a newer version of a shown one, moves to the end as a reload
  // would show it. The rest of the conversation, the draft, and the reader's place stay as they are; a reader already at
  // the end follows the new row. When more was written than one refresh reads, the transcript starts again from what it
  // read, as a reload shows it, and earlier history continues from where the refresh stopped.
  async #apply(teamId, value) {
    const team = this.#host.team(teamId);
    if (!team) return;
    if (value.restart) {
      this.turns = this.#fresh(value.entries, team);
      this.before = value.before;
      await this.reveal({ instant: true });
      return;
    }
    const shown = new Map(this.turns.filter((turn) => turn.routineRun || turn.routineAnswer).map((turn) => [
      turn.historyId, turn.routineRun?.version ?? 0,
    ]));
    const arrived = newerRoutineEntries(shown, value.entries);
    if (arrived.length === 0) return;
    const following = this.#atEnd();
    this.turns = withArrived(this.turns, this.#fresh(arrived, team), (turn) => turn.historyId);
    if (following) await this.reveal();
  }

  /**
   * Applies, in order, what the head read while a turn or history was in motion, as long as `idle()` says the
   * conversation of `teamId` is idle.
   */
  async drain(teamId, idle) {
    if (this.#applying) return;
    this.#applying = true;
    try {
      while (this.#queue.length && idle()) {
        const value = this.#queue.shift();
        this.waiting = this.#queue.length;
        await this.#apply(teamId, value);
      }
    } finally {
      this.#applying = false;
    }
  }

  #watch(teamId, generation) {
    this.#stopTopics();
    this.#stopTopics = () => {};
    this.#queue = [];
    this.waiting = 0;
    this.checking = false;
    if (!teamId) return;
    // The chat connects once, after the history opened the conversation or failed to.
    let connected = false;
    const connect = () => {
      if (connected || generation !== this.#generation) return;
      connected = true;
      this.#host.connect(teamId);
    };
    const head = chatHistory(teamId);
    // A turn ended unseen: the newest page replaces what is shown, as a reload would.
    this.#resync = () => {
      if (generation === this.#generation) void head.restart();
    };
    const watching = () => generation === this.#generation && this.#host.mounted() && this.#host.teamId() === teamId;
    let hydrated = false;
    let failed = false;
    let applied = null;
    let latest = null;
    let refusal = null;

    // Whether the head's value can open the conversation: one that outgrew what a session keeps is read again from its
    // newest page first.
    function opens(value) {
      if (value.view) return true;
      void head.restart();
      return false;
    }

    const settle = async (opened) => {
      for (;;) {
        const outcome = await head.current();
        if (!watching()) return;
        if (outcome === 'refused') {
          // As when the history could not be read at all: nothing of the kept conversation stays, and the chat
          // connects without it; a later read opens the conversation.
          this.turns = [];
          this.before = null;
          hydrated = false;
          failed = true;
          this.checking = false;
          this.loading = false;
          this.#fail(teamId, generation, refusal ?? new Error(this.#host.loadFailed()), connect);
          return;
        }
        if (outcome === 'current' && latest?.view) break;
        if (outcome === 'current') opens(latest);
      }
      const ok = await opened;
      if (!watching()) return;
      this.checking = false;
      if (!ok) return;
      this.#clearFailure();
      this.olderArmed = true;
      connect();
    };

    const stopHead = head.subscribe((state) => {
      if (generation !== this.#generation) return;
      if (state.status === 'error') refusal = state.error;
      if (state.status !== 'ready' || state.value === applied) {
        if (state.status === 'error' || state.failing) {
          // A history never read says why and the chat connects without it; a kept one being read again waits for the
          // read, unless Admin refuses it.
          if (!hydrated && !failed && (!this.checking || state.status === 'error')) {
            failed = true;
            this.checking = false;
            this.#fail(teamId, generation, state.error ?? state.failing, connect);
          } else if (this.checking) {
            // The kept conversation stays readable while it is read again; the chat waits for the read.
            const loadFailed = this.#host.loadFailed();
            this.#host.setError(loadFailed, (state.error ?? state.failing)?.message ?? loadFailed);
          }
        }
        return;
      }
      applied = state.value;
      latest = state.value;
      if (!hydrated) {
        if (!opens(state.value)) {
          // A kept conversation that outgrew what a session keeps: the chat waits for its newest page.
          if (!connected) this.checking = true;
          return;
        }
        hydrated = true;
        const opened = this.#hydrate(teamId, generation, state.value.view, connect);
        // A conversation opened after the chat already connected without it (its history failed at first) is shown as
        // it is; otherwise the chat connects once it is current.
        if (connected) {
          void opened.then((ok) => {
            if (!ok || !watching()) return;
            this.#clearFailure();
            this.olderArmed = true;
          });
          return;
        }
        this.checking = true;
        void settle(opened);
        return;
      }
      if (this.checking) {
        const team = this.#host.team(teamId);
        if (!team || !opens(state.value)) return;
        const following = this.#atEnd();
        this.turns = this.#kept(state.value.view.entries, team);
        this.before = state.value.view.before;
        if (following) void this.reveal({ instant: true });
        return;
      }
      this.#queue.push(state.value);
      this.waiting = this.#queue.length;
    });
    const stopRoutines = showTeamRoutines(teamId);
    this.#stopTopics = () => {
      stopHead();
      stopRoutines();
    };
  }
}
