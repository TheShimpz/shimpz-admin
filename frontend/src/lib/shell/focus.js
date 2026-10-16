import { tick } from 'svelte';

// Keyboard focus never silently drops to the document. A control a request disables (a busy flag) loses the focus to
// the body, and nothing gives it back by itself. Two tools cover that, after React Aria's FocusScope (`restoreFocus`,
// which keeps the element last focused inside a scope) and Radix's FocusScope (which takes focus back when the browser
// drops it to the body):
// - `recoverFocus`, an attachment on a dialog or panel, returns the focus to the element that last held it inside the
//   scope once it can take focus again (`focus()` does nothing while it is disabled, inert, hidden, or detached). It
//   waits through any number of renders while the request runs, and gives up once the person moves the focus anywhere,
//   presses outside that element, or the element leaves the scope. Only the innermost scope around the element
//   recovers.
// - `regainFocus` gives the focus to an explicit target once the pending render is done, where the outcome decides
//   another place (the field a refusal names, the control that replaces the one pressed). Given the `focusMark` taken
//   when its request began, it gives up once the person moved the focus or pressed elsewhere since, even when that
//   left the focus on the document. It runs before `recoverFocus`, which acts a frame later and so finds the focus
//   already placed.

/**
 * Whether focus has fallen to the document: nothing, or the body, holds it, or what holds it is no longer rendered
 * (Firefox and WebKit leave it on a control of a dialog that closed until a later render).
 */
export function focusLost() {
  const focused = document.activeElement;
  return !focused || focused === document.body || !focused.checkVisibility();
}

const scopes = new Set();
// The element that last took focus and the innermost scope around it, or null once focus went outside every scope.
let held = null;
// How many times focus moved or the person pressed away from the focused element.
let moves = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('focusin', track, true);
  document.addEventListener('pointerdown', press, true);
}

/** A mark of the focus moves so far, taken when a request begins, for its `regainFocus`. */
export function focusMark() {
  listen();
  return moves;
}

/**
 * Once the pending render is done, focuses `target()` when focus has fallen to the document, `shown()` still holds,
 * and focus never moved since `since` (a `focusMark`); focus the person placed or pressed anywhere stays where it is.
 */
export async function regainFocus(target, { shown = () => true, since = focusMark(), ...options } = {}) {
  await tick();
  if (moves === since && focusLost() && shown()) target()?.focus(options);
}

// The window taking the focus back (after a passkey prompt, say) focuses the body again: that is nobody's move.
function track(event) {
  if (event.target === document.body) return;
  moves += 1;
  let scope = null;
  for (const candidate of scopes) {
    if (candidate.contains(event.target) && (!scope || scope.contains(candidate))) scope = candidate;
  }
  held = scope ? { scope, element: event.target } : null;
}

// A press anywhere but on the focused element is the person's own move, also onto blank space that leaves the focus on
// the document.
function press(event) {
  if (focusLost() || !document.activeElement.contains(event.target)) moves += 1;
  if (held && !held.element.contains(event.target)) held = null;
}

/** Attachment: within `node`, the element that last held the focus takes it back from the document once usable. */
export function recoverFocus(node) {
  listen();
  scopes.add(node);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (held?.scope !== node || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const element = held?.scope === node ? held.element : null;
      if (element && focusLost() && node.contains(element)) element.focus();
    });
  });
  observer.observe(node, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'inert'],
  });
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    scopes.delete(node);
    if (held?.scope === node) held = null;
  };
}
