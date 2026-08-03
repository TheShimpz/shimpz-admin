<script>
  import { onMount } from 'svelte';

  let {
    label = 'Your Team is thinking…',
    stage = 'preparing',
    stages = [],
    elapsedText = 'Elapsed time',
  } = $props();
  let elapsed = $state(0);

  let activeIndex = $derived(stages.findIndex((item) => item.id === stage));
  let stageLabel = $derived(stages[activeIndex]?.label ?? '');
  let formattedElapsed = $derived(elapsedLabel(elapsed));

  function elapsedLabel(value) {
    const minutes = Math.floor(value / 60);
    const seconds = String(value % 60).padStart(2, '0');
    return `${String(minutes).padStart(2, '0')}:${seconds}`;
  }

  onMount(() => {
    const startedAt = Date.now();
    const update = () => { elapsed = Math.floor((Date.now() - startedAt) / 1000); };
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="thinking">
  <div class="summary">
    <span class="pulse" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="copy" role="status" aria-live="polite" aria-atomic="true">
      <strong>{label}</strong>
      <span>{stageLabel}</span>
    </span>
    <time aria-label={`${elapsedText}: ${formattedElapsed}`}>{formattedElapsed}</time>
  </div>
  <ol class="stages" aria-label={label}>
    {#each stages as item, index}
      <li
        class:complete={index < activeIndex}
        class:active={index === activeIndex}
        aria-current={index === activeIndex ? 'step' : undefined}
      >
        <i aria-hidden="true"></i><span>{item.label}</span>
      </li>
    {/each}
  </ol>
</div>

<style>
  .thinking {
    display: grid;
    width: min(100%, 34rem);
    min-width: 0;
    gap: 0.75rem;
    padding: 0.85rem 0;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  .summary {
    display: grid;
    min-width: 0;
    align-items: center;
    grid-template-columns: 2.7rem minmax(0, 1fr) auto;
    gap: 0.8rem;
  }

  .pulse {
    display: flex;
    height: 2rem;
    align-items: center;
    justify-content: center;
    gap: 0.16rem;
    border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
    clip-path: polygon(0.4rem 0, 100% 0, 100% calc(100% - 0.4rem), calc(100% - 0.4rem) 100%, 0 100%, 0 0.4rem);
  }

  .pulse i {
    width: 0.14rem;
    height: 0.3rem;
    background: var(--accent);
    box-shadow: 0 0 0.4rem color-mix(in srgb, var(--accent) 72%, transparent);
    animation: signal 1.1s ease-in-out infinite;
  }

  .pulse i:nth-child(2) { animation-delay: 0.12s; }
  .pulse i:nth-child(3) { animation-delay: 0.24s; }
  .pulse i:nth-child(4) { animation-delay: 0.36s; }

  .copy {
    display: grid;
    min-width: 0;
    gap: 0.18rem;
  }

  .copy strong {
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.045em;
  }

  .copy span,
  time {
    font-size: 0.62rem;
    letter-spacing: 0.055em;
  }

  time {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .stages {
    position: relative;
    display: grid;
    margin: 0;
    padding: 0;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    list-style: none;
  }

  .stages::before {
    position: absolute;
    top: 0.25rem;
    right: calc(100% / 6);
    left: calc(100% / 6);
    height: 1px;
    background: var(--admin-divider);
    content: '';
  }

  .stages li {
    position: relative;
    display: grid;
    min-width: 0;
    justify-items: center;
    gap: 0.38rem;
    color: color-mix(in srgb, var(--text-dim) 58%, transparent);
    text-align: center;
  }

  .stages li i {
    z-index: 1;
    width: 0.5rem;
    height: 0.5rem;
    border: 1px solid var(--admin-divider);
    border-radius: 50%;
    background: var(--surface-1);
  }

  .stages li span {
    max-width: 9rem;
    font-size: 0.52rem;
    line-height: 1.35;
    letter-spacing: 0.04em;
  }

  .stages li.complete,
  .stages li.active {
    color: var(--text-dim);
  }

  .stages li.complete i,
  .stages li.active i {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 0.38rem color-mix(in srgb, var(--accent) 65%, transparent);
  }

  .stages li.active i {
    animation: node 1.4s ease-in-out infinite;
  }

  @keyframes signal {
    0%, 100% { height: 0.3rem; opacity: 0.35; }
    50% { height: 1rem; opacity: 1; }
  }

  @keyframes node {
    0%, 100% { box-shadow: 0 0 0.2rem color-mix(in srgb, var(--accent) 45%, transparent); }
    50% { box-shadow: 0 0 0.75rem color-mix(in srgb, var(--accent) 88%, transparent); }
  }

  @media (max-width: 520px) {
    .stages li span { font-size: 0.46rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse i,
    .stages li.active i {
      animation: none;
    }
  }
</style>
