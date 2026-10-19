<script>
  import { tick } from 'svelte';
  import { Button } from '@shimpz/frontend';

  import { dismissOnEscape, dismissOutside, hidePanel, openPanel, placePanel } from '#lib/brain/panel.js';

  // One composer control: a bare icon that opens its dialog panel above it (panel.js). The panel's content is mounted
  // only while it is open; Escape closes it and returns focus to the icon, and a press outside closes it.
  let {
    // The icon's accessible name and title.
    label,
    // Whether the icon stays lit to show its setting is on.
    lit = false,
    disabled = false,
    busy = false,
    // The selector, inside the panel, of what takes focus as it opens.
    focusTarget,
    // Any value whose change can resize the content: the panel is placed again.
    content,
    // Called once the panel closed, to forget what only the open panel held.
    onclose = () => {},
    open = $bindable(false),
    panel = $bindable(),
    icon,
    children,
  } = $props();

  let root = $state();
  let trigger = $state();
  const panelId = $props.id();

  $effect(() => {
    if (disabled && open) close();
  });

  $effect(() => {
    void content;
    if (open) void tick().then(() => { if (open) placePanel(trigger, panel); });
  });

  function close(restore = false) {
    hidePanel(panel);
    open = false;
    onclose();
    if (restore) queueMicrotask(() => trigger?.focus());
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (disabled) return;
    open = true;
    openPanel(trigger, panel, () => panel?.querySelector(focusTarget));
  }
</script>

<svelte:window
  onkeydown={(event) => dismissOnEscape(event, open, close)}
  onresize={() => { if (open) placePanel(trigger, panel); }}
/>
<svelte:document onpointerdown={(event) => dismissOutside(event, open, root, close)} />

<div bind:this={root} class="composer-panel">
  <Button
    bind:element={trigger}
    class={['composer-trigger', lit && 'is-on']}
    variant="ghost"
    size="sm"
    iconOnly
    type="button"
    aria-label={label}
    title={label}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={panelId}
    disabled={disabled && !open}
    onclick={toggle}
  >
    {@render icon()}
  </Button>
  <div
    bind:this={panel}
    id={panelId}
    class="panel admin-overlay"
    role="dialog"
    aria-labelledby={`${panelId}-title`}
    aria-busy={busy}
    popover="manual"
  >
    {#if open}
      {@render children(panelId)}
    {/if}
  </div>
</div>

<style>
  .composer-panel { display: contents; }
  .composer-panel :global(.shimpz-button.composer-trigger),
  .composer-panel :global(.shimpz-button.composer-trigger:hover:not(:disabled)) { width: 2.25rem; height: 2.25rem; padding: 0; color: var(--shimpz-color-text-dim); border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .composer-panel :global(.shimpz-button.composer-trigger:hover:not(:disabled)),
  .composer-panel :global(.composer-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  /* A setting that is on keeps its icon lit, so the chat shows it without opening anything. */
  .composer-panel :global(.shimpz-button.composer-trigger.is-on) { color: var(--shimpz-color-cyan); filter: drop-shadow(0 0 0.35rem rgb(0 240 255 / 55%)); }
  .composer-panel :global(.composer-trigger svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .panel {
    position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(21rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 1rem); overflow-y: auto;
    gap: var(--gap-group); margin: 0; padding: var(--gap-panel); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border); clip-path: var(--shimpz-control-shape); box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .panel :global(.title) { margin: 0; color: var(--shimpz-color-text); font: 700 0.66rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .panel :global(:is(.summary, .status, .error)) { margin: 0; line-height: 1.5; }
  .panel :global(.summary) { color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  .panel :global(.status) { color: var(--shimpz-color-cyan); font: 400 0.74rem/1.4 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; }
  .panel :global(.error) { color: var(--shimpz-color-danger); font-size: 0.74rem; }
  @media (prefers-reduced-motion: reduce) {
    .composer-panel :global(svg) { animation: none !important; }
  }
</style>
