<script>
  let {
    variant = 'compact',
    product = 'Admin',
    href = '/',
    ariaLabel = 'Shimpz Admin home',
  } = $props();
</script>

<a
  class:hero={variant === 'hero'}
  class:symbol-only={variant === 'symbol'}
  class="brand-lockup"
  {href}
  aria-label={ariaLabel}
>
  <span class="brand-symbol" aria-hidden="true">
    <img src="/brand/shimpz-thinking.svg" alt="" />
    <span class="reflection"></span>
  </span>
  {#if variant !== 'symbol'}
    <span class="brand-type">
      <span class="wordmark">Shimpz</span>
      {#if product}<span class="product">{product}</span>{/if}
    </span>
  {/if}
</a>

<style>
  .brand-lockup {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 0.7rem;
    color: var(--text);
    text-decoration: none;
  }

  .brand-symbol {
    position: relative;
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    overflow: hidden;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    mix-blend-mode: screen;
    object-fit: contain;
  }

  .reflection {
    position: absolute;
    inset: 0;
    background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.78) 50%, transparent 65%);
    content: '';
    opacity: 0;
    pointer-events: none;
    transform: translateX(-135%);
    -webkit-mask: url('/brand/shimpz-thinking.svg') center / contain no-repeat;
    mask: url('/brand/shimpz-thinking.svg') center / contain no-repeat;
  }

  .brand-lockup:hover .reflection,
  .brand-lockup:focus-visible .reflection {
    animation: glass-reflection 0.8s ease-out;
  }

  .brand-type {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 0.6rem;
  }

  .wordmark {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.055em;
  }

  .product {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .hero {
    gap: clamp(1rem, 3vw, 2rem);
    pointer-events: none;
  }

  .hero .brand-symbol {
    width: clamp(7rem, 18vw, 11rem);
    height: clamp(7rem, 18vw, 11rem);
  }

  .symbol-only .brand-symbol {
    width: clamp(8rem, 18vw, 13rem);
    height: clamp(8rem, 18vw, 13rem);
    filter: drop-shadow(0 0 1.2rem rgba(0, 240, 255, 0.14));
  }

  @keyframes glass-reflection {
    0% { opacity: 0; transform: translateX(-135%); }
    22% { opacity: 0.72; }
    78% { opacity: 0.5; }
    100% { opacity: 0; transform: translateX(135%); }
  }

  .hero .brand-type {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.65rem;
  }

  .hero .wordmark {
    font-size: clamp(2.4rem, 7vw, 4.5rem);
    letter-spacing: -0.075em;
  }

  .hero .product {
    color: var(--accent);
    font-size: clamp(0.66rem, 1.4vw, 0.82rem);
    letter-spacing: 0.24em;
  }

  @media (max-width: 520px) {
    .brand-lockup:not(.hero) .product {
      display: none;
    }

    .hero {
      align-items: center;
      flex-direction: column;
      text-align: center;
    }

    .hero .brand-type {
      align-items: center;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .brand-lockup:hover .reflection,
    .brand-lockup:focus-visible .reflection {
      animation: none;
    }
  }
</style>
