<script>
  import { Button } from '@shimpz/frontend';

  let { label, deleteLabel, ondelete, routinesLabel = '', onroutines = null } = $props();

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let menu = $state();
  let firstItem = $state();
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
    queueMicrotask(() => {
      menu?.showPopover();
      place();
      firstItem?.focus();
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
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"></path></svg>
  </Button>
  <div bind:this={menu} id={menuId} class="content" role="menu" aria-label={label} popover="manual">
    {#if onroutines}
      <Button bind:element={firstItem} class="item" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(onroutines)}>
        {routinesLabel}
      </Button>
      <Button class="item danger" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(ondelete)}>
        {deleteLabel}
      </Button>
    {:else}
      <Button bind:element={firstItem} class="item danger" variant="ghost" size="sm" type="button" role="menuitem" onclick={() => choose(ondelete)}>
        {deleteLabel}
      </Button>
    {/if}
  </div>
</div>

<style>
  .team-actions { display: contents; }
  .team-actions :global(svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; }
  .content { position: fixed; z-index: 80; top: var(--menu-top); left: var(--menu-left); display: grid; min-width: 11rem; padding: var(--shimpz-space-1); margin: 0; color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); box-shadow: 0 1rem 3rem rgb(0 0 0 / 65%); }
  .content:not(:popover-open) { display: none; }
  .content :global(.item) { width: 100%; justify-content: flex-start; border: 0; background: transparent; clip-path: none; text-align: start; }
  .content :global(.item.danger) { color: var(--shimpz-color-danger); }
  .content :global(.item:hover) { background: var(--shimpz-color-surface-high); }
</style>
