<script>
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n.js';
  import { fetchPlatformRelease } from '$lib/platformRelease.js';

  let status = $state(null);

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

{#if status}
  <div
    class:rollback={status.outcome === 'rollback-needed'}
    class="platform-release"
    aria-live="polite"
    title={$t('shell.platformOrdinal', { ordinal: status.ordinal })}
  >
    <span class="indicator" aria-hidden="true"></span>
    <span>{status.outcome === 'rollback-needed' ? $t('shell.platformRollback') : $t('shell.platformCurrent')}</span>
  </div>
{/if}

<style>
  .platform-release { display: flex; align-items: center; gap: var(--shimpz-space-2); min-height: 2.75rem; padding: var(--shimpz-space-2) var(--shimpz-space-4); border-block-start: 1px solid var(--shimpz-color-border); color: var(--shimpz-color-text-muted); font: 600 0.72rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.04em; text-transform: uppercase; }
  .indicator { width: 0.5rem; height: 0.5rem; flex: 0 0 auto; border-radius: 50%; background: var(--shimpz-color-success, #35d07f); box-shadow: 0 0 0 3px color-mix(in srgb, var(--shimpz-color-success, #35d07f) 18%, transparent); }
  .rollback { color: var(--shimpz-color-danger, #ff5c7c); }
  .rollback .indicator { background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }
</style>
