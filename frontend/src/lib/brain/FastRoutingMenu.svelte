<script>
  import { tick } from 'svelte';
  import { Button, StatusBadge, TextField, TextLink } from '@shimpz/frontend';

  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { dismissOnEscape, dismissOutside, hidePanel, openPanel, placePanel } from '#lib/brain/panel.js';
  import { decisionProvider, removeDecisionKey, saveDecisionKey } from '#lib/brain/decision.js';
  import { t } from '#lib/i18n/index.js';
  import { CREDENTIAL_RECORD_INVALID } from '#lib/api.js';

  // The optional Jev key (ADR-0077) in its own composer control. Only Local Admin custodies it; the caller renders
  // this control only there. Its state is the one Admin holds, read over the session socket and again whenever Admin
  // says it changed; a save or removal shows only that it is under way, and what it stored shows once read again.
  // Phase is loading, ready, saving, or unavailable.
  let { disabled = false } = $props();

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let changing = $state(false);
  let error = $state('');
  let fastKey = $state('');
  const panelId = $props.id();

  // TypeSafe's own key page (docs.typesafe.ai quickstart).
  const KEYS_URL = 'https://console.typesafe.ai/keys';

  let copy = $derived($t('brainMenu').fast);
  let fast = $derived({
    // A refused read is shown even while an earlier state is known.
    phase: changing
      ? 'saving'
      : $decisionProvider.status === 'error'
        ? 'unavailable'
        : $decisionProvider.value ? 'ready' : 'loading',
    configured: $decisionProvider.value?.configured ?? false,
    masked: $decisionProvider.value?.masked ?? null,
    error,
  });
  // A change is offered only while Admin is connected and no other change is in flight.
  let blocked = $derived(changing || !$commandsReady);
  let status = $derived(fast.configured ? $t('brainMenu.fast.on', { masked: fast.masked }) : copy.off);
  let triggerLabel = $derived(fast.phase === 'ready' ? `${copy.label}: ${status}` : copy.label);

  $effect(() => {
    if (disabled && open) close();
  });

  // The panel follows its content as the state changes.
  $effect(() => {
    void fast;
    if (open) void tick().then(() => { if (open) placePanel(trigger, panel); });
  });

  function close(restore = false) {
    hidePanel(panel);
    open = false;
    // A typed key never outlives the open panel.
    fastKey = '';
    error = '';
    if (restore) queueMicrotask(() => trigger?.focus());
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    if (disabled) return;
    open = true;
    openPanel(trigger, panel, () => panel?.querySelector('input, .fast-remove'));
  }

  // A change disables the panel's controls meanwhile, which drops the focus to the document: once it ends, `focus`
  // takes it back in the panel still open, or on a refusal the control it left in place (the key typed, or Remove).
  // The panel stays open when Tab leaves it, so focus the person moved stays where it is.
  async function changeKey(action, failure, focus) {
    changing = true;
    error = '';
    let target = focus;
    try {
      await action();
      fastKey = '';
    } catch (failed) {
      // A change whose answer was lost shows so; Admin's state is read again once it is back.
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : failure(failed);
      target = 'input, .fast-remove';
    }
    changing = false;
    await tick();
    const focused = document.activeElement;
    if (open && (!focused || focused === document.body)) panel?.querySelector(target)?.focus();
  }

  function saveFast(event) {
    event.preventDefault();
    if (fast.phase !== 'ready' || blocked || !fastKey.trim()) return;
    const key = fastKey;
    void changeKey(() => saveDecisionKey(key), (failed) => (failed?.status === 400 ? copy.rejected : copy.failed), '.fast-remove');
  }

  function removeFast() {
    if (fast.phase !== 'ready' || blocked) return;
    void changeKey(removeDecisionKey, () => copy.removeFailed, 'input');
  }
</script>

<svelte:window
  onkeydown={(event) => dismissOnEscape(event, open, close)}
  onresize={() => { if (open) placePanel(trigger, panel); }}
/>
<svelte:document onpointerdown={(event) => dismissOutside(event, open, root, close)} />

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
    class="panel admin-overlay"
    role="dialog"
    aria-labelledby={`${panelId}-title`}
    aria-busy={fast.phase === 'loading' || blocked}
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
      <!-- A stored key record Admin did not write names its one remedy instead. -->
      <p class="status" role="status">
        {$decisionProvider.error?.code === CREDENTIAL_RECORD_INVALID ? $t('shell.credentialRecordInvalid') : copy.unavailable}
      </p>
    {:else if fast.phase === 'loading'}
      <p class="status">…</p>
    {:else if fast.configured}
      <div class="row">
        <p class="status">{status}</p>
        <Button class="fast-remove" type="button" variant="ghost" size="sm" disabled={blocked} onclick={removeFast}>
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
          disabled={blocked}
        />
        <div class="actions">
          <Button type="submit" size="sm" disabled={blocked || fastKey.trim().length < 16}>
            {changing ? copy.validating : copy.save}
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
    gap: var(--gap-group); margin: 0; padding: var(--gap-panel); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border); clip-path: var(--shimpz-control-shape); box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .head { display: flex; align-items: center; gap: var(--gap-inside); }
  .glyph { width: 0.95rem; height: 0.95rem; fill: none; stroke: var(--shimpz-color-cyan); stroke-width: 1.5; stroke-linejoin: miter; }
  .title { flex: 1; margin: 0; color: var(--shimpz-color-text); font: 700 0.66rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .summary, .status, .error { margin: 0; line-height: 1.5; }
  .summary { color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  .status { color: var(--shimpz-color-cyan); font: 400 0.74rem/1.4 var(--shimpz-font-mono); font-variant-numeric: tabular-nums; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-group); }
  .form { display: grid; gap: var(--gap-group); }
  .actions { display: flex; justify-content: flex-end; }
  .error { color: var(--shimpz-color-danger); font-size: 0.74rem; }
  @media (prefers-reduced-motion: reduce) {
    .fast-menu :global(svg) { animation: none !important; }
  }
</style>
