<script>
  import { Button, ChoiceItem } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';
  import { dismissOnEscape, dismissOutside, hidePanel, openPanel, placePanel } from '$lib/composerPanel.js';
  import { t } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain } from '$lib/modelContext.js';
  import { teamContext } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  let open = $state(false);
  let restoreFocus = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  const panelId = $props.id();

  let copy = $derived($t('brainMenu'));
  let options = $derived(
    $modelContext.providers.flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      provider: provider.id,
      providerTitle: provider.title,
      model: model.id,
      title: model.title,
    }))),
  );
  let selected = $derived(
    options.find((entry) => (
      entry.provider === $modelContext.provider && entry.model === $modelContext.model
    )) ?? null,
  );
  let busy = $derived(['idle', 'loading', 'saving'].includes($modelContext.phase));
  let unavailable = $derived(
    disabled || !$teamContext.selectedTeamId || $teamContext.phase === 'loading' || busy,
  );
  let effortLabel = $derived(copy.efforts[$modelContext.effort] ?? copy.efforts.low);
  let triggerLabel = $derived(
    selected
      ? $t('brainMenu.current', { model: selected.title, effort: effortLabel })
      : $t('chatContext.modelLoading'),
  );

  $effect(() => {
    if (disabled && open) close();
  });

  // Escape returns focus to the trigger, which stays disabled while a Brain change is saving; focus it once it is
  // enabled again, unless the user has already moved focus elsewhere.
  $effect(() => {
    if (!restoreFocus || !trigger || (unavailable && !open)) return;
    restoreFocus = false;
    const active = document.activeElement;
    if (!active || active === document.body || root?.contains(active)) trigger.focus();
  });

  function close(restore = false) {
    hidePanel(panel);
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
    openPanel(trigger, panel, () => panel?.querySelector('.models [aria-pressed="true"]'));
  }

  function failed() {
    showAdminNotice({ tone: 'error', label: copy.label, message: $t('chatContext.modelFailed') });
  }

  async function chooseModel(option) {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId || unavailable || option.value === selected?.value) return;
    try {
      await selectTeamBrain(fetch, teamId, option.provider, option.model);
    } catch {
      failed();
      return;
    }
    // A model whose provider has no key asks for it in the composer, which this panel would cover.
    if (!$modelContext.ready) close();
  }
</script>

<svelte:window
  onkeydown={(event) => dismissOnEscape(event, open, close)}
  onresize={() => { if (open) placePanel(trigger, panel); }}
/>
<svelte:document onpointerdown={(event) => dismissOutside(event, open, root, close)} />

