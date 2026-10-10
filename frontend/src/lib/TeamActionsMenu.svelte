<script>
  import { Button } from '@shimpz/frontend';

  let {
    label,
    deleteLabel,
    ondelete,
    renameLabel = '',
    onrename = null,
    routinesLabel = '',
    onroutines = null,
    // Reordering (Local only): each move is offered when its handler is set and disabled at the list's boundary.
    moveUpLabel = '',
    onmoveup = null,
    moveDownLabel = '',
    onmovedown = null,
    first = false,
    last = false,
    // The Team's Action confirmation setting (ADR-0112), read each time the menu opens: `load()` resolves to the current
    // value and `save(value)` to the value Team saved; either rejects when it could not.
    confirmLabel = '',
    confirmation = null,
  } = $props();

  // Unknown until read; `busy` while a read or a change is in flight.
  let confirmMutating = $state(null);
  let confirmBusy = $state(false);
  let confirmTicket = 0;

  async function readConfirmation() {
    const ticket = ++confirmTicket;
    confirmBusy = true;
    try {
      const value = await confirmation.load();
      if (ticket === confirmTicket) confirmMutating = value;
    } catch {
      if (ticket === confirmTicket) confirmMutating = null;
    } finally {
      if (ticket === confirmTicket) confirmBusy = false;
    }
  }

  async function toggleConfirmation() {
    if (confirmBusy || confirmMutating === null) return;
    const ticket = ++confirmTicket;
    confirmBusy = true;
    try {
      const value = await confirmation.save(!confirmMutating);
      if (ticket === confirmTicket) confirmMutating = value;
    } catch {
      // The setting Team holds is unchanged; the caller reports the failure.
    } finally {
      if (ticket === confirmTicket) confirmBusy = false;
    }
  }

  // A disabled item cannot take focus, so keyboard movement skips it.
  const ITEMS = '[role^="menuitem"]:not(:disabled)';

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let menu = $state();
  const menuId = $props.id();

  function close(restore = false) {
    if (menu?.matches(':popover-open')) menu.hidePopover();
    open = false;
    if (restore) queueMicrotask(() => trigger?.focus());
  }

  function place() {
    if (!trigger || !menu) return;
    const box = trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const rtl = getComputedStyle(trigger).direction === 'rtl';
    const preferred = rtl ? box.left : box.right - size.width;
    const left = Math.max(8, Math.min(preferred, window.innerWidth - size.width - 8));
    const below = box.bottom + 4;
    const top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, box.top - size.height - 4);
    menu.style.setProperty('--menu-left', `${left}px`);
    menu.style.setProperty('--menu-top', `${top}px`);
  }

  function toggle(event) {
    event.preventDefault();
    if (open) {
      close();
      return;
    }
    open = true;
    if (confirmation) void readConfirmation();
    queueMicrotask(() => {
      menu?.showPopover();
      place();
      menu?.querySelector(ITEMS)?.focus();
    });
  }

  function choose(action) {
    close();
    action();
  }

  function keydown(event) {
    if (!open || (event.key !== 'Escape' && event.key !== 'Tab')) return;
    // Escape closes only this menu, never an enclosing dialog such as the mobile Team drawer.
    if (event.key === 'Escape') event.preventDefault();
    close(event.key === 'Escape');
  }

  // Arrow keys, Home, and End move between the menu items, so every item is reachable from the keyboard.
  function menuKeydown(event) {
    const items = [...(menu?.querySelectorAll(ITEMS) ?? [])];
    const index = items.indexOf(document.activeElement);
    const last = items.length - 1;
    const next = {
      ArrowDown: index < last ? index + 1 : 0,
      ArrowUp: index > 0 ? index - 1 : last,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined || last < 0) return;
    event.preventDefault();
    items[next].focus();
  }

  function outsidePointerdown(event) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) close();
  }
</script>

<svelte:window onkeydown={keydown} onresize={() => { if (open) place(); }} />
<svelte:document onpointerdown={outsidePointerdown} />

<div bind:this={root} class="team-actions">
  <Button
    bind:element={trigger}
    variant="ghost"
    size="sm"
    iconOnly
    type="button"
    aria-label={label}
    title={label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={menuId}
    onclick={toggle}
  >
    <!-- The Button glitches by itself; `glitch-icon` lets the Team row it sits in glitch it on row hover too. -->
    <svg class="glitch-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"></path></svg>
  </Button>
  <div bind:this={menu} id={menuId} class="content" role="menu" aria-label={label} tabindex="-1" popover="manual" onkeydown={menuKeydown}>
    {#if onrename}
      <Button class="item" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(onrename)}>
        <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
        {renameLabel}
      </Button>
    {/if}
    {#if onroutines}
      <Button class="item" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(onroutines)}>
        <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
        {routinesLabel}
      </Button>
    {/if}
    {#if onmoveup && onmovedown}
      <Button class="item" variant="ghost" size="sm" type="button" role="menuitem" disabled={first} onclick={() => choose(onmoveup)}>
        <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg>
        {moveUpLabel}
      </Button>
      <Button class="item" variant="ghost" size="sm" type="button" role="menuitem" disabled={last} onclick={() => choose(onmovedown)}>
        <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="m19 12-7 7-7-7"></path></svg>
        {moveDownLabel}
      </Button>
    {/if}
    {#if confirmation}
      <!-- A checkbox item keeps the menu open, so its new state is read where it was changed. -->
      <Button class="item" variant="ghost" size="sm" type="button" role="menuitemcheckbox"
        aria-checked={confirmMutating === true} disabled={confirmBusy || confirmMutating === null}
        onclick={toggleConfirmation}>
        <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2"></rect>
          {#if confirmMutating}<path d="m8 12 3 3 5-6"></path>{/if}
        </svg>
        {confirmLabel}
      </Button>
    {/if}
    <Button class="item danger" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(ondelete)}>
      <svg class="item-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
      {deleteLabel}
    </Button>
  </div>
</div>

<style>
  .team-actions { display: contents; }
  .team-actions :global(svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; }
  .content { position: fixed; z-index: 80; top: var(--menu-top); left: var(--menu-left); display: grid; min-width: 11rem; padding: var(--gap-item); margin: 0; color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); box-shadow: 0 1rem 3rem rgb(0 0 0 / 65%); }
  .content:not(:popover-open) { display: none; }
  .content :global(.item) { width: 100%; justify-content: flex-start; gap: var(--gap-inside); border: 0; background: transparent; clip-path: none; font-size: 0.7rem; text-align: start; }
  .content :global(.item-icon) { flex: none; width: 0.95rem; height: 0.95rem; stroke-width: 2; stroke-linejoin: round; }
  .content :global(.item.danger) { color: var(--shimpz-color-danger); }
  .content :global(.item:hover:not(:disabled)) { background: var(--shimpz-color-surface-high); }
  .content :global(.item:disabled) { color: var(--shimpz-color-text-dim); cursor: default; opacity: 0.55; }
</style>
