<script>
  // The one stroke icon set of Routine surfaces (ADR-0086): 24-unit paths at one stroke weight, decorative only. Every
  // icon sits beside words that say the same thing, so it is always hidden from assistive technology.
  let { name, class: className = '' } = $props();

  const PATHS = {
    clock: ['M12 7v5l3 2'],
    pause: ['M9 6v12', 'M15 6v12'],
    warning: ['M12 4 3 20h18Z', 'M12 10v4', 'M12 17h.01'],
    check: ['M20 6 9 17l-5-5'],
    failed: ['m15 9-6 6', 'm9 9 6 6'],
    skip: ['M5 5v14l10-7Z', 'M19 5v14'],
    verify: ['m20 20-4-4', 'm8.5 11 2 2 3.5-3.5'],
    terminal: ['M4 5h16v14H4Z', 'm8 10 2 2-2 2', 'M13 14h3'],
    chevron: ['m9 6 6 6-6 6'],
    back: ['m15 6-6 6 6 6'],
    play: ['M7 5v14l11-7Z'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
    close: ['M6 6l12 12', 'M18 6 6 18'],
    activity: ['M3 12h4l3-8 4 16 3-8h4'],
    rebuild: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v4h-4'],
    stop: ['M7 7h10v10H7Z'],
    approval: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z', 'm9 12 2 2 4-4'],
    lock: ['M5 11h14v10H5Z', 'M8 11V8a4 4 0 0 1 8 0v3'],
    step: ['M5 12h14', 'm13 6 6 6-6 6'],
    spinner: ['M12 3a9 9 0 1 0 9 9'],
    reply: ['m9 15-5-5 5-5', 'M4 10h11a5 5 0 0 1 5 5v4'],
  };
  // Icons drawn with a circle as well as paths.
  const CIRCLES = { clock: [12, 12, 9], failed: [12, 12, 9], verify: [11, 11, 7] };
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
