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
