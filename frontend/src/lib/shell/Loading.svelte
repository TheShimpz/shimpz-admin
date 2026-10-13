<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then a pulsing orb inside a spinning trace (still when motion is reduced) and, for screen
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
    <div class="orb" aria-hidden="true">
      <span class="trace"></span>
      <span class="ring"></span>
      <span class="core"></span>
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

  .orb {
    position: relative;
    display: grid;
    width: 4rem;
    height: 4rem;
    place-items: center;
    animation: orb-in var(--shimpz-duration) var(--shimpz-ease) both;
  }

  /* An orb is round: none of its layers takes the shell's light corner rounding. */
  .orb > span {
    position: absolute;
    border-radius: 50%;
  }

  /* The outer trace: a cyan-to-magenta arc that runs around the orb. */
  .trace {
    inset: 0;
    background: conic-gradient(
      transparent 0deg,
      transparent 150deg,
      var(--shimpz-color-cyan) 260deg,
      var(--shimpz-color-magenta) 360deg
    );
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    animation: orb-spin 1.2s linear infinite;
  }

  /* The inner ring, dashed, turning the other way. */
  .ring {
    inset: 18%;
    border: 1px dashed color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    animation: orb-spin 6s linear infinite reverse;
  }

  /* The core: a glowing sphere lit from its upper left, crossed by scanlines. */
  .core {
    inset: 30%;
    background:
      repeating-linear-gradient(to bottom, transparent 0 2px, color-mix(in srgb, #000 22%, transparent) 2px 3px),
      radial-gradient(
        circle at 35% 30%,
        color-mix(in srgb, #fff 85%, var(--shimpz-color-cyan)) 0 6%,
        var(--shimpz-color-cyan) 28%,
        color-mix(in srgb, var(--shimpz-color-cyan) 45%, var(--shimpz-color-magenta)) 62%,
        var(--shimpz-color-magenta) 100%
      );
    box-shadow:
      0 0 12px color-mix(in srgb, var(--shimpz-color-cyan) 70%, transparent),
      0 0 28px color-mix(in srgb, var(--shimpz-color-magenta) 35%, transparent);
    animation: orb-pulse 1.6s var(--shimpz-ease) infinite;
  }

  @keyframes orb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes orb-pulse {
    0%,
    100% {
      transform: scale(0.88);
      opacity: 0.8;
    }
    50% {
      transform: scale(1);
      opacity: 1;
    }
  }

  @keyframes orb-in {
    from {
      opacity: 0;
      transform: scale(0.92);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .orb,
    .orb > span {
      animation: none;
    }
  }
</style>
