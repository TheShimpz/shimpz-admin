<script>
  import packageMetadata from '../../package.json';
  import { t } from '#lib/i18n.js';
  import { synced } from '#lib/synced.js';
  import { fetchPlatformRelease, isDeveloperRelease } from '#lib/platformRelease.js';

  // Admin's watcher reads the release file while this status is shown and says when it changed (ADR-0114).
  const release = synced('platform/release', fetchPlatformRelease);
  let status = $derived($release.value);
  const adminVersion = packageMetadata.version;
</script>

<div
  class:rollback={status?.outcome === 'rollback-needed'}
  class:unknown={status === null}
  class="platform-release"
  aria-live="polite"
  title={status
    ? $t(isDeveloperRelease(status) ? 'shell.platformDeveloper' : 'shell.platformOrdinal', { ordinal: status.ordinal })
    : undefined}
>
  <span class="indicator" aria-hidden="true"></span>
  <span><span class="sr-only">{'Admin '}</span>v{adminVersion}</span>
  {#if status?.outcome === 'rollback-needed'}
    <span aria-hidden="true">·</span>
    <span>{$t('shell.platformRollback')}</span>
  {/if}
</div>

<style>
  .platform-release { display: flex; align-items: center; gap: var(--gap-inside); min-height: 2.75rem; padding: var(--gap-item) var(--gap-group); border-block-start: 1px solid var(--shimpz-color-border); color: var(--shimpz-color-text-muted); font: 600 0.72rem/1.2 var(--shimpz-font-mono); letter-spacing: 0.04em; text-transform: uppercase; }
  .indicator { width: 0.5rem; height: 0.5rem; flex: 0 0 auto; border-radius: 50%; background: var(--shimpz-color-success, #35d07f); box-shadow: 0 0 0 3px color-mix(in srgb, var(--shimpz-color-success, #35d07f) 18%, transparent); }
  .unknown .indicator { background: currentColor; box-shadow: none; opacity: 0.55; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .rollback { color: var(--shimpz-color-danger, #ff5c7c); }
  .rollback .indicator { background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }
</style>
