<script>
  import { Button, ShimpzBrand } from '@shimpz/frontend';
  import { t } from '#lib/i18n.js';

  // The Supervisor's account: the Shimpz symbol as an avatar that opens the account's sign-in security.
  let { onsecurity, element = $bindable() } = $props();
</script>

<Button
  bind:element
  class="supervisor-account"
  variant="ghost"
  size="sm"
  iconOnly
  type="button"
  aria-haspopup="dialog"
  aria-label={$t('shell.supervisorMenu')}
  title={$t('shell.supervisorMenu')}
  onclick={() => onsecurity?.()}
>
  <span class="avatar"><ShimpzBrand class="supervisor-mark" variant="symbol" decorative /></span>
  <span class="presence" aria-hidden="true"></span>
</Button>

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
    background: var(--shimpz-color-surface-raised);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    transition: box-shadow 160ms ease;
  }
  .avatar :global(.supervisor-mark img) { width: 2.5rem; height: 2.5rem; transform: scale(1.3) translate(3.5%, 4%); }
  :global(.supervisor-account:hover) .avatar,
  :global(.supervisor-account:focus-visible) .avatar {
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
  @media (prefers-reduced-motion: reduce) { .avatar { transition: none; } }
</style>
