<script>
  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // A Routine status tag (ADR-0086): neutral mono text, with one border color per status so each reads the same in
  // the sidebar, a transcript card, and the details panel. Its words always say the status; color only repeats it.
  let { label, tone = 'neutral', icon = '', size = 'sm' } = $props();
</script>

<span class={['tag', `tag--${tone}`, `tag--${size}`]}>{#if icon}<RoutineIcon name={icon} />{/if}{label}</span>

<style>
  .tag {
    --tag-border: var(--shimpz-color-border);
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.45rem;
    color: var(--shimpz-color-text-muted);
    border: 1px solid var(--tag-border);
    font: 600 0.62rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .tag--xs { padding: 0.05rem 0.3rem; font-size: 0.56rem; line-height: 1.4; }
  .tag :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
  .tag--danger { --tag-border: color-mix(in srgb, var(--shimpz-color-danger) 70%, transparent); }
  .tag--warning { --tag-border: color-mix(in srgb, var(--shimpz-color-yellow) 65%, transparent); }
  .tag--accent { --tag-border: color-mix(in srgb, var(--shimpz-color-cyan) 70%, transparent); }
  .tag--waiting { --tag-border: color-mix(in srgb, var(--shimpz-color-magenta) 70%, transparent); }
  .tag--danger :global(.routine-icon) { color: var(--shimpz-color-danger); }
  .tag--warning :global(.routine-icon) { color: var(--shimpz-color-yellow); }
  .tag--accent :global(.routine-icon) { color: var(--shimpz-color-cyan); }
  .tag--waiting :global(.routine-icon) { color: var(--shimpz-color-magenta); }
  @media (forced-colors: active) { .tag { border-color: CanvasText; } }
</style>
