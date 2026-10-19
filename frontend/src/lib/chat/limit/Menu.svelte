<script>
  import { tick } from 'svelte';
  import { Button } from '@shimpz/frontend';

  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { dismissOnEscape, dismissOutside, hidePanel, openPanel, placePanel } from '#lib/brain/panel.js';
  import { chatLimit, MAX_CHAT_LIMIT, saveChatLimit } from '#lib/chat/limit.js';
  import { t } from '#lib/i18n/index.js';
  import { focusMark, regainFocus } from '#lib/shell/focus.js';

  // How many conversations the Space runs at once (ADR-0119), in its own composer control. Team owns the limit; the
  // control shows the one Admin read, and a change shows only that it is under way until the limit is read again.
  let { disabled = false } = $props();

  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let panel = $state();
  let saving = $state(false);
  let error = $state('');
  const panelId = $props.id();
  const choices = Array.from({ length: MAX_CHAT_LIMIT }, (_, index) => index + 1);

  let copy = $derived($t('chatLimitMenu'));
  let limit = $derived($chatLimit.value);
  let phase = $derived(saving ? 'saving' : $chatLimit.status === 'error' ? 'unavailable' : limit ? 'ready' : 'loading');
  let blocked = $derived(saving || !$commandsReady);
  let triggerLabel = $derived(limit ? `${copy.label}: ${limit}` : copy.label);

  $effect(() => {
    if (disabled && open) close();
  });

  $effect(() => {
    void phase;
    if (open) void tick().then(() => { if (open) placePanel(trigger, panel); });
  });

  function close(restore = false) {
    hidePanel(panel);
    open = false;
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
    openPanel(trigger, panel, () => panel?.querySelector('[aria-pressed="true"], .limit-choice'));
  }

  async function choose(value) {
    if (phase !== 'ready' || blocked || value === limit) return;
    saving = true;
    error = '';
    const mark = focusMark();
    try {
      await saveChatLimit(value);
    } catch (failed) {
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy.failed;
    }
    saving = false;
    void regainFocus(() => panel?.querySelector(`[data-limit="${value}"]`), { shown: () => open, since: mark });
  }
</script>

<svelte:window
  onkeydown={(event) => dismissOnEscape(event, open, close)}
  onresize={() => { if (open) placePanel(trigger, panel); }}
/>
<svelte:document onpointerdown={(event) => dismissOutside(event, open, root, close)} />

<div bind:this={root} class="limit-menu">
  <Button
    bind:element={trigger}
    class="limit-trigger"
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
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h11M19 5v14"></path></svg>
  </Button>
  <div
    bind:this={panel}
    id={panelId}
    class="panel admin-overlay"
    role="dialog"
    aria-labelledby={`${panelId}-title`}
    aria-busy={phase === 'loading' || blocked}
    popover="manual"
  >
    {#if open}
      <p class="title" id={`${panelId}-title`}>{copy.label}</p>
      <p class="summary">{copy.summary}</p>
      {#if phase === 'unavailable'}
        <p class="status" role="status">{copy.unavailable}</p>
      {:else if phase === 'loading'}
        <p class="status">…</p>
      {:else}
        <div class="choices" role="group" aria-label={copy.label}>
          {#each choices as value (value)}
            <Button
              class="limit-choice"
              type="button"
              size="sm"
              variant={value === limit ? 'primary' : 'secondary'}
              aria-pressed={value === limit}
              data-limit={value}
              disabled={blocked}
              onclick={() => choose(value)}
            >
              {value}
            </Button>
          {/each}
        </div>
      {/if}
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .limit-menu { display: contents; }
  .limit-menu :global(.shimpz-button.limit-trigger),
  .limit-menu :global(.shimpz-button.limit-trigger:hover:not(:disabled)) { width: 2.25rem; height: 2.25rem; padding: 0; color: var(--shimpz-color-text-dim); border-color: transparent; background: transparent; clip-path: none; box-shadow: none; }
  .limit-menu :global(.shimpz-button.limit-trigger:hover:not(:disabled)),
  .limit-menu :global(.limit-trigger[aria-expanded="true"]) { color: var(--shimpz-color-cyan); }
  .limit-menu :global(.limit-trigger svg) { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .panel {
    position: fixed; z-index: 80; top: var(--panel-top); left: var(--panel-left); display: grid; width: min(21rem, calc(100vw - 1rem));
    max-height: calc(100dvh - 1rem); overflow-y: auto;
    gap: var(--gap-group); margin: 0; padding: var(--gap-panel); color: var(--shimpz-color-text); background: var(--shimpz-color-surface-raised);
    border: 1px solid var(--shimpz-color-border); clip-path: var(--shimpz-control-shape); box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 70%);
  }
  .panel:not(:popover-open) { display: none; }
  .title { margin: 0; color: var(--shimpz-color-text); font: 700 0.66rem/1 var(--shimpz-font-mono); letter-spacing: 0.14em; text-transform: uppercase; }
  .summary, .status, .error { margin: 0; line-height: 1.5; }
  .summary { color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  .status { color: var(--shimpz-color-cyan); font: 400 0.74rem/1.4 var(--shimpz-font-mono); }
  .choices { display: flex; gap: var(--gap-inside); }
  .error { color: var(--shimpz-color-danger); font-size: 0.74rem; }
</style>
