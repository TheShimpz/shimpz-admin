<script>
  // Why the viewer shows no rendition of a file: it has none, or it could not be read. With `fill` it takes its frame's
  // whole height, centered.
  let { text, fill = false } = $props();
</script>

<p class="unavailable" class:fill>{text}</p>

<style>
  .unavailable {
    margin: 0;
    color: var(--shimpz-color-text-dim);
    font: 600 0.72rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .fill {
    display: grid;
    height: 100%;
    place-items: center;
  }
</style>
