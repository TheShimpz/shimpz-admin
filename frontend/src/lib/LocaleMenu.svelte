<script>
  import { Button } from '@shimpz/frontend';
  import { locale, setLocale, LOCALES, t } from '$lib/i18n.js';

  let { compact = false, wide = false } = $props();
  let open = $state(false);
  let root = $state();
  let trigger = $state();
  let menuItems = $state([]);
  let focusedIndex = $state(0);
  let currentLocale = $derived($locale);
  let current = $derived(LOCALES.find((item) => item.code === currentLocale) ?? LOCALES[0]);

  function close(restoreFocus = false) {
    open = false;
    if (restoreFocus) queueMicrotask(() => trigger?.focus());
  }

  function focusItem(index) {
    focusedIndex = (index + LOCALES.length) % LOCALES.length;
    queueMicrotask(() => menuItems[focusedIndex]?.focus());
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    focusedIndex = Math.max(0, LOCALES.findIndex((item) => item.code === currentLocale));
    open = true;
    focusItem(focusedIndex);
  }

  function choose(code) {
    setLocale(code);
    close(true);
  }

  function handleKeydown(event) {
    if (!open) return;
    const navigation = {
      ArrowDown: focusedIndex + 1,
      ArrowUp: focusedIndex - 1,
      Home: 0,
      End: LOCALES.length - 1,
    }[event.key];
    if (navigation !== undefined) {
      event.preventDefault();
      focusItem(navigation);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  }

  function dismissOutside(event) {
    if (open && !root?.contains(event.target)) close();
  }
</script>

<svelte:window onkeydown={handleKeydown} onpointerdown={dismissOutside} onfocusin={dismissOutside} />

<div bind:this={root} class="locale-menu" class:wide>
  <Button
    bind:element={trigger}
    class="locale-trigger"
    variant="ghost"
    size="compact"
    type="button"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$t('shell.languageCurrent', { name: current.name })}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"></path>
    </svg>
    {#if !compact}<span>{current.name}</span>{/if}
    <span class="chevron" aria-hidden="true">⌄</span>
  </Button>

  {#if open}
    <ul role="menu" aria-label={$t('shell.languageMenu')}>
      {#each LOCALES as item, index (item.code)}
        <li role="presentation">
          <Button
            variant="ghost"
            size="compact"
          type="button"
          bind:element={menuItems[index]}
          role="menuitemradio"
          tabindex={focusedIndex === index ? 0 : -1}
            aria-checked={item.code === currentLocale}
            class={item.code === currentLocale ? 'active' : undefined}
            onclick={() => choose(item.code)}
          >
            <span>{item.name}</span>
            {#if item.code === currentLocale}<span aria-hidden="true">●</span>{/if}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .locale-menu {
    position: relative;
  }

  .locale-menu.wide {
    width: 100%;
  }

  :global(.locale-trigger) {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0 0.65rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    font-size: 0.7rem;
  }

  :global(.locale-trigger:hover) {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .wide :global(.locale-trigger) {
    width: 100%;
    justify-content: flex-start;
  }

  .wide .chevron {
    margin-inline-start: auto;
  }

  svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .chevron {
    color: var(--text-faint);
  }

  ul {
    position: absolute;
    z-index: 80;
    top: calc(100% + 0.3rem);
    inset-inline-end: 0;
    min-width: 10.5rem;
    padding: 0.25rem;
    margin: 0;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    box-shadow: var(--shadow);
    list-style: none;
  }

  .wide ul {
    inset-inline: 0;
    min-width: 0;
  }

  li :global(.shimpz-button) {
    display: flex;
    width: 100%;
    min-height: 2.25rem;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.6rem;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.7rem;
    text-align: start;
  }

  li :global(.shimpz-button:hover),
  li :global(.shimpz-button.active) {
    background: var(--surface-3);
    color: var(--accent);
  }
</style>
