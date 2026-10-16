import { tick } from 'svelte';

// Keyboard focus never silently drops to the document. A control a request disables (a busy flag) loses the focus to
// the body, and nothing gives it back by itself. Two tools cover that, after React Aria's FocusScope (`restoreFocus`,
// which keeps the element last focused inside a scope) and Radix's FocusScope (which takes focus back when the browser
// drops it to the body):
// - `recoverFocus`, an attachment on a dialog or panel, returns the focus to the element that last held it inside the
//   scope once that element is usable again: enabled, connected, shown, and not inert. It waits through any number of
//   renders while the request runs, and gives up once the person moves the focus anywhere, presses outside that
//   element, or the element leaves the scope. Only the innermost scope around the element recovers.
// - `regainFocus` gives the focus to an explicit target once the pending render is done, where the outcome decides
//   another place (the field a refusal names, the control that replaces the one pressed). It runs before
//   `recoverFocus`, which acts a frame later and so finds the focus already placed.

/** Whether focus has fallen to the document: nothing, or the body, holds it. */
export function focusLost() {
  const focused = document.activeElement;
  return !focused || focused === document.body;
}

/**
 * Once the pending render is done, focuses `target()` when focus has fallen to the document and `shown()` still holds;
 * focus the person placed anywhere stays where it is.
 */
export async function regainFocus(target, shown = () => true, options = undefined) {
  await tick();
  if (focusLost() && shown()) target()?.focus(options);
}

const scopes = new Set();
// The element that last took focus and the innermost scope around it, or null once focus went outside every scope.
let held = null;

function track(event) {
  let scope = null;
  for (const candidate of scopes) {
    if (candidate.contains(event.target) && (!scope || scope.contains(candidate))) scope = candidate;
  }
  held = scope ? { scope, element: event.target } : null;
}

// A press anywhere but on the focused element is the person's own move, also onto blank space that leaves the focus on
// the document.
function press(event) {
  if (held && !held.element.contains(event.target)) held = null;
}

function usable(element) {
  return (
    element.isConnected && !element.matches(':disabled') && !element.closest('[inert]') && element.checkVisibility()
  );
}

/** Attachment: within `node`, the element that last held the focus takes it back from the document once usable. */
export function recoverFocus(node) {
  if (scopes.size === 0) {
    document.addEventListener('focusin', track, true);
    document.addEventListener('pointerdown', press, true);
  }
  scopes.add(node);
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (held?.scope !== node || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const element = held?.scope === node ? held.element : null;
      if (element && focusLost() && node.contains(element) && usable(element)) element.focus();
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
    if (scopes.size === 0) {
      document.removeEventListener('focusin', track, true);
      document.removeEventListener('pointerdown', press, true);
    }
  };
}
