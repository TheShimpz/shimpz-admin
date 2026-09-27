<script>
  import { Button, ChoiceItem } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain, selectTeamEffort } from '$lib/modelContext.js';
  import { INFERENCE_EFFORTS } from '$lib/modelProviders.js';
  import { teamContext } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let effortButtons = $state([]);
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
  let effortIndex = $derived(Math.max(0, INFERENCE_EFFORTS.indexOf($modelContext.effort)));
  let effortLabel = $derived(copy.efforts[$modelContext.effort] ?? copy.efforts.low);
  let triggerLabel = $derived(
    selected
      ? $t('brainMenu.current', { model: selected.title, effort: effortLabel })
      : $t('chatContext.modelLoading'),
  );

  $effect(() => {
    if (disabled && open) close();
  });

  function place() {
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

  function close(restore = false) {
    if (panel?.matches(':popover-open')) panel.hidePopover();
    open = false;
    if (restore) queueMicrotask(() => trigger?.focus());
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (unavailable) return;
    open = true;
    queueMicrotask(() => {
      panel?.showPopover();
      place();
      panel?.querySelector('.models [aria-pressed="true"]')?.focus();
    });
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
    }
  }

  async function chooseEffort(index) {
    const teamId = $teamContext.selectedTeamId;
    const effort = INFERENCE_EFFORTS[index];
    if (!teamId || unavailable || !effort || effort === $modelContext.effort) return;
    try {
      await selectTeamEffort(fetch, teamId, effort);
      queueMicrotask(() => effortButtons[index]?.focus());
    } catch {
      failed();
    }
  }

  function effortKeydown(event) {
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
    void chooseEffort(next);
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

<svelte:window onkeydown={keydown} onresize={() => { if (open) place(); }} />
<svelte:document onpointerdown={outsidePointerdown} />

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
      <rect x="7" y="7" width="10" height="10"></rect>
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"></path>
    </svg>
  </Button>
  <div bind:this={panel} id={panelId} class="panel" role="dialog" aria-label={copy.settings} popover="manual">
    <p class="section-label" id={`${panelId}-model`}>{copy.model}</p>
    <div class="models" role="group" aria-labelledby={`${panelId}-model`}>
      {#each options as option (option.value)}
        <ChoiceItem
          title={option.title}
          description={option.providerTitle}
          selected={option.value === selected?.value}
          disabled={unavailable}
          onclick={() => chooseModel(option)}
        />
      {/each}
    </div>
    <p class="section-label" id={`${panelId}-effort`}>{copy.effort}</p>
    <div
      class="effort"
      role="radiogroup"
      aria-labelledby={`${panelId}-effort`}
      style={`--effort-fill: ${effortIndex / (INFERENCE_EFFORTS.length - 1)}`}
    >
      <span class="track" aria-hidden="true"><span class="fill"></span></span>
      {#each INFERENCE_EFFORTS as effort, index (effort)}
        <Button
          bind:element={effortButtons[index]}
          class={['stop', index <= effortIndex && 'is-reached', index === effortIndex && 'is-current']}
          variant="ghost"
          size="sm"
          type="button"
          role="radio"
          aria-checked={index === effortIndex}
          tabindex={index === effortIndex ? 0 : -1}
          disabled={unavailable}
          onclick={() => chooseEffort(index)}
          onkeydown={effortKeydown}
        >
          <span class="dot" aria-hidden="true"></span>
          <span class="stop-label">{copy.efforts[effort]}</span>
        </Button>
      {/each}
    </div>
    <p class="hint">{copy.effortHint}</p>
  </div>
</div>

<style>
  .brain-menu { display: contents; }
  .brain-menu :global(.brain-trigger) { width: 2.75rem; height: 2.75rem; padding: 0; }
  .brain-menu :global(.brain-trigger svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .brain-menu :global(.brain-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); border-color: var(--shimpz-color-cyan); }
  .panel { position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(20rem, calc(100vw - 1rem)); gap: var(--shimpz-space-2); margin: 0; padding: var(--shimpz-space-3); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); box-shadow: 0 1rem 3rem rgb(0 0 0 / 65%); }
  .panel:not(:popover-open) { display: none; }
  .section-label { margin: 0; color: var(--shimpz-color-text-dim); font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.12em; text-transform: uppercase; }
  .section-label:not(:first-child) { margin-block-start: var(--shimpz-space-2); }
  .models { display: grid; gap: 2px; }
  .effort { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .track { position: absolute; inset-inline: calc(100% / 6); top: calc(0.5rem + 0.45rem); height: 2px; background: var(--shimpz-color-border); }
  .fill { position: absolute; inset-block: 0; inset-inline-start: 0; width: calc(var(--effort-fill) * 100%); background: var(--shimpz-color-cyan); transition: width var(--shimpz-duration-fast) var(--shimpz-ease); }
  .effort :global(.stop) { position: relative; height: auto; min-height: 0; padding: 0.5rem 0.25rem; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-dim); }
  .effort :global(.stop .button-content) { display: grid; justify-items: center; gap: 0.5rem; }
  .dot { display: block; width: 0.9rem; height: 0.9rem; background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); transform: rotate(45deg); transition: background var(--shimpz-duration-fast) var(--shimpz-ease), border-color var(--shimpz-duration-fast) var(--shimpz-ease); }
  .effort :global(.stop.is-reached .dot) { border-color: var(--shimpz-color-cyan); }
  .effort :global(.stop.is-current .dot) { background: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .effort :global(.stop.is-current) { color: var(--shimpz-color-cyan); }
  .stop-label { font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  .effort :global(.stop:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; }
  .hint { margin: 0; color: var(--shimpz-color-text-muted); font: 400 0.75rem/1.45 var(--shimpz-font-sans); }
  @media (prefers-reduced-motion: reduce) { .fill, .dot { transition: none; } }
</style>
