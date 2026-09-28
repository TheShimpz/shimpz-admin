<script>
  import { tick } from 'svelte';
  import { Button, ChoiceItem, TextField } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';
  import { loadDecisionProvider, removeDecisionKey, saveDecisionKey } from '$lib/decisionProvider.js';
  import { t } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain, selectTeamEffort } from '$lib/modelContext.js';
  import { INFERENCE_EFFORTS } from '$lib/modelProviders.js';
  import { sessionContext } from '$lib/sessionContext.js';
  import { teamContext } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  let open = $state(false);
  let restoreFocus = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let effortButtons = $state([]);
  const panelId = $props.id();
  // The optional Jev key (ADR-0077): phase is idle, loading, ready, saving, or unavailable.
  let fast = $state({ phase: 'idle', configured: false, masked: null, editing: false, error: '' });
  let fastKey = $state('');
  // Only Local Admin custodies a Jev key; Hosted has no decision-provider route.
  let fastAvailable = $derived($sessionContext.profile === 'local');
  // Each status read or write takes a ticket so an older answer never overwrites a newer one.
  let fastTicket = 0;

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

  // Escape returns focus to the trigger, which stays disabled while a Brain change is saving; focus it once it is
  // enabled again, unless the user has already moved focus elsewhere.
  $effect(() => {
    if (!restoreFocus || !trigger || (unavailable && !open)) return;
    restoreFocus = false;
    const active = document.activeElement;
    if (!active || active === document.body || root?.contains(active)) trigger.focus();
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
    // A typed key never outlives the open panel.
    fastKey = '';
    fast.editing = false;
    fast.error = '';
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
      place();
      panel?.querySelector('.models [aria-pressed="true"]')?.focus();
    });
    // The key is Space-wide, so every opening re-reads it in case another session changed it.
    if (fastAvailable && fast.phase !== 'saving') void loadFast();
  }

  async function settle(update) {
    fast = { ...fast, ...update };
    await tick();
    if (open) place();
  }

  async function loadFast() {
    const ticket = ++fastTicket;
    if (fast.phase !== 'ready') await settle({ phase: 'loading', error: '' });
    try {
      const state = await loadDecisionProvider(fetch);
      if (ticket === fastTicket) await settle({ phase: 'ready', ...state });
    } catch {
      if (ticket === fastTicket) await settle({ phase: 'unavailable', editing: false });
    }
  }

  async function editFast(editing) {
    fastKey = '';
    await settle({ editing, error: '' });
    if (editing) panel?.querySelector('.fast input')?.focus();
  }

  async function saveFast(event) {
    event.preventDefault();
    if (fast.phase !== 'ready' || !fastKey.trim()) return;
    const ticket = ++fastTicket;
    await settle({ phase: 'saving', error: '' });
    try {
      const state = await saveDecisionKey(fetch, fastKey);
      if (ticket !== fastTicket) return;
      fastKey = '';
      await settle({ phase: 'ready', editing: false, ...state });
      panel?.querySelector('.fast-remove')?.focus();
    } catch (error) {
      if (ticket !== fastTicket) return;
      await settle({ phase: 'ready', error: error?.status === 400 ? copy.fast.rejected : copy.fast.failed });
    }
  }

  async function removeFast() {
    if (fast.phase !== 'ready') return;
    const ticket = ++fastTicket;
    await settle({ phase: 'saving', error: '' });
    try {
      const state = await removeDecisionKey(fetch);
      if (ticket !== fastTicket) return;
      await settle({ phase: 'ready', ...state });
      panel?.querySelector('.fast-add')?.focus();
    } catch {
      if (ticket !== fastTicket) return;
      await settle({ phase: 'ready', error: copy.fast.removeFailed });
    }
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
    <div class="effort" role="radiogroup" aria-label={copy.effort}>
      {#each INFERENCE_EFFORTS as effort, index (effort)}
        <Button
          bind:element={effortButtons[index]}
          class={['stop', index === effortIndex && 'is-current']}
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
          <span
            class={[
              'rail',
              index === 0 && 'is-first',
              index === INFERENCE_EFFORTS.length - 1 && 'is-last',
              index > 0 && index <= effortIndex && 'fill-before',
              index < effortIndex && 'fill-after',
            ]}
            aria-hidden="true"
          >
            <span class={['dot', index <= effortIndex && 'is-reached', index === effortIndex && 'is-current']}></span>
          </span>
          <span class="stop-label">{copy.efforts[effort]}</span>
        </Button>
      {/each}
    </div>
    {#if fastAvailable}
      <section class="fast" aria-labelledby={`${panelId}-fast`} aria-busy={fast.phase === 'loading' || fast.phase === 'saving'}>
        <p class="section-label" id={`${panelId}-fast`}>{copy.fast.label}</p>
        {#if fast.phase === 'unavailable'}
          <p class="fast-status" role="status">{copy.fast.unavailable}</p>
        {:else if fast.phase === 'idle' || fast.phase === 'loading'}
          <p class="fast-status">…</p>
        {:else if fast.editing}
          <form class="fast-form" onsubmit={saveFast}>
            <TextField
              id={`${panelId}-fast-key`}
              label={copy.fast.key}
              type="password"
              bind:value={fastKey}
              minlength="16"
              maxlength="8192"
              autocomplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore="true"
              spellcheck="false"
              required
              disabled={fast.phase === 'saving'}
              aria-describedby={`${panelId}-fast-note`}
            />
            <p class="fast-note" id={`${panelId}-fast-note`}>{copy.fast.note}</p>
            <div class="fast-actions">
              <Button type="button" variant="ghost" size="sm" disabled={fast.phase === 'saving'} onclick={() => editFast(false)}>
                {copy.fast.cancel}
              </Button>
              <Button type="submit" size="sm" disabled={fast.phase === 'saving' || fastKey.trim().length < 16}>
                {fast.phase === 'saving' ? copy.fast.validating : copy.fast.save}
              </Button>
            </div>
          </form>
        {:else}
          <div class="fast-row">
            <p class="fast-status">
              {fast.configured ? $t('brainMenu.fast.on', { masked: fast.masked }) : copy.fast.off}
            </p>
            {#if fast.configured}
              <Button class="fast-remove" type="button" variant="ghost" size="sm" disabled={fast.phase === 'saving'} onclick={removeFast}>
                {copy.fast.remove}
              </Button>
            {:else}
              <Button class="fast-add" type="button" variant="ghost" size="sm" disabled={fast.phase === 'saving'} onclick={() => editFast(true)}>
                {copy.fast.add}
              </Button>
            {/if}
          </div>
        {/if}
        {#if fast.error}
          <p class="fast-error" role="alert">{fast.error}</p>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .brain-menu { display: contents; }
  .brain-menu :global(.brain-trigger) { width: 2.75rem; height: 2.75rem; padding: 0; }
  .brain-menu :global(.brain-trigger svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  /* A bare icon inside the composer box: no frame or fill, only its color reacts. */
  .brain-menu :global(.shimpz-button.brain-trigger),
  .brain-menu :global(.shimpz-button.brain-trigger:hover:not(:disabled)) { border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .brain-menu :global(.shimpz-button.brain-trigger:hover:not(:disabled)),
  .brain-menu :global(.brain-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  .panel { position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(20rem, calc(100vw - 1rem)); max-height: calc(100dvh - 1rem); overflow-y: auto; gap: var(--shimpz-space-2); margin: 0; padding: var(--shimpz-space-3); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); box-shadow: 0 1rem 3rem rgb(0 0 0 / 65%); }
  .panel:not(:popover-open) { display: none; }
  .section-label { margin: 0; color: var(--shimpz-color-text-dim); font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.12em; text-transform: uppercase; }
  .models { display: grid; gap: 2px; }
  .effort { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-block-start: var(--shimpz-space-2); }
  .effort :global(.stop) { width: 100%; height: auto; min-height: 0; padding: 0.35rem 0 0.45rem; border: 0; background: transparent; clip-path: none; color: var(--shimpz-color-text-dim); box-shadow: none; }
  .effort :global(.stop:hover:not(:disabled)) { color: var(--shimpz-color-text); background: transparent; border-color: transparent; box-shadow: none; }
  .effort :global(.stop.is-current), .effort :global(.stop.is-current:hover:not(:disabled)) { color: var(--shimpz-color-cyan); }
  .effort :global(.stop .button-content) { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr); justify-content: stretch; justify-items: stretch; gap: 0.55rem; }
  /* Each stop draws its connectors from the exact center of its own diamond, so the line always meets it. */
  .rail { position: relative; display: grid; height: 1.3rem; place-items: center; }
  .rail::before, .rail::after { position: absolute; top: 50%; height: 2px; margin-top: -1px; background: var(--shimpz-color-border); content: ""; transition: background var(--shimpz-duration-fast) var(--shimpz-ease); }
  .rail::before { inset-inline: 0 50%; }
  .rail::after { inset-inline: 50% 0; }
  .rail.is-first::before, .rail.is-last::after { display: none; }
  .rail.fill-before::before, .rail.fill-after::after { background: var(--shimpz-color-cyan); }
  .dot { position: relative; z-index: 1; display: block; width: 0.9rem; height: 0.9rem; background: var(--shimpz-color-surface-raised); border: 1px solid var(--shimpz-color-border); transform: rotate(45deg); transition: background var(--shimpz-duration-fast) var(--shimpz-ease), border-color var(--shimpz-duration-fast) var(--shimpz-ease); }
  .dot.is-reached { border-color: var(--shimpz-color-cyan); }
  .dot.is-current { background: var(--shimpz-color-cyan); box-shadow: var(--shimpz-glow-cyan); }
  .stop-label { justify-self: center; font: 700 0.64rem/1 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; transition: color var(--shimpz-duration-fast) var(--shimpz-ease); }
  .effort :global(.stop:focus-visible) { outline: 2px solid var(--shimpz-color-yellow); outline-offset: -2px; box-shadow: none; }
  .fast { display: grid; gap: var(--shimpz-space-2); margin-block-start: var(--shimpz-space-2); padding-block-start: var(--shimpz-space-3); border-block-start: 1px solid var(--shimpz-color-border); }
  .fast-row { display: flex; align-items: center; justify-content: space-between; gap: var(--shimpz-space-2); }
  .fast-row :global(.shimpz-button) { flex: none; white-space: nowrap; }
  .fast-status, .fast-note, .fast-error { margin: 0; font-size: 0.8rem; line-height: 1.4; }
  .fast-status { color: var(--shimpz-color-text-dim); font-variant-numeric: tabular-nums; }
  .fast-note { color: var(--shimpz-color-text-muted); }
  .fast-error { color: var(--shimpz-color-danger); }
  .fast-form { display: grid; gap: var(--shimpz-space-2); }
  .fast-actions { display: flex; justify-content: flex-end; gap: var(--shimpz-space-2); }
  @media (prefers-reduced-motion: reduce) { .rail::before, .rail::after, .dot, .stop-label { transition: none; } }
</style>
