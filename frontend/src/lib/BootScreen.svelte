<script>
  import { ShimpzBrand } from '@shimpz/frontend';

  let { label = 'Loading…' } = $props();
</script>

<section class="boot-screen" data-slot="boot-screen" role="status" aria-live="polite">
  <span class="sr-only">{label}</span>
  <div class="boot-mark" data-slot="boot-mark" aria-hidden="true">
    <ShimpzBrand variant="symbol" decorative />
  </div>
  <div class="binary-loader" data-slot="binary-loader" aria-hidden="true">
    <span class="binary-column binary-column-left">
      <i>0</i>
      <i>1</i>
      <i>0</i>
    </span>
    <span class="binary-column binary-column-right">
      <i>1</i>
      <i>0</i>
      <i>1</i>
    </span>
  </div>
</section>

<style>
  .boot-screen {
    position: fixed;
    z-index: 10000;
    inset: 0;
    min-width: 320px;
    min-height: 100dvh;
    overflow: hidden;
    background: var(--shimpz-color-bg);
  }

  .boot-mark {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    place-items: center;
    transform: translate(-50%, -50%);
  }

  .boot-mark :global([data-slot='shimpz-brand-mark']) {
    width: clamp(5rem, 14vw, 7.5rem);
    height: clamp(5rem, 14vw, 7.5rem);
  }

  .binary-loader {
    --size: 0.95px;

    position: absolute;
    top: calc(50% + clamp(3.75rem, 10vw, 5.25rem));
    left: 50%;
    width: calc(45 * var(--size));
    height: calc(150 * var(--size));
    transform: translateX(-50%);
  }

  .binary-column {
    position: absolute;
    top: 0;
    left: 50%;
    display: grid;
    grid-auto-rows: calc(15 * var(--size));
    gap: calc(35 * var(--size));
    color: #fff;
    font-family: var(--shimpz-font-mono);
    font-size: calc(14 * var(--size));
    font-weight: 600;
    line-height: 1;
    will-change: transform;
  }

  .binary-column i {
    display: grid;
    width: calc(15 * var(--size));
    height: calc(15 * var(--size));
    place-items: center;
    font-style: normal;
    font-variant-numeric: tabular-nums;
  }

  .binary-column-left {
    transform: translateX(calc(15 * var(--size)));
    animation: binary-left 1s infinite ease-in-out;
  }

  .binary-column-right {
    transform: translateX(calc(-15 * var(--size)));
    animation: binary-right 1.1s infinite ease-in-out;
  }

  @keyframes binary-right {
    0%,
    100% {
      transform: translateX(calc(-15 * var(--size)));
    }
    50% {
      transform: translateX(calc(15 * var(--size)));
    }
  }

  @keyframes binary-left {
    0%,
    100% {
      transform: translateX(calc(15 * var(--size)));
    }
    50% {
      transform: translateX(calc(-15 * var(--size)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .binary-column-left,
    .binary-column-right {
      animation: none !important;
    }
  }
</style>
