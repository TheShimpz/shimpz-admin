import { createExecutionProjection, extendExecutionProjection } from './progress/projection.js';

/**
 * The chat turn on one Team's channel as the page observes it: whether a turn runs (`busy`), Admin synchronizes the Team
 * (`syncing`), or a Stop waits for its answer (`stopping`); when the turn started; Team's progress of its current
 * segment, and of the earlier segments each human or Integration pause ended, which together make the turn's receipt;
 * and the Assistants its continuing install plan proved running. A frame the turn does not admit throws, and the page
 * then fails the channel as a protocol violation.
 */
export class ChatTurn {
  busy = $state(false);
  syncing = $state(false);
  stopping = $state(false);
  // When the turn in flight started, as this page observed it: its thinking view counts from here, also after a human
  // or Integration request hid it for a while.
  startedAt = $state(0);
  // The current segment's progress: its events in sequence and their projection.
  events = $state([]);
  projection = $state(createExecutionProjection());
  sequence = 0;
  // Each event of an earlier segment carries its segment, as every segment restarts its seq.
  #earlier = [];
  #segment = 0;
  // A just-in-time request may reach the browser, or be redelivered after a same-Team reconnect, before the
  // asynchronous Team inventory refresh lists an Assistant the turn's install plan proved running. Cleared at every
  // terminal result, empty sync, protocol error, new message, and Team change.
  #installed = { teamId: '', ids: new Set() };
  // Advances at every turn boundary so an inventory-dependent admission started in an older turn is discarded.
  epoch = 0;

  begin() {
    if (!this.busy) this.startedAt = Date.now();
    this.busy = true;
  }

  /** No turn runs, synchronizes, or stops any more. */
  settle() {
    this.busy = false;
    this.syncing = false;
    this.stopping = false;
  }

  /**
   * A human or Integration request pauses the turn: it keeps running, and the progress of the segment it ended joins
   * the earlier segments.
   */
  pause() {
    this.begin();
    this.syncing = false;
    this.stopping = false;
    for (const event of this.events) {
      if (event.origin === 'team') this.#earlier.push({ ...event, segment: this.#segment });
    }
    this.#segment += 1;
    this.resetProgress();
  }

  /** One progress frame, admitted only in sequence while a turn runs or the Team synchronizes. */
  progress(frame) {
    if (!this.busy && !this.syncing) throw new Error('unexpected progress frame');
    if (frame.seq !== this.sequence + 1) throw new Error('out-of-order progress frame');
    if (this.syncing) this.begin();
    this.sequence = frame.seq;
    this.events.push(frame);
    extendExecutionProjection(this.projection, frame);
  }

  /** Admits a frame of the running turn, never of a synchronization. */
  requireRunning(what) {
    if (!this.busy || this.syncing) throw new Error(`unexpected ${what}`);
  }

  /** Admits a terminal frame only while a turn runs, stops, or synchronizes. */
  requireTerminal() {
    if (!this.busy && !this.stopping && !this.syncing) throw new Error('unexpected terminal frame');
  }

  /** Every step the turn observed, in segment order; the segments are then forgotten. */
  receipt() {
    const receipt = [...this.#earlier, ...this.events.map((event) => ({ ...event, segment: this.#segment }))];
    this.forgetSegments();
    return receipt;
  }

  forgetSegments() {
    this.#earlier = [];
    this.#segment = 0;
  }

  resetProgress() {
    this.events = [];
    this.projection = createExecutionProjection();
    this.sequence = 0;
  }

  /** Records Assistants the turn's install plan proved running in one Team. */
  addInstalled(teamId, assistantIds) {
    const ids = this.#installed.teamId === teamId ? this.#installed.ids : new Set();
    for (const id of assistantIds) ids.add(id);
    this.#installed = { teamId, ids };
  }

  installedIn(teamId, assistantId) {
    return this.#installed.teamId === teamId && this.#installed.ids.has(assistantId);
  }

  clearInstalled() {
    this.#installed = { teamId: '', ids: new Set() };
    this.epoch += 1;
  }
}
