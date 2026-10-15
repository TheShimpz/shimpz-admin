import { tick } from 'svelte';

import { needsPage } from './protocol.js';
import { visibleSteps } from './reading.js';

/** How many steps of a Routine list one press reveals. */
export const PAGE_SIZE = 10;

/**
 * A Routine list read page by page and revealed PAGE_SIZE steps at a time: the steps loaded so far, where the next
 * page starts, how many pages are revealed, and whether a read is going or failed. Only the newest read applies: a
 * reset makes every read already going stale, so its pages and its failure are dropped.
 */
export class PagedSteps {
  steps = $state([]);
  next = $state(0);
  pages = $state(1);
  loading = $state(false);
  failed = $state(false);
  shown = $derived(visibleSteps(this.steps, this.pages, PAGE_SIZE));
  #reading = 0;

  /** Start again from the first page, revealing one page; every read already going is stale. */
  reset() {
    this.#reading += 1;
    this.restart();
    this.pages = 1;
    this.failed = false;
  }

  /** Drop the steps read so far, so the next page read starts from the first. */
  restart() {
    this.steps = [];
    this.next = 0;
  }

  /** Whether a read that began with `ticket` is still the newest. */
  current(ticket) {
    return ticket === this.#reading;
  }

  /**
   * Read pages until `wanted` steps are loaded or the list has no more. `read(ticket)` answers the page that starts at
   * `next`; `onPage` hears each page the newest read applied, and `onError` the failure of the newest read.
   */
  async load(wanted, read, { onPage = () => {}, onError }) {
    const ticket = this.#reading;
    this.loading = true;
    try {
      while (this.current(ticket) && needsPage(this.steps.length, wanted, this.next)) {
        const page = await read(ticket);
        if (!this.current(ticket)) return;
        this.steps = [...this.steps, ...page.steps];
        this.next = page.next;
        onPage(page);
      }
    } catch (error) {
      if (this.current(ticket)) onError(error);
    } finally {
      if (this.current(ticket)) this.loading = false;
    }
  }

  /** Reveal one more page, reading what it needs with `load(wanted)`, then focus the first step revealed in `list`. */
  async more(list, load) {
    const first = this.shown.length;
    this.pages += 1;
    await load(this.pages * PAGE_SIZE);
    await tick();
    list?.querySelectorAll(':scope > li')[first]?.focus();
  }
}
