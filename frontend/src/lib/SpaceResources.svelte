<script>
  import { onMount } from 'svelte';
  import { locale, t } from '#lib/i18n.js';
  import { backgroundFetch } from '#lib/localApi.js';
  import { fetchSpaceResources, resourceSegments, resourceStatus } from '#lib/spaceResources.js';

  // What leads the status line, such as the Admin version; it shows even while the status is unknown.
  let { lead } = $props();
  const INTERVAL_MS = 30_000;
  let resources = $state(null);
  let pending = false;
  let status = $derived(resources ? resourceStatus(resources) : null);
  // The numbers behind the status, read on hover: services, memory, and storage.
  let details = $derived(
    resources
      ? resourceSegments(resources, $locale, $t).map((segment) => `${segment.label} ${segment.value ?? '—'}`).join(' · ')
      : '',
  );

  // One read at a time and only while the page is visible: a hidden page or a read still pending skips its turn.
  async function refresh() {
    if (pending || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      resources = await fetchSpaceResources(backgroundFetch);
    } catch {
      resources = null;
    } finally {
      pending = false;
    }
  }

  onMount(() => {
    refresh();
    const timer = setInterval(refresh, INTERVAL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  });
</script>

<div class="space-status {status?.level ?? 'unknown'}" title={details || undefined}>
  <div class="line">
    {@render lead?.()}
    {#if status}<span class="message"><span class="dot" aria-hidden="true"></span>{$t(status.message)}</span>{/if}
  </div>
  {#if status}<span class="bar" aria-hidden="true"></span>{/if}
</div>

<style>
  .space-status {
    --signal: var(--shimpz-color-cyan);
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding: 0.25rem var(--gap-group) 1.25rem;
  }
  .space-status.warn { --signal: var(--shimpz-color-yellow); }
  .space-status.alert { --signal: var(--shimpz-color-danger); }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: center;
    gap: 0.35rem 0.6rem;
    margin: 0;
  }
  .line :global(.platform-release) { min-height: 0; padding: 0; border: 0; font-size: 0.64rem; letter-spacing: 0.06em; }
  .line :global(.platform-release .indicator) { display: none; }
  .message {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--signal);
    font: 700 0.64rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.06em;
    text-shadow: 0 0 6px color-mix(in srgb, var(--signal) 50%, transparent);
    text-transform: uppercase;
  }
  .dot {
    flex: 0 0 auto;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--signal);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 22%, transparent), 0 0 8px var(--signal);
    animation: pulse 2.4s ease-in-out infinite;
  }
  .bar {
    height: 4px;
    background: repeating-linear-gradient(90deg, var(--signal) 0 6px, transparent 6px 8px);
    filter: drop-shadow(0 0 3px var(--signal));
  }
  @keyframes pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
</style>
