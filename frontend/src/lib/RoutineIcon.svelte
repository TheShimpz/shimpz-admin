<script>
  import { CIRCLES, PATHS } from '#lib/icons.js';

  // The one stroke icon set of Routine surfaces (ADR-0086), drawn by name at one stroke weight, decorative only. Every
  // icon sits beside words that say the same thing, so it is always hidden from assistive technology.
  let { name, class: className = '' } = $props();
</script>

<svg class={['routine-icon', `routine-icon--${name}`, className]} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#if CIRCLES[name]}<circle cx={CIRCLES[name][0]} cy={CIRCLES[name][1]} r={CIRCLES[name][2]}></circle>{/if}
  {#each PATHS[name] ?? [] as path (path)}<path d={path}></path>{/each}
</svg>

<style>
  .routine-icon { flex: none; width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .routine-icon--spinner { transform-box: fill-box; transform-origin: center; animation: routine-icon-spin 1.1s linear infinite; }
  @keyframes routine-icon-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .routine-icon--spinner { animation: none; } }
</style>
