<script>
  import { DropdownMenu } from '@shimpz/frontend';
  import { locale, setLocale, LOCALES, t } from '$lib/i18n.js';

  let { compact = false, wide = false } = $props();
  let current = $derived(LOCALES.find((item) => item.code === $locale) ?? LOCALES[0]);
  let items = $derived(LOCALES.map((item) => ({ value: item.code, label: item.name })));
</script>

<DropdownMenu
  {items}
  value={$locale}
  ariaLabel={$t('shell.languageCurrent', { name: current.name })}
  menuLabel={$t('shell.languageMenu')}
  triggerLabel={current.name}
  onSelect={setLocale}
  {compact}
  {wide}
>
  {#snippet triggerIcon()}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18"></path>
    </svg>
  {/snippet}
</DropdownMenu>

<style>
  svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
</style>
