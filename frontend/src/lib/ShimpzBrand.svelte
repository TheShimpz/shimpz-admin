<script>
  let {
    variant = 'compact',
    product = 'Capsule Admin',
    href = '/',
    ariaLabel = 'Shimpz Capsule Admin home',
  } = $props();
</script>

<a class:hero={variant === 'hero'} class="brand-lockup" {href} aria-label={ariaLabel}>
  <img src="/brand/shimpz-cyberchimp.png" alt="" aria-hidden="true" />
  <span class="brand-type">
    <span class="wordmark">Shimpz</span>
    {#if product}<span class="product">{product}</span>{/if}
  </span>
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

  img {
    width: 2.75rem;
    height: 2.75rem;
    flex: none;
    object-fit: contain;
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

  .hero img {
    width: clamp(7rem, 18vw, 11rem);
    height: clamp(7rem, 18vw, 11rem);
    filter: drop-shadow(0 0 18px rgba(0, 240, 255, 0.15));
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
</style>
