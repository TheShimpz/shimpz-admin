<script>
  // A Routine's status as one small neutral mark (ADR-0086): a dot while it runs as it should, a pause glyph when it is
  // paused, and a warning glyph when it needs the person. The mark is decorative; its status is always said in words.
  let { status } = $props();

  const WARNING = ['recovery', 'reconfirm', 'waiting', 'deleting'];
</script>

{#if status === 'paused'}
  <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"></path></svg>
{:else if WARNING.includes(status)}
  <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 20h18Z"></path><path d="M12 10v4M12 17h.01"></path></svg>
{:else}
  <span class="mark dot" aria-hidden="true"></span>
{/if}

<style>
  .mark { flex: none; width: 0.8rem; height: 0.8rem; margin-block-start: 0.15rem; color: var(--shimpz-color-text-dim); fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dot { display: grid; place-items: center; }
  .dot::before { content: ""; width: 0.4rem; height: 0.4rem; border-radius: 50%; background: currentColor; }
  @media (forced-colors: active) { .mark { color: CanvasText; } }
</style>
