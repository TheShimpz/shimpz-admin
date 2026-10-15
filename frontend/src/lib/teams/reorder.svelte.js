// A mouse or pen drags a Team by its name; touch never does, so the list keeps scrolling and the name keeps opening
// the Team. A press that never moves stays a click. A drag starts after a short movement, follows the pointer, and
// drops between rows. The name keeps the default touch-action, which also governs a pen: where a stylus pans, the
// pan cancels the drag and nothing is saved.
const DRAG_THRESHOLD = 6;
const SCROLL_EDGE = 48;

function scrollParent(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/u.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

// A drag never doubles as a click on whatever sits under the pointer when it ends.
function suppressNextClick() {
  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

/**
 * One Team list's pointer reordering: the Team dragged (`dragId`), how far it moved (`offset`), and the row it would
 * drop beside (`target`). `list()` is the list element, `ids()` the Team ids in their order, `canStart()` whether a drag
 * may start now, and `drop(ids, team)` saves a new order. A cancelled pointer, a lost capture, or Escape drops nothing:
 * the order never changes during the drag.
 */
export class TeamDrag {
  dragId = $state('');
  offset = $state(0);
  #dropIndex = $state(-1);
  #gesture = null;
  // A drag cancelled by Escape still never ends in a click on the name it started from when the pointer is released.
  // The list watches for that release only while it exists.
  #watchedRelease = null;

  constructor({ list, ids, canStart, drop }) {
    this.list = list;
    this.ids = ids;
    this.canStart = canStart;
    this.drop = drop;
  }

  // The drop slot among the other rows, and whether it actually changes the order.
  target = $derived.by(() => {
    if (!this.dragId || this.#dropIndex < 0) return null;
    const ids = this.ids();
    if (ids.indexOf(this.dragId) === this.#dropIndex) return null;
    const others = ids.filter((id) => id !== this.dragId);
    return this.#dropIndex < others.length
      ? { id: others[this.#dropIndex], side: 'before' }
      : { id: others.at(-1), side: 'after' };
  });

  down(event, team) {
    if (!this.canStart() || this.#gesture || !event.isPrimary || event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const source = event.currentTarget;
    source.setPointerCapture?.(event.pointerId);
    const scroller = scrollParent(this.list());
    this.#gesture = {
      team,
      source,
      pointerId: event.pointerId,
      startY: event.clientY,
      y: event.clientY,
      scroller,
      startScroll: scroller?.scrollTop ?? 0,
      active: false,
      frame: 0,
    };
  }

  move = (event) => {
    const gesture = this.#gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.y = event.clientY;
    if (!gesture.active) {
      if (Math.abs(gesture.y - gesture.startY) < DRAG_THRESHOLD) return;
      gesture.active = true;
      this.dragId = gesture.team.id;
      gesture.frame = requestAnimationFrame(this.#autoScroll);
    }
    event.preventDefault();
    this.#track();
  };

  up = (event) => {
    if (!this.#gesture || event.pointerId !== this.#gesture.pointerId) return;
    const ended = this.#end();
    if (!ended.moved) return;
    suppressNextClick();
    const ids = this.ids().filter((id) => id !== ended.team.id);
    if (ended.dropIndex < 0 || this.ids().indexOf(ended.team.id) === ended.dropIndex) return;
    ids.splice(ended.dropIndex, 0, ended.team.id);
    this.drop(ids, ended.team);
  };

  cancel = () => {
    this.#end();
  };

  lostCapture = (event) => {
    if (this.#gesture?.pointerId === event.pointerId) this.#end();
  };

  keydown = (event) => {
    if (event.key !== 'Escape' || !this.#gesture?.active) return;
    // Escape ends only the drag, never an enclosing dialog such as the mobile Team drawer.
    event.preventDefault();
    event.stopPropagation();
    const ended = this.#end();
    if (ended) this.#suppressClickOnRelease(ended.pointerId);
  };

  destroy() {
    this.#end();
    this.#stopWatchingRelease();
  }

  #track() {
    const gesture = this.#gesture;
    if (!gesture?.active) return;
    this.offset = gesture.y - gesture.startY + (gesture.scroller?.scrollTop ?? 0) - gesture.startScroll;
    let index = 0;
    for (const row of this.list()?.querySelectorAll(':scope > li') ?? []) {
      if (row.dataset.teamRow === gesture.team.id) continue;
      const box = row.querySelector('.row').getBoundingClientRect();
      if (gesture.y > box.top + box.height / 2) index += 1;
    }
    this.#dropIndex = index;
  }

  // Holding the pointer near the top or bottom edge of the scrolling list scrolls it, faster the closer it gets.
  #autoScroll = () => {
    const gesture = this.#gesture;
    if (!gesture?.active) return;
    // A name that left the page (its row was removed, or the layout swapped this navigation out) ends the drag, so
    // the loop never re-arms and never keeps a removed list or scroller alive.
    if (!gesture.source.isConnected) {
      this.#end();
      return;
    }
    const scroller = gesture.scroller;
    if (scroller) {
      const box = scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
      const top = Math.max(box.top, 0) + SCROLL_EDGE;
      const bottom = Math.min(box.bottom, window.innerHeight) - SCROLL_EDGE;
      const step = gesture.y < top ? -Math.ceil((top - gesture.y) / 4) : gesture.y > bottom ? Math.ceil((gesture.y - bottom) / 4) : 0;
      if (step) {
        scroller.scrollTop += step;
        this.#track();
      }
    }
    gesture.frame = requestAnimationFrame(this.#autoScroll);
  };

  #end() {
    const ended = this.#gesture;
    this.#gesture = null;
    if (!ended) return null;
    cancelAnimationFrame(ended.frame);
    if (ended.source.hasPointerCapture?.(ended.pointerId)) ended.source.releasePointerCapture(ended.pointerId);
    const result = { ...ended, dropIndex: this.#dropIndex, moved: ended.active };
    this.dragId = '';
    this.offset = 0;
    this.#dropIndex = -1;
    return result;
  }

  #stopWatchingRelease() {
    if (!this.#watchedRelease) return;
    window.removeEventListener('pointerup', this.#watchedRelease, { capture: true });
    window.removeEventListener('pointercancel', this.#watchedRelease, { capture: true });
    this.#watchedRelease = null;
  }

  #suppressClickOnRelease(pointerId) {
    this.#stopWatchingRelease();
    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      this.#stopWatchingRelease();
      if (event.type === 'pointerup') suppressNextClick();
    };
    this.#watchedRelease = release;
    window.addEventListener('pointerup', release, { capture: true });
    window.addEventListener('pointercancel', release, { capture: true });
  }
}
