<script>
  let { assistant, size = 36 } = $props();
</script>

<span class="assistant-icon" style={`width:${size}px;height:${size}px`} aria-hidden="true">
  <svg viewBox="0 0 48 48" fill="none" role="presentation" data-assistant={assistant}>
    <path class="frame" d="M8 8h32v32H8z" />
    <circle cx="24" cy="24" r="7" class="core" />
    <path class="nodes" d="M24 4v13M24 31v13M4 24h13M31 24h13" />
  </svg>
</span>

<style>
  .assistant-icon {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    overflow: hidden;
    clip-path: polygon(12% 0, 88% 0, 100% 12%, 100% 88%, 88% 100%, 12% 100%, 0 88%, 0 12%);
    background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 72%, white), var(--accent-alt));
    color: #fff;
  }
  .assistant-icon::after {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), transparent 48%);
    content: '';
  }
  svg { position: relative; z-index: 1; width: 68%; height: 68%; filter: drop-shadow(0 0 5px rgba(0, 240, 255, 0.42)); }
  .frame, .core { stroke: currentColor; stroke-width: 1.4; opacity: 0.38; }
  .nodes { stroke: currentColor; stroke-width: 2.2; stroke-linecap: square; stroke-linejoin: bevel; }
</style>
