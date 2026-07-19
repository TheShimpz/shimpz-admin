<script>
  import { locale, setLocale, LOCALES } from '$lib/i18n.js';

  let { compact = false, wide = false } = $props();
  let open = $state(false);
  let currentLocale = $derived($locale);
  let current = $derived(LOCALES.find((item) => item.code === currentLocale) ?? LOCALES[0]);

  function choose(code) {
    setLocale(code);
    open = false;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="locale-menu" class:wide>
  <button
    class="locale-trigger"
    type="button"
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`Language: ${current.name}`}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"></path>
    </svg>
    {#if !compact}<span>{current.name}</span>{/if}
    <span class="chevron" aria-hidden="true">⌄</span>
  </button>

  {#if open}
    <ul role="menu" aria-label="Language">
      {#each LOCALES as item (item.code)}
        <li role="presentation">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={item.code === currentLocale}
            class:active={item.code === currentLocale}
            onclick={() => choose(item.code)}
          >
            <span>{item.name}</span>
            {#if item.code === currentLocale}<span aria-hidden="true">●</span>{/if}
          </button>
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

  button {
    min-height: 2.75rem;
    border: 0;
    color: var(--text);
    cursor: pointer;
    font-family: var(--font-mono);
  }

  .locale-trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.8rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    font-size: 0.75rem;
  }

  .locale-trigger:hover {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .wide .locale-trigger {
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
    top: calc(100% + 0.45rem);
    inset-inline-end: 0;
    min-width: 10.5rem;
    padding: 0.35rem;
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

  li button {
    display: flex;
    width: 100%;
    min-height: 2.5rem;
    align-items: center;
    justify-content: space-between;
    padding: 0 0.7rem;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.75rem;
    text-align: start;
  }

  li button:hover,
  li button.active {
    background: var(--surface-3);
    color: var(--accent);
  }
</style>
