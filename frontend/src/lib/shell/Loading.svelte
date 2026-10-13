<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then an orb in a vortex of particles (still when motion is reduced) and, for screen
  // readers, `label` in the status region that was already in place.
  let { label, delay = 150 } = $props();
  let shown = $state(false);

  onMount(() => {
    const timer = setTimeout(() => (shown = true), delay);
    return () => clearTimeout(timer);
  });

  // The vortex, fixed so every load draws the same: each particle orbits at its own radius (rem), the inner ones
  // faster, and breathes in and out on its own beat, so together they trace spirals; four segments make its comet tail.
  const COLORS = ['var(--shimpz-color-cyan)', 'var(--shimpz-color-cyan)', 'var(--orb-spark)', 'var(--shimpz-color-magenta)'];
  const PARTICLES = Array.from({ length: 28 }, (_, index) => {
    const radius = 1.25 + 1.55 * ((index * 0.618034) % 1);
    const orbit = 1.5 * (radius / 1.25) ** 1.5;
    return {
      radius,
      orbit,
      breath: 1.1 + (index % 5) * 0.32,
      phase: -orbit * (index / 28),
      size: 2 + (index % 3),
      color: COLORS[index % COLORS.length],
    };
  });
  const TAIL = [0, 1, 2, 3];
</script>

<div class="page-loading" role="status">
  {#if shown}
    <span class="sr-only">{label}</span>
    <div class="orb" aria-hidden="true">
      <span class="plasma"></span>
      {#each PARTICLES as particle, index (index)}
        <span
          class="particle"
          style:--radius={particle.radius}
          style:--orbit="{particle.orbit}s"
          style:--breath="{particle.breath}s"
          style:--phase="{particle.phase}s"
          style:--size="{particle.size}px"
          style:--color={particle.color}
        >
          {#each TAIL as segment (segment)}<span class="segment" style:--segment={segment}><i></i></span>{/each}
        </span>
      {/each}
      <span class="trace"></span>
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
    --orb-spark: color-mix(in srgb, #fff 70%, var(--shimpz-color-cyan));
    position: relative;
    width: 6.5rem;
    height: 6.5rem;
    animation: orb-in var(--shimpz-duration) var(--shimpz-ease) both;
  }

  /* An orb is round: none of its layers takes the shell's light corner rounding. */
  .orb span,
  .orb i {
    position: absolute;
    border-radius: 50%;
  }

  /* A soft plasma that swirls behind the core. */
  .plasma {
    inset: 22%;
    background: conic-gradient(
      from 0deg,
      color-mix(in srgb, var(--shimpz-color-cyan) 40%, transparent),
      transparent 30%,
      color-mix(in srgb, var(--shimpz-color-magenta) 35%, transparent) 55%,
      transparent 80%,
      color-mix(in srgb, var(--shimpz-color-cyan) 40%, transparent)
    );
    filter: blur(10px);
    animation: orb-spin 3.2s linear infinite;
  }

  /* Each particle orbits the centre; its tail segments trail it by a few degrees each, smaller and fainter. */
  .particle {
    inset: 0;
    animation: orb-spin var(--orbit) linear var(--phase) infinite;
    will-change: transform;
  }

  .segment {
    inset: 0;
    transform: rotate(calc(var(--segment) * -4deg));
  }

  .segment i {
    top: 50%;
    left: 50%;
    width: calc(var(--size) * (1 - var(--segment) * 0.18));
    height: calc(var(--size) * (1 - var(--segment) * 0.18));
    margin: calc(var(--size) / -2);
    background: var(--color);
    box-shadow: 0 0 4px var(--color), 0 0 10px var(--color);
    opacity: calc(1 - var(--segment) * 0.26);
    animation: orb-breath var(--breath) ease-in-out var(--phase) infinite alternate;
  }

  /* The outer trace: a cyan-to-magenta arc that runs around the vortex. */
  .trace {
    inset: 0;
    background: conic-gradient(
      transparent 0deg,
      transparent 200deg,
      var(--shimpz-color-cyan) 300deg,
      var(--shimpz-color-magenta) 360deg
    );
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent));
    mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
    opacity: 0.8;
    animation: orb-spin 1.4s linear infinite;
  }

  /* The core: a glowing sphere lit from its upper left, crossed by scanlines. */
  .core {
    inset: 36%;
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

  @keyframes orb-breath {
    from {
      transform: translateX(calc(var(--radius) * 1rem)) scale(1);
    }
    to {
      transform: translateX(calc(var(--radius) * 0.72rem)) scale(0.55);
    }
  }

  @keyframes orb-pulse {
    0%,
    100% {
      transform: scale(0.88);
      opacity: 0.85;
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
    .orb span,
    .orb i {
      animation: none;
    }

    .segment i {
      transform: translateX(calc(var(--radius) * 1rem));
    }

    .segment:not(:first-child) {
      display: none;
    }
  }
</style>
