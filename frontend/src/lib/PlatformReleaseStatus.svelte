<script>
  import { onMount } from 'svelte';
  import packageMetadata from '../../package.json';
  import { t } from '$lib/i18n.js';
  import { fetchPlatformRelease } from '$lib/platformRelease.js';

  let status = $state(null);
  const adminVersion = packageMetadata.version;

  async function refresh() {
    try {
      status = await fetchPlatformRelease();
    } catch {
      status = null;
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  });
</script>

<div
  class:rollback={status?.outcome === 'rollback-needed'}
  class:unknown={status === null}
  class="platform-release"
  aria-live="polite"
  title={status ? $t('shell.platformOrdinal', { ordinal: status.ordinal }) : undefined}
>
  <span class="indicator" aria-hidden="true"></span>
  <span>Admin v{adminVersion}</span>
  {#if status?.outcome === 'rollback-needed'}
    <span aria-hidden="true">·</span>
    <span>{$t('shell.platformRollback')}</span>
  {/if}
</div>

<style>
  .platform-release { display: flex; align-items: center; gap: var(--shimpz-space-2); min-height: 2.75rem; padding: var(--shimpz-space-2) var(--shimpz-space-4); border-block-start: 1px solid var(--shimpz-color-border); color: var(--shimpz-color-text-muted); font: 600 0.72rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.04em; text-transform: uppercase; }
  .indicator { width: 0.5rem; height: 0.5rem; flex: 0 0 auto; border-radius: 50%; background: var(--shimpz-color-success, #35d07f); box-shadow: 0 0 0 3px color-mix(in srgb, var(--shimpz-color-success, #35d07f) 18%, transparent); }
  .unknown .indicator { background: currentColor; box-shadow: none; opacity: 0.55; }
  .rollback { color: var(--shimpz-color-danger, #ff5c7c); }
  .rollback .indicator { background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }
</style>
