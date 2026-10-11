<script>
  import { DropdownMenu } from '@shimpz/frontend';
  import { t } from '#lib/i18n.js';

  // The Supervisor's account menu, the same menu as the language one: an avatar listing the account's actions.
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
  onSelect={(value) => value === 'security' && onsecurity?.()}
>
  {#snippet triggerIcon()}
    <span class="avatar">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6"></circle><path d="M5 20c.9-3.6 3.6-5.6 7-5.6s6.1 2 7 5.6"></path></svg>
    </span>
    <span class="presence" aria-hidden="true"></span>
  {/snippet}
</DropdownMenu>

<style>
  :global(.supervisor-menu .trigger.shimpz-button) {
    --button-height: 2.75rem;
    position: relative;
    width: 2.75rem;
    height: 2.75rem;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    clip-path: none;
    box-shadow: none;
  }
  :global(.supervisor-menu .trigger.shimpz-button:hover:not(:disabled)),
  :global(.supervisor-menu .trigger.shimpz-button:focus-visible) { border: 0; background: none; box-shadow: none; }
  :global(.supervisor-menu .chevron) { display: none; }
  :global(.supervisor-menu .trigger-icon) { display: grid; place-items: center; }
  /* The avatar is a control like the others: chamfered corners and the shared corner rounding. */
  .avatar {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    border-radius: var(--shimpz-radius, 0);
    background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--shimpz-color-cyan) 14%, var(--shimpz-color-surface-raised)), var(--shimpz-color-surface-raised) 70%);
    clip-path: var(--shimpz-control-shape);
    transition: border-color 160ms ease;
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
  :global(.supervisor-menu .trigger:hover) .avatar,
  :global(.supervisor-menu .trigger:focus-visible) .avatar,
  :global(.supervisor-menu .trigger[aria-expanded='true']) .avatar { border-color: var(--shimpz-color-cyan); }
  :global(.supervisor-menu .trigger:hover .trigger-icon),
  :global(.supervisor-menu .trigger:focus-visible .trigger-icon),
  :global(.supervisor-menu .trigger[aria-expanded='true'] .trigger-icon) {
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent));
  }
  .presence {
    position: absolute;
    inset: auto 0.1rem 0.1rem auto;
    width: 0.6rem;
    height: 0.6rem;
    border: 2px solid var(--shimpz-color-bg);
    border-radius: 50%;
    background: var(--shimpz-color-success, #35d07f);
  }
  @media (prefers-reduced-motion: reduce) { .avatar { transition: none; } }
</style>
