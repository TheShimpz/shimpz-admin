<script>
  import { onMount } from 'svelte';

  // A page's own loading indicator, centred in the area it fills: nothing for the first moment, so a load that ends
  // within it never flashes, then an animated trace (static when motion is reduced) and, for screen readers, `label`
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
    <span class="sr-only">{label}</span>
    <div class="loader" aria-hidden="true">
      <span class="trace"></span>
      <span class="core">
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </span>
    </div>
  {/if}
</div>

<style>
  @property --loader-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }

  .page-loading {
    display: grid;
    width: 100%;
    height: 100%;
    min-height: 0;
    place-items: center;
  }

  .loader {
    --size: 3.5rem;
    --cut: var(--shimpz-cut-lg);
    --shape: polygon(
      var(--cut) 0,
      100% 0,
      100% calc(100% - var(--cut)),
      calc(100% - var(--cut)) 100%,
      0 100%,
      0 var(--cut)
    );
    position: relative;
    display: grid;
    width: var(--size);
    height: var(--size);
    place-items: center;
    animation: loader-in var(--shimpz-duration) var(--shimpz-ease) both;
    filter: drop-shadow(0 0 10px color-mix(in srgb, var(--shimpz-color-cyan) 22%, transparent));
  }

  /* The chamfered frame: a cyan-to-magenta trace runs around it over a faint scanlined plate. */
  .trace {
    position: absolute;
    inset: 0;
    clip-path: var(--shape);
    background: conic-gradient(
      from var(--loader-angle),
      transparent 0deg,
      var(--shimpz-color-cyan) 70deg,
      var(--shimpz-color-magenta) 140deg,
      transparent 200deg,
      transparent 360deg
    );
    animation: loader-trace 1.4s linear infinite;
  }

  .trace::after {
    position: absolute;
    inset: 1.5px;
    clip-path: var(--shape);
    background:
      repeating-linear-gradient(
        to bottom,
        color-mix(in srgb, var(--shimpz-color-cyan) 6%, transparent) 0 1px,
        transparent 1px 3px
      ),
      var(--shimpz-color-surface);
    content: '';
  }

  .core {
    position: relative;
    display: flex;
    height: 38%;
    align-items: flex-end;
    gap: 3px;
  }

  .bar {
    width: 4px;
    height: 100%;
    clip-path: polygon(0 2px, 2px 0, 100% 0, 100% 100%, 0 100%);
    background: var(--shimpz-color-cyan);
    box-shadow: 0 0 6px color-mix(in srgb, var(--shimpz-color-cyan) 60%, transparent);
    transform-origin: bottom;
    animation: loader-bar 0.9s var(--shimpz-ease) infinite;
  }

  .bar:nth-child(2) {
    background: var(--shimpz-color-magenta);
    animation-delay: -0.3s;
  }

  .bar:nth-child(3) {
    animation-delay: -0.6s;
  }

  @keyframes loader-trace {
    to {
      --loader-angle: 360deg;
    }
  }

  @keyframes loader-bar {
    0%,
    100% {
      transform: scaleY(0.3);
      opacity: 0.55;
    }
    50% {
      transform: scaleY(1);
      opacity: 1;
    }
  }

  @keyframes loader-in {
    from {
      opacity: 0;
      transform: scale(0.92);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loader,
    .trace,
    .bar {
      animation: none;
    }

    .trace {
      --loader-angle: 300deg;
    }

    .bar {
      transform: scaleY(0.65);
    }
  }
</style>
