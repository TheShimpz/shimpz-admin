<script>
  import { ShimpzBrand } from '@shimpz/frontend';

  let { label = 'Loading…' } = $props();
  const letters = [...'SHIMPZ'];
</script>

<section class="boot-screen" data-slot="boot-screen" role="status" aria-live="polite">
  <span class="sr-only" data-slot="boot-label">{label}</span>
  <div class="boot-composition" data-slot="boot-composition" aria-hidden="true">
    <div class="boot-mark" data-slot="boot-mark">
      <ShimpzBrand variant="symbol" decorative />
    </div>
    <span class="boot-wordmark" data-slot="boot-wordmark">{#each letters as letter}<span class="boot-letter" data-slot="boot-letter">{letter}</span>{/each}</span>
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
    --mark-size: clamp(5rem, 14vw, 7.5rem);
    --swing: 4.75px;

    display: grid;
    justify-items: center;
    gap: 0.175rem;
    direction: ltr;
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
    display: grid;
    grid-auto-flow: column;
    padding-block: var(--swing);
    padding-inline-start: 0.15em;
    color: #fff;
    font-family: var(--shimpz-font-mono);
    font-size: calc(var(--mark-size) / 5);
    font-weight: 700;
    letter-spacing: 0.15em;
    line-height: 1;
  }

  .boot-letter {
    transform: translateY(var(--swing));
    animation: letter-swing 1s infinite ease-in-out;
  }

  .boot-letter:nth-child(even) {
    transform: translateY(calc(-1 * var(--swing)));
    animation-delay: -0.5s;
  }

  @keyframes letter-swing {
    0%,
    100% {
      transform: translateY(var(--swing));
    }
    50% {
      transform: translateY(calc(-1 * var(--swing)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .boot-letter {
      animation: none !important;
      transform: none !important;
    }
  }
</style>
