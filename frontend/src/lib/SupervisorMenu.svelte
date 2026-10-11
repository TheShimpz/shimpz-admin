<script>
  import { Button } from '@shimpz/frontend';
  import { t } from '#lib/i18n.js';

  // The Supervisor's account menu: an avatar that discloses the account's actions, today its sign-in security.
  let { onsecurity, element = $bindable() } = $props();
  const panelId = $props.id();
  let panel = $state();
  let open = $state(false);
  let first = $state();

  // The browser's popover gives Escape and outside-click dismissal; this places it under the avatar and focuses it.
  function toggled(event) {
    open = event.newState === 'open';
    if (!open || !element) return;
    const box = element.getBoundingClientRect();
    panel.style.setProperty('--menu-top', `${box.bottom + 6}px`);
    panel.style.setProperty('--menu-left', `${box.left}px`);
    queueMicrotask(() => first?.focus());
  }

  function choose(action) {
    panel?.hidePopover();
    action?.();
  }
</script>

<Button
  bind:element
  class="supervisor-account"
  variant="ghost"
  size="sm"
  iconOnly
  type="button"
  aria-label={$t('shell.supervisorMenu')}
  aria-expanded={open}
  aria-controls={panelId}
  popovertarget={panelId}
  title={$t('shell.supervisorMenu')}
>
  <span class="avatar">
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6"></circle><path d="M5 20c.9-3.6 3.6-5.6 7-5.6s6.1 2 7 5.6"></path></svg>
  </span>
  <span class="presence" aria-hidden="true"></span>
</Button>

<div bind:this={panel} id={panelId} class="account-panel" popover="auto" ontoggle={toggled}>
  <p class="account-title">{$t('shell.supervisorMenu')}</p>
  <ul>
    <li>
      <Button bind:element={first} class="account-action" variant="ghost" size="sm" type="button" aria-haspopup="dialog" onclick={() => choose(onsecurity)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"></path></svg>
        {$t('security.open')}
      </Button>
    </li>
  </ul>
</div>

<style>
  :global(.shimpz-button.supervisor-account) {
    --button-height: 2.75rem;
    position: relative;
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    clip-path: none;
    box-shadow: none;
    cursor: pointer;
  }
  :global(.shimpz-button.supervisor-account:hover:not(:disabled)),
  :global(.shimpz-button.supervisor-account:focus-visible) { border: 0; background: none; box-shadow: none; }
  .avatar {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    overflow: hidden;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--shimpz-color-cyan) 14%, var(--shimpz-color-surface-raised)), var(--shimpz-color-surface-raised) 70%);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    transition: box-shadow 160ms ease;
  }
  .avatar svg,
  .account-panel svg {
    width: 1.35rem;
    height: 1.35rem;
    fill: none;
    stroke: var(--shimpz-color-cyan);
    stroke-width: 1.7;
    stroke-linecap: round;
  }
  .avatar svg { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--shimpz-color-cyan) 60%, transparent)); }
  :global(.supervisor-account:hover) .avatar,
  :global(.supervisor-account:focus-visible) .avatar,
  :global(.supervisor-account[aria-expanded='true']) .avatar {
    box-shadow:
      0 0 0 2px var(--shimpz-color-cyan),
      0 0 12px color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent);
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
  .account-panel {
    position: fixed;
    inset: var(--menu-top, 4rem) auto auto var(--menu-left, 1rem);
    width: 14rem;
    margin: 0;
    padding: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 35%, transparent);
    background: var(--shimpz-color-surface);
    box-shadow: 0 0 18px color-mix(in srgb, var(--shimpz-color-cyan) 18%, transparent);
    color: var(--shimpz-color-text);
  }
  .account-title {
    margin: 0;
    padding: 0.35rem 0.5rem 0.55rem;
    border-block-end: 1px solid var(--shimpz-color-border-subtle);
    color: var(--shimpz-color-text-dim);
    font: 700 0.62rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  ul { display: grid; gap: 0.15rem; margin: 0.4rem 0 0; padding: 0; list-style: none; }
  :global(.shimpz-button.account-action) { justify-content: flex-start; width: 100%; }
  .account-panel svg { width: 1rem; height: 1rem; }
  @media (prefers-reduced-motion: reduce) { .avatar { transition: none; } }
</style>
