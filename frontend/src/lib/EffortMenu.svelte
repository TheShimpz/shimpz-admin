<script>
  import { Button } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';
  import { placePanel } from '$lib/composerPanel.js';
  import { t } from '$lib/i18n.js';
  import { modelContext, selectTeamEffort } from '$lib/modelContext.js';
  import { INFERENCE_EFFORTS } from '$lib/modelProviders.js';
  import { teamContext } from '$lib/teamContext.js';

  // The Team's reasoning effort (ADR-0074) in its own composer control: a slider of three radios, and a trigger
  // whose bars light up to the current level.
  let { disabled = false } = $props();

  let open = $state(false);
  let restoreFocus = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let stops = $state([]);
  const panelId = $props.id();

  let copy = $derived($t('brainMenu'));
  let busy = $derived(['idle', 'loading', 'saving'].includes($modelContext.phase));
  let unavailable = $derived(
    disabled || !$teamContext.selectedTeamId || $teamContext.phase === 'loading' || busy,
  );
  let effortIndex = $derived(Math.max(0, INFERENCE_EFFORTS.indexOf($modelContext.effort)));
  let triggerLabel = $derived(`${copy.effort}: ${copy.efforts[INFERENCE_EFFORTS[effortIndex]]}`);

  $effect(() => {
    if (disabled && open) close();
  });

  // Escape returns focus to the trigger, which stays disabled while a change is saving; focus it once it is enabled
  // again, unless the user has already moved focus elsewhere.
  $effect(() => {
    if (!restoreFocus || !trigger || (unavailable && !open)) return;
    restoreFocus = false;
    const active = document.activeElement;
    if (!active || active === document.body || root?.contains(active)) trigger.focus();
  });

  function close(restore = false) {
    if (panel?.matches(':popover-open')) panel.hidePopover();
    open = false;
    restoreFocus = restore;
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (unavailable) return;
    restoreFocus = false;
    open = true;
    queueMicrotask(() => {
      panel?.showPopover();
      placePanel(trigger, panel);
      stops[effortIndex]?.focus();
    });
  }

  async function choose(index) {
    const teamId = $teamContext.selectedTeamId;
    const effort = INFERENCE_EFFORTS[index];
    if (!teamId || unavailable || !effort || effort === $modelContext.effort) return;
    try {
      await selectTeamEffort(fetch, teamId, effort);
      // Keep focus the user moved elsewhere during the save.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (!active || active === document.body || root?.contains(active)) stops[index]?.focus();
      });
    } catch {
      showAdminNotice({ tone: 'error', label: copy.effort, message: $t('chatContext.modelFailed') });
    }
  }

  function stopKeydown(event) {
    const last = INFERENCE_EFFORTS.length - 1;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    const next = {
      [forward]: Math.min(last, effortIndex + 1),
      ArrowUp: Math.min(last, effortIndex + 1),
      [backward]: Math.max(0, effortIndex - 1),
      ArrowDown: Math.max(0, effortIndex - 1),
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    void choose(next);
  }

  function keydown(event) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  }

  function outsidePointerdown(event) {
    if (open && event.target instanceof Node && !root?.contains(event.target)) close();
  }
</script>

<svelte:window onkeydown={keydown} onresize={() => { if (open) placePanel(trigger, panel); }} />
<svelte:document onpointerdown={outsidePointerdown} />

