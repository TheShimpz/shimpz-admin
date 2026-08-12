<script>
  import { ShimpzBrand } from '@shimpz/frontend';

  let { label = 'Loading…' } = $props();
</script>

<section class="boot-screen" data-slot="boot-screen" role="status" aria-live="polite">
  <span class="sr-only">{label}</span>
  <div class="boot-composition" data-slot="boot-composition" aria-hidden="true">
    <div class="boot-brand" data-slot="boot-brand">
      <div class="boot-mark" data-slot="boot-mark">
        <ShimpzBrand variant="symbol" decorative />
      </div>
      <span class="boot-wordmark" data-slot="boot-wordmark">SHIMPZ</span>
    </div>
    <span class="binary-loader" data-slot="binary-loader">
      <i class="binary-glyph binary-zero" data-slot="binary-glyph">0</i>
      <i class="binary-glyph binary-one" data-slot="binary-glyph">1</i>
      <i class="binary-glyph binary-zero" data-slot="binary-glyph">0</i>
      <i class="binary-glyph binary-one" data-slot="binary-glyph">1</i>
      <i class="binary-glyph binary-zero" data-slot="binary-glyph">0</i>
      <i class="binary-glyph binary-one" data-slot="binary-glyph">1</i>
    </span>
  </div>
</section>

<style>
  .boot-screen {
    position: fixed;
    z-index: 10000;
    inset: 0;
    min-width: 320px;
    overflow: hidden;
    background: var(--shimpz-color-bg);
    display: grid;
    place-items: center;
  }

  .boot-composition {
    display: grid;
    justify-items: center;
    gap: clamp(1.225rem, 2.8vw, 1.575rem);
    direction: ltr;
  }

  .boot-brand {
    --mark-size: clamp(5rem, 14vw, 7.5rem);

    display: grid;
    justify-items: center;
    gap: 0.175rem;
  }

  .boot-mark {
    display: grid;
    place-items: center;
  }

  .boot-mark :global([data-slot='shimpz-brand-mark']) {
    width: var(--mark-size);
    height: var(--mark-size);
  }

  .boot-wordmark {
    padding-inline-start: 0.15em;
    color: #fff;
    font-family: var(--shimpz-font-mono);
    font-size: calc(var(--mark-size) / 5);
    font-weight: 700;
    letter-spacing: 0.15em;
    line-height: 1;
    text-transform: uppercase;
  }

  .binary-loader {
    --size: 0.95px;
    --glyph-size: calc(15 * var(--size));
    --glyph-advance: calc(8.4 * var(--size));
    --glyph-gap: calc(2 * var(--size));
    --swing: calc(5 * var(--size));

    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: var(--glyph-advance);
    place-items: center;
    gap: var(--glyph-gap);
    height: calc(var(--glyph-size) + (2 * var(--swing)));
  }

  .binary-glyph {
    display: grid;
    width: var(--glyph-advance);
    height: var(--glyph-size);
    place-items: center;
    color: #fff;
    font-family: var(--shimpz-font-mono);
    font-size: calc(14 * var(--size));
    font-weight: 600;
    font-style: normal;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .binary-zero {
    transform: translateY(var(--swing));
    animation: binary-swing 1s infinite ease-in-out;
  }

  .binary-one {
    transform: translateY(calc(-1 * var(--swing)));
    animation: binary-swing 1s -0.5s infinite ease-in-out;
  }

  @keyframes binary-swing {
    0%,
    100% {
      transform: translateY(var(--swing));
    }
    50% {
      transform: translateY(calc(-1 * var(--swing)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .binary-glyph {
      animation: none !important;
      transform: none !important;
    }
  }
</style>
