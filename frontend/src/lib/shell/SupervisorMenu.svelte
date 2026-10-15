<script>
  import { DropdownMenu } from '@shimpz/frontend';
  import { t } from '#lib/i18n/index.js';

  // The Supervisor's menu, the same menu as the language one: an avatar listing the Supervisor's actions.
  let { onsecurity } = $props();
  let items = $derived([{ value: 'security', label: $t('security.open') }]);
</script>

<DropdownMenu
  class="supervisor-menu"
  {items}
  ariaLabel={$t('shell.supervisorMenu')}
  menuLabel={$t('shell.supervisorMenu')}
  triggerLabel={$t('shell.supervisorMenu')}
  compact
  onSelect={(value) => value === 'security' && onsecurity()}
>
  {#snippet triggerIcon()}
    <span class="avatar">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6"></circle><path d="M5 20c.9-3.6 3.6-5.6 7-5.6s6.1 2 7 5.6"></path></svg>
    </span>
  {/snippet}
</DropdownMenu>

<style>
  /* The same surface as the Team list's new-Team button: transparent, with the rows' tint on hover. */
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button) {
    --button-height: 2.75rem;
    position: relative;
    isolation: isolate;
    width: 2.75rem;
    height: 2.75rem;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    clip-path: none;
    box-shadow: none;
  }
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button::before) { content: ""; position: absolute; z-index: -1; inset: 0; clip-path: var(--shimpz-control-shape); pointer-events: none; }
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button:hover:not(:disabled)),
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button:focus-visible) { border: 0; background: transparent; box-shadow: none; }
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button:hover:not(:disabled)::before),
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button:focus-visible::before),
  :global(.supervisor-menu.shimpz-dropdown > .trigger.shimpz-button[aria-expanded='true']::before) { background: var(--team-hover-bg); }
  :global(.supervisor-menu .chevron) { display: none; }
  :global(.supervisor-menu .trigger-icon) { display: grid; place-items: center; }
  /* The avatar is the bare user glyph. */
  .avatar {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
  }
  .avatar svg {
    width: 1.35rem;
    height: 1.35rem;
    fill: none;
    stroke: var(--shimpz-color-cyan);
    stroke-width: 1.7;
    stroke-linecap: round;
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--shimpz-color-cyan) 60%, transparent));
  }
  :global(.supervisor-menu .trigger:hover .trigger-icon),
  :global(.supervisor-menu .trigger:focus-visible .trigger-icon),
  :global(.supervisor-menu .trigger[aria-expanded='true'] .trigger-icon) {
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent));
  }
</style>