<div bind:this={root} class="effort-menu">
  <Button
    bind:element={trigger}
    class="effort-trigger"
    variant="ghost"
    size="sm"
    iconOnly
    type="button"
    aria-label={triggerLabel}
    title={triggerLabel}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={panelId}
    disabled={unavailable && !open}
    onclick={toggle}
  >
    <!-- A dial whose needle points to the current effort: left, center, or right. -->
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.8 17a8.2 8.2 0 1 1 16.4 0"></path>
      <path d="M5.9 10.2 7 11M12 5.8v1.4M18.1 10.2 17 11"></path>
      <path class="needle" d="M12 17 12 9.8" transform={`rotate(${(effortIndex - 1) * 55} 12 17)`}></path>
      <circle cx="12" cy="17" r="1.3" class="hub"></circle>
    </svg>
  </Button>
  <div
    bind:this={panel}
    id={panelId}
    class="panel"
    role="dialog"
    aria-labelledby={`${panelId}-title`}
    popover="manual"
  >
    <p class="title" id={`${panelId}-title`}>{copy.effort}</p>
    <div
      class="effort"
      role="radiogroup"
      aria-labelledby={`${panelId}-title`}
      style:--effort-fill={effortIndex / (INFERENCE_EFFORTS.length - 1)}
    >
      <span class="track" aria-hidden="true"><span class="fill"></span></span>
      <span class="thumb" aria-hidden="true"></span>
      {#each INFERENCE_EFFORTS as effort, index (effort)}
        <Button
          bind:element={stops[index]}
          class={['stop', index === effortIndex && 'is-current']}
          variant="ghost"
          size="sm"
          type="button"
          role="radio"
          aria-checked={index === effortIndex}
          tabindex={index === effortIndex ? 0 : -1}
          disabled={unavailable}
          onclick={() => choose(index)}
          onkeydown={stopKeydown}
        >
          <span class="stop-label">{copy.efforts[effort]}</span>
        </Button>
      {/each}
    </div>
  </div>
</div>

<style>
  .effort-menu { display: contents; }
  /* A bare icon inside the composer box: its bars light up to the current level. */
  .effort-menu :global(.shimpz-button.effort-trigger),
  .effort-menu :global(.shimpz-button.effort-trigger:hover:not(:disabled)) { width: 2.25rem; height: 2.25rem; padding: 0; color: var(--shimpz-color-text-dim); border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .effort-menu :global(.shimpz-button.effort-trigger:hover:not(:disabled)),
  .effort-menu :global(.effort-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  .effort-menu :global(.effort-trigger svg) { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .hub { fill: currentColor; }
  .needle { transition: transform 220ms var(--shimpz-ease); }
  .effort-menu :global(.effort-trigger:hover:not(:disabled) svg) { filter: var(--glitch-split-icon); animation: admin-glitch-icon 280ms steps(1, end); }
  .panel {
    position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(16rem, calc(100vw - 1rem));
    gap: var(--shimpz-space-2); margin: 0; padding: var(--shimpz-space-3); color: var(--shimpz-color-text); background: var(--shimpz-color-bg);
    border: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 22%, var(--shimpz-color-border));
    clip-path: polygon(0 0, calc(100% - 0.9rem) 0, 100% 0.9rem, 100% 100%, 0.9rem 100%, 0 calc(100% - 0.9rem));
    box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .title { margin: 0; color: var(--shimpz-color-text-dim); font: 700 0.6rem/1 var(--shimpz-font-mono); letter-spacing: 0.16em; text-transform: uppercase; }
  /* A slider: a hairline track through three notched stops, lit up to a glowing diamond thumb that slides to the
     current level. Each stop stays a radio, so keyboard and assistive use are unchanged. */
  .effort { --stop-center: calc(100% / 6); position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-block-start: 0.2rem; }
  .track { position: absolute; top: 0.95rem; inset-inline: var(--stop-center); height: 2px; background: var(--shimpz-color-border); pointer-events: none; }
  .fill { position: absolute; inset-block: 0; inset-inline-start: 0; width: calc(var(--effort-fill) * 100%); background: linear-gradient(90deg, color-mix(in srgb, var(--shimpz-color-cyan) 35%, transparent), var(--shimpz-color-cyan)); box-shadow: 0 0 0.5rem rgb(0 240 255 / 45%); transition: width 220ms var(--shimpz-ease); }
  .thumb { position: absolute; z-index: 1; top: calc(0.95rem + 1px); left: calc(var(--stop-center) + var(--effort-fill) * (100% - 2 * var(--stop-center))); width: 0.8rem; height: 0.8rem; background: var(--shimpz-color-cyan); box-shadow: 0 0 0.8rem var(--shimpz-color-cyan), 0 0 0 3px var(--shimpz-color-bg); transform: translate(-50%, -50%) rotate(45deg); transition: left 220ms var(--shimpz-ease); pointer-events: none; }
  :global([dir="rtl"]) .fill { inset-inline: auto 0; }
  :global([dir="rtl"]) .thumb { left: auto; right: calc(var(--stop-center) + var(--effort-fill) * (100% - 2 * var(--stop-center))); transform: translate(50%, -50%) rotate(45deg); }
  .effort :global(.stop) { position: relative; width: 100%; height: auto; min-height: 0; padding: 2.05rem 0 0.25rem; color: var(--shimpz-color-text-dim); background: transparent; border: 0; clip-path: none; box-shadow: none; }
  /* The notch of each stop on the track. */
  .effort :global(.stop::after) { position: absolute; top: calc(0.95rem + 1px); left: 50%; width: 0.4rem; height: 0.4rem; background: var(--shimpz-color-bg); border: 1px solid var(--shimpz-color-text-dim); content: ""; transform: translate(-50%, -50%) rotate(45deg); }
  .effort :global(.stop:hover:not(:disabled)) { color: var(--shimpz-color-text); background: transparent; border-color: transparent; box-shadow: none; }
  .effort :global(.stop:hover:not(:disabled)::after) { border-color: var(--shimpz-color-cyan); }
  .effort :global(.stop:hover:not(:disabled) .stop-label) { display: inline-block; text-shadow: var(--glitch-split-text); animation: admin-glitch-text 280ms steps(1, end); }
  .effort :global(.stop.is-current), .effort :global(.stop.is-current:hover:not(:disabled)) { color: var(--shimpz-color-cyan); background: transparent; box-shadow: none; text-shadow: 0 0 0.5rem rgb(0 240 255 / 60%); }
  .stop-label { font: 700 0.6rem/1 var(--shimpz-font-mono); letter-spacing: 0.12em; text-transform: uppercase; }
  .effort :global(.stop:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; box-shadow: none; }
  @media (prefers-reduced-motion: reduce) {
    .effort-menu :global(svg), .effort :global(.stop-label) { animation: none !important; }
    .fill, .thumb, .needle { transition: none; }
  }
</style>
