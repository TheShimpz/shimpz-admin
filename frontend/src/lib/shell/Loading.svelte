<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then a chamfered track a cyan scan crosses (still when motion is reduced) and, for screen
  // readers, `label` in the status region that was already in place.
  let { label, delay = 150 } = $props();
  let shown = $state(false);

  onMount(() => {
    const timer = setTimeout(() => (shown = true), delay);
    return () => clearTimeout(timer);
  });
</script>

<div class="page-loading" role="status">
  {#if shown}
    <span class="sr-only">{label}</span>
    <span class="track" aria-hidden="true"><span class="scan"></span></span>
  {/if}
</div>

<style>
  .page-loading {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    place-items: center;
  }

  /* A chamfered track, which a cyan scan crosses again and again, entering and leaving it whole. */
  .track {
    position: relative;
    width: 10rem;
    height: 8px;
    overflow: hidden;
    border-radius: 0;
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 100%, 8px 100%);
    background: var(--shimpz-color-border);
    animation: loader-in var(--shimpz-duration) var(--shimpz-ease) both;
  }

  .scan {
    position: absolute;
    inset-block: 0;
    width: 35%;
    border-radius: 0;
    background: var(--shimpz-color-cyan);
    box-shadow: 0 0 6px var(--shimpz-color-cyan);
    animation: loader-scan 1.4s ease-in-out infinite;
  }

  @keyframes loader-scan {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }

  @keyframes loader-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .track,
    .scan {
      animation: none;
    }

    .scan {
      transform: translateX(75%);
    }
  }
</style>
