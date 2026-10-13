<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then `label`, glitching, over a chamfered track a cyan scan crosses (still when motion is reduced),
  // in the status region that was already in place.
  let { label, delay = 150 } = $props();
  let shown = $state(false);

  onMount(() => {
    const timer = setTimeout(() => (shown = true), delay);
    return () => clearTimeout(timer);
  });
</script>

<div class="page-loading" role="status">
  {#if shown}
    <div class="loader">
      <span class="label">{label}</span>
      <span class="track" aria-hidden="true"><span class="scan"></span></span>
    </div>
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

  .loader {
    display: grid;
    justify-items: center;
    gap: var(--gap-item);
    animation: loader-in var(--shimpz-duration) var(--shimpz-ease) both;
  }

  /* The label glitches as the controls do (the design system's shimpz-control-glitch-content), twice as often. */
  .label {
    animation: shimpz-control-glitch-content 2.4s 175ms infinite steps(1, end);
    color: var(--shimpz-color-text-muted);
    font: 700 0.72rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-align: center;
    text-transform: uppercase;
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
  }

  /* The scan has the track's slant and fades in from its tail to a bright head. */
  .scan {
    position: absolute;
    inset-block: 0;
    width: 35%;
    border-radius: 0;
    clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 100%, 8px 100%);
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent) 60%,
      var(--shimpz-color-cyan)
    );
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
    .loader,
    .label,
    .scan {
      animation: none;
    }

    .scan {
      transform: translateX(75%);
    }
  }
</style>
