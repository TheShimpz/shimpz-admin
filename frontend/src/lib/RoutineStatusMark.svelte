<script>
  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // A Routine's status as one small neutral mark in a fixed 16px box (ADR-0086): a dot while it waits for its next run,
  // a turning arc while a run goes on, a pause glyph when it is paused, and a warning glyph when it needs the person.
  // The mark is decorative; the status is always said in words beside it.
  let { status } = $props();

  const ICONS = { paused: 'pause', running: 'spinner', recovery: 'warning', reconfirm: 'warning', waiting: 'warning', deleting: 'warning' };
</script>

<span class="mark" aria-hidden="true">
  {#if ICONS[status]}<RoutineIcon name={ICONS[status]} />{:else}<span class="dot"></span>{/if}
</span>

<style>
  .mark { display: inline-grid; flex: none; width: 16px; height: 16px; place-items: center; color: var(--shimpz-color-text-dim); }
  .mark :global(.routine-icon) { width: 13px; height: 13px; }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  @media (forced-colors: active) { .mark { color: CanvasText; } }
</style>
