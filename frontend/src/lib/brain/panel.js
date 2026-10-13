// Composer control panels open above their trigger, clamped inside the viewport, and below it only when there is no
// room above. Each panel reads the result from its --panel-left and --panel-top properties.
export function placePanel(trigger, panel) {
  if (!trigger || !panel) return;
  const box = trigger.getBoundingClientRect();
  const size = panel.getBoundingClientRect();
  const rtl = getComputedStyle(trigger).direction === 'rtl';
  const preferred = rtl ? box.right - size.width : box.left;
  const left = Math.max(8, Math.min(preferred, window.innerWidth - size.width - 8));
  const above = box.top - size.height - 6;
  const top = above >= 8 ? above : Math.min(box.bottom + 6, window.innerHeight - size.height - 8);
  panel.style.setProperty('--panel-left', `${left}px`);
  panel.style.setProperty('--panel-top', `${Math.max(8, top)}px`);
}

// Each composer panel is a manual popover. It opens beside its trigger and, once shown, focuses what `focusTarget`
// returns; Escape closes it and returns focus to the trigger, and a press outside its root closes it.
export function openPanel(trigger, panel, focusTarget) {
  queueMicrotask(() => {
    panel?.showPopover();
    placePanel(trigger, panel);
    focusTarget()?.focus();
  });
}

export function hidePanel(panel) {
  if (panel?.matches(':popover-open')) panel.hidePopover();
}

export function dismissOnEscape(event, open, close) {
  if (open && event.key === 'Escape') {
    event.preventDefault();
    close(true);
  }
}

export function dismissOutside(event, open, root, close) {
  if (open && event.target instanceof Node && !root?.contains(event.target)) close();
}
