<script>
  import { t } from '#lib/i18n/index.js';

  // An Assistant's provenance, Creator and version beside its name on an install or uninstall card: Local in the
  // Store's yellow.
  let { local, creator, version } = $props();
</script>

{#if local}<span class="assistant-meta-local">{$t('store').localBadge}</span><span class="assistant-meta-separator" aria-hidden="true">·</span>{/if}{creator}<span class="assistant-meta-separator" aria-hidden="true">·</span>v{version}

<style>
  :global(.assistant-meta-separator) { margin-inline: 0.45em; }
  :global(.assistant-meta-local) {
    color: var(--shimpz-color-yellow);
    font-weight: 700;
    font-size: 0.6rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
</style>
