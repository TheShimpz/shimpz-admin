<script>
  import { onMount, tick } from 'svelte';
  import { Button, StatusBadge, TextField, TextLink } from '@shimpz/frontend';

  import { placePanel } from '$lib/composerPanel.js';
  import { loadDecisionProvider, removeDecisionKey, saveDecisionKey } from '$lib/decisionProvider.js';
  import { t } from '$lib/i18n.js';

  // The optional Jev key (ADR-0077) in its own composer control. Only Local Admin custodies it; the caller renders
  // this control only there. Phase is idle, loading, ready, saving, or unavailable.
  let { disabled = false } = $props();

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let fast = $state({ phase: 'idle', configured: false, masked: null, error: '' });
  let fastKey = $state('');
  const panelId = $props.id();
  // Each status read or write takes a ticket so an older answer never overwrites a newer one.
  let fastTicket = 0;

  // TypeSafe's own key page (docs.typesafe.ai quickstart).
  const KEYS_URL = 'https://console.typesafe.ai/keys';

  let copy = $derived($t('brainMenu').fast);
  let saving = $derived(fast.phase === 'saving');
  let status = $derived(fast.configured ? $t('brainMenu.fast.on', { masked: fast.masked }) : copy.off);
  let triggerLabel = $derived(fast.phase === 'ready' ? `${copy.label}: ${status}` : copy.label);

  onMount(() => {
    void loadFast();
  });

  $effect(() => {
    if (disabled && open) close();
  });

  function close(restore = false) {
    if (panel?.matches(':popover-open')) panel.hidePopover();
    open = false;
    // A typed key never outlives the open panel.
    fastKey = '';
    fast.error = '';
    if (restore) queueMicrotask(() => trigger?.focus());
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (disabled) return;
    open = true;
    queueMicrotask(() => {
      panel?.showPopover();
      placePanel(trigger, panel);
      panel?.querySelector('input, .fast-remove')?.focus();
    });
    // The key is Space-wide, so every opening re-reads it in case another session changed it.
    if (!saving) void loadFast();
  }

  async function settle(update) {
    fast = { ...fast, ...update };
    await tick();
    if (open) placePanel(trigger, panel);
  }

  async function loadFast() {
    const ticket = ++fastTicket;
    if (fast.phase !== 'ready') await settle({ phase: 'loading', error: '' });
    try {
      const state = await loadDecisionProvider(fetch);
      if (ticket === fastTicket) await settle({ phase: 'ready', ...state });
    } catch {
      if (ticket === fastTicket) await settle({ phase: 'unavailable' });
    }
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
      await settle({ phase: 'ready', ...state });
      panel?.querySelector('.fast-remove')?.focus();
    } catch (error) {
      if (ticket !== fastTicket) return;
      await settle({ phase: 'ready', error: error?.status === 400 ? copy.rejected : copy.failed });
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
      panel?.querySelector('input')?.focus();
    } catch {
      if (ticket !== fastTicket) return;
      await settle({ phase: 'ready', error: copy.removeFailed });
    }
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

<div bind:this={root} class="fast-menu">
  <Button
    bind:element={trigger}
    class={['fast-trigger', fast.configured && 'is-on']}
    variant="ghost"
    size="sm"
    iconOnly
    type="button"
    aria-label={triggerLabel}
    title={triggerLabel}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={panelId}
    disabled={disabled && !open}
    onclick={toggle}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.8 5.3 13.1a.5.5 0 0 0 .4.8h5.1l-1 7.3 7.9-10.3a.5.5 0 0 0-.4-.8h-5.1z"></path></svg>
  </Button>
  <div
    bind:this={panel}
    id={panelId}
    class="panel"
    role="dialog"
    aria-labelledby={`${panelId}-title`}
    aria-busy={fast.phase === 'loading' || saving}
    popover="manual"
  >
    <!-- Mounted only while open, so no key field or disclosure exists behind a closed panel. -->
    {#if open}
    <header class="head">
      <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2.5 5.5 13.5h5.5l-1 8 8-11h-5.5z"></path></svg>
      <p class="title" id={`${panelId}-title`}>{copy.label}</p>
      {#if fast.phase === 'ready'}
        <StatusBadge tone={fast.configured ? 'info' : 'neutral'}>{fast.configured ? copy.stateOn : copy.stateOff}</StatusBadge>
      {/if}
    </header>
    <!-- One paragraph: what Jev does, and, until a key exists, where to create it. -->
    <p class="summary">
      {copy.summary}
      {#if fast.phase === 'ready' && !fast.configured}
        <TextLink href={KEYS_URL} title={KEYS_URL} external>{copy.keyLink} ↗</TextLink>
        {copy.keyAfter}
      {/if}
    </p>
    {#if fast.phase === 'unavailable'}
      <p class="status" role="status">{copy.unavailable}</p>
    {:else if fast.phase === 'idle' || fast.phase === 'loading'}
      <p class="status">…</p>
    {:else if fast.configured}
      <div class="row">
        <p class="status">{status}</p>
        <Button class="fast-remove" type="button" variant="ghost" size="sm" disabled={saving} onclick={removeFast}>
          {copy.remove}
        </Button>
      </div>
    {:else}
      <form class="form" onsubmit={saveFast}>
        <TextField
          id={`${panelId}-key`}
          label={copy.key}
          visuallyHiddenLabel
          placeholder={copy.placeholder}
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
          disabled={saving}
        />
        <div class="actions">
          <Button type="submit" size="sm" disabled={saving || fastKey.trim().length < 16}>
            {saving ? copy.validating : copy.save}
          </Button>
        </div>
      </form>
    {/if}
    {#if fast.error}
      <p class="error" role="alert">{fast.error}</p>
    {/if}
    {/if}
  </div>
</div>

<style>
  .fast-menu { display: contents; }
  .fast-menu :global(.shimpz-button.fast-trigger),
  .fast-menu :global(.shimpz-button.fast-trigger:hover:not(:disabled)) { width: 2.25rem; height: 2.25rem; padding: 0; color: var(--shimpz-color-text-dim); border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .fast-menu :global(.shimpz-button.fast-trigger:hover:not(:disabled)),
  .fast-menu :global(.fast-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  /* A configured key keeps the bolt lit, so the chat shows fast routing is on without opening anything. */
  .fast-menu :global(.shimpz-button.fast-trigger.is-on) { color: var(--shimpz-color-cyan); filter: drop-shadow(0 0 0.35rem rgb(0 240 255 / 55%)); }
  .fast-menu :global(.fast-trigger svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .panel {
    position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(21rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 1rem); overflow-y: auto;
    gap: var(--shimpz-space-3); margin: 0; padding: var(--shimpz-space-4); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border); clip-path: var(--shimpz-control-shape); box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .head { display: flex; align-items: center; gap: var(--shimpz-space-2); }
  .glyph { width: 0.95rem; height: 0.95rem; fill: none; stroke: var(--shimpz-color-cyan); stroke-width: 1.5; stroke-linejoin: miter; }
  .title { flex: 1; margin: 0; color: var(--shimpz-color-text); font: 700 0.66rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .summary, .status, .error { margin: 0; line-height: 1.5; }
  .summary { color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  .status { color: var(--shimpz-color-cyan); font: 400 0.74rem/1.4 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--shimpz-space-2); }
  .form { display: grid; gap: var(--shimpz-space-3); }
  .actions { display: flex; justify-content: flex-end; }
  .error { color: var(--shimpz-color-danger); font-size: 0.74rem; }
  @media (prefers-reduced-motion: reduce) {
    .fast-menu :global(svg) { animation: none !important; }
  }
</style>
