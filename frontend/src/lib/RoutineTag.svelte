<script>
  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // A Routine status tag (ADR-0086): one color per status for its text, border, and icon, the same in a transcript card
  // and the details panel. Its words always say the status; color only repeats it. Each color keeps at least 4.5:1
  // against the dark surfaces it sits on.
  let { label, tone = 'neutral', icon = '', size = 'sm' } = $props();
</script>

<span class={['tag', `tag--${tone}`, `tag--${size}`]}>{#if icon}<RoutineIcon name={icon} />{/if}{label}</span>

<style>
  .tag {
    --tag-color: var(--shimpz-color-text-muted);
    --tag-border: var(--shimpz-color-border);
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--gap-inside);
    padding: var(--gap-inside) var(--gap-item);
    color: var(--tag-color);
    border: 1px solid var(--tag-border);
    font: 600 0.62rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  /* The block padding is the extra-small tag's own height, not rhythm. */
  .tag--xs { padding: 0.05rem var(--gap-inside); font-size: 0.56rem; line-height: 1.4; }
  .tag :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
  .tag--danger { --tag-color: var(--shimpz-color-danger); --tag-border: var(--shimpz-color-danger); }
  .tag--warning { --tag-color: var(--shimpz-color-yellow); --tag-border: var(--shimpz-color-yellow); }
  .tag--accent { --tag-color: var(--shimpz-color-cyan); --tag-border: var(--shimpz-color-cyan); }
  .tag--waiting { --tag-color: var(--shimpz-color-magenta); --tag-border: var(--shimpz-color-magenta); }
  @media (forced-colors: active) { .tag { border-color: CanvasText; } }
</style>