<div bind:this={root} class="brain-menu">
  <Button
    bind:element={trigger}
    class="brain-trigger"
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
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5.2a2.9 2.9 0 0 0-5.4-1.3A2.9 2.9 0 0 0 4.3 8a3 3 0 0 0 .3 5.6A3.1 3.1 0 0 0 8 18.4a2.8 2.8 0 0 0 4 .9"></path>
      <path d="M12 5.2a2.9 2.9 0 0 1 5.4-1.3A2.9 2.9 0 0 1 19.7 8a3 3 0 0 1-.3 5.6 3.1 3.1 0 0 1-3.4 4.8 2.8 2.8 0 0 1-4 .9"></path>
      <path d="M12 5.2v14.1M8.6 9.2a2.2 2.2 0 0 1 3.4.4M15.4 9.2a2.2 2.2 0 0 0-3.4.4M8.4 14a2.4 2.4 0 0 0 3.6.3M15.6 14a2.4 2.4 0 0 1-3.6.3"></path>
    </svg>
  </Button>
  <div bind:this={panel} id={panelId} class="panel" role="dialog" aria-label={copy.settings} popover="manual">
    <p class="section-label" id={`${panelId}-model`}>{copy.model}</p>
    <div class="models" role="group" aria-labelledby={`${panelId}-model`}>
      {#each options as option, index (option.value)}
        {#if index === 0 || options[index - 1].provider !== option.provider}
          <p class="provider" aria-hidden="true">{option.providerTitle}</p>
        {/if}
        <ChoiceItem
          class="model"
          title={option.title}
          description={option.providerTitle}
          selected={option.value === selected?.value}
          disabled={unavailable}
          onclick={() => chooseModel(option)}
        />
      {/each}
    </div>
  </div>
</div>

<style>
  .brain-menu { display: contents; }
  .brain-menu :global(.brain-trigger) { width: 2.75rem; height: 2.75rem; padding: 0; }
  .brain-menu :global(.brain-trigger svg) { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  /* A bare icon inside the composer box: no frame or fill, only its color reacts. */
  .brain-menu :global(.shimpz-button.brain-trigger),
  .brain-menu :global(.shimpz-button.brain-trigger:hover:not(:disabled)) { color: var(--shimpz-color-text-dim); border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .brain-menu :global(.shimpz-button.brain-trigger:hover:not(:disabled)),
  .brain-menu :global(.brain-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  /* The Brain panel: a chamfered console. Models are grouped under a quiet provider rule, the current one lit by a
     diamond and the Team rows' scanline tint; the reasoning effort has its own composer control. */
  .panel {
    --brain-hover-bg: color-mix(in srgb, var(--shimpz-color-cyan) 7%, var(--shimpz-color-bg));
    --brain-scanlines: repeating-linear-gradient(0deg, rgb(0 240 255 / 5%) 0 1px, transparent 1px 3px);
    position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(19rem, calc(100vw - 1rem));
    /* A menu's padding is one item step; its rows carry their own inline padding. The 1rem keeps clear of the viewport
       edge, not rhythm. */
    max-height: calc(100dvh - 1rem); overflow-y: auto; gap: var(--gap-item); margin: 0; padding: var(--gap-item);
    color: var(--shimpz-color-text); background: var(--shimpz-color-bg);
    border: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 22%, var(--shimpz-color-border));
    clip-path: polygon(0 0, calc(100% - 0.9rem) 0, 100% 0.9rem, 100% 100%, 0.9rem 100%, 0 calc(100% - 0.9rem));
    box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .section-label { margin: 0; padding-inline: var(--gap-item); color: var(--shimpz-color-text-dim); font: 700 0.6rem/1 var(--shimpz-font-mono); letter-spacing: 0.16em; text-transform: uppercase; }
  .models { display: grid; gap: 1px; } /* a hairline seam between the rows' own tints, not rhythm */
  .provider { display: flex; align-items: center; gap: var(--gap-item); margin: var(--gap-item) 0 var(--gap-inside); padding-inline: var(--gap-item); color: var(--shimpz-color-cyan); font: 600 0.58rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.7; }
  .provider::after { flex: 1; height: 1px; background: var(--shimpz-color-border); content: ""; }
  .models :global(.model) { position: relative; isolation: isolate; min-height: 2.35rem; gap: var(--gap-inside); padding: var(--gap-inside) var(--gap-item); color: var(--shimpz-color-text-muted); background: transparent; border: 0; clip-path: none; box-shadow: none; }
  .models :global(.model::before) { position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); content: ""; pointer-events: none; }
  .models :global(.model:hover:not(:disabled)), .models :global(.model.is-selected) { color: var(--shimpz-color-text); background: transparent; border: 0; box-shadow: none; }
  .models :global(.model:hover:not(:disabled)::before), .models :global(.model.is-selected::before) { background: var(--brain-scanlines), var(--brain-hover-bg); }
  .models :global(.model strong) { font: 500 0.84rem/1.2 var(--shimpz-font-sans); letter-spacing: 0; text-transform: none; }
  /* The provider is spoken with each model but shown once, in its group rule. */
  .models :global(.model small) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* The margin makes room for the rotated diamond's corners: geometry, not rhythm. */
  .models :global(.model .marker) { width: 0.5rem; height: 0.5rem; margin-inline: 0.2rem; background: transparent; border: 1px solid var(--shimpz-color-text-dim); box-shadow: none; transform: rotate(45deg); }
  .models :global(.model.is-selected .marker) { background: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); box-shadow: 0 0 0.6rem var(--shimpz-color-cyan); }
  .models :global(.model:hover:not(:disabled) strong) { text-shadow: var(--glitch-split-text); animation: admin-glitch-text 280ms steps(1, end); }
  /* The diamond keeps its rotation; only its chromatic split flickers. */
  .models :global(.model:hover:not(:disabled) .marker) { filter: var(--glitch-split-icon); }
  @media (prefers-reduced-motion: reduce) {
    .models :global(.model strong), .models :global(.model .marker), .brain-menu :global(svg) { animation: none !important; }
  }
  .models :global(.model:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; }
</style>
