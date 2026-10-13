<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then `label` over a chamfered track a cyan scan crosses, both glitching (all still when
  // motion is reduced), in the status region that was already in place.
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
      <span class="glitch" aria-hidden="true"><span class="track"><span class="scan"></span></span></span>
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

  /* The label and the track glitch in quick cyan and magenta bursts, a beat apart. The track glitches through a wrapper,
     so the glitch's slices never replace the track's own shape. */
  .label {
    animation: loader-glitch 1.1s steps(1, end) infinite;
    color: var(--shimpz-color-text-muted);
    font: 700 0.72rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-align: center;
    text-transform: uppercase;
  }

  .glitch {
    display: grid;
    animation: loader-glitch 1.1s 0.12s steps(1, end) infinite;
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

  @keyframes loader-glitch {
    0%,
    18%,
    25%,
    58%,
    66%,
    100% {
      transform: translate(0);
      clip-path: inset(0);
      filter: none;
    }
    19% {
      transform: translate(-3px, 1px);
      clip-path: inset(8% 0 55%);
      filter: drop-shadow(2px 0 var(--shimpz-color-cyan));
    }
    21% {
      transform: translate(3px, -1px);
      clip-path: inset(52% 0 12%);
      filter: drop-shadow(-2px 0 var(--shimpz-color-magenta));
    }
    23% {
      transform: translate(-1px, 0);
      clip-path: inset(28% 0 34%);
      filter: drop-shadow(1px 0 var(--shimpz-color-cyan));
    }
    59% {
      transform: translate(2px, 0);
      clip-path: inset(0 0 58%);
      filter: drop-shadow(-2px 0 var(--shimpz-color-magenta));
    }
    61% {
      transform: translate(-2px, 1px);
      clip-path: inset(46% 0 0);
      filter: drop-shadow(2px 0 var(--shimpz-color-cyan));
    }
    63% {
      transform: translate(1px, 0);
      clip-path: inset(0);
      filter: drop-shadow(-1px 0 var(--shimpz-color-magenta));
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
    .glitch,
    .scan {
      animation: none;
    }

    .scan {
      transform: translateX(75%);
    }
  }
</style>
