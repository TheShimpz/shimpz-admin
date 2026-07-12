<script>
  import { onMount } from 'svelte';
  import { locale, LOCALES } from '$lib/i18n.js';

  let { children } = $props();

  // Reflect the active locale onto <html> for CSS `dir` + font selection.
  onMount(() => {
    const unsub = locale.subscribe((code) => {
      const l = LOCALES.find((x) => x.code === code);
      document.documentElement.lang = code;
      document.documentElement.dir = l?.dir ?? 'ltr';
    });
    return unsub;
  });
</script>

{@render children()}

<style>
  :global(:root) {
    color-scheme: dark;
    /* ── surfaces (elevation ladder) ── */
    --bg: #0b0e12;
    --surface-1: #12161c;
    --surface-2: #171d25;
    --surface-3: #1e2630;
    --border: #262f3a;
    --border-strong: #33404e;
    /* ── text ── */
    --text: #e8eef5;
    --text-dim: #9aa7b4;
    --text-faint: #63707d;
    /* ── brand + semantic ── */
    --accent: #56d6a0;
    --accent-strong: #2ea179;
    --accent-ink: #04140d;
    --danger: #f0685f;
    --warn: #e0b64a;
    --info: #5aa9f0;
    /* ── shape + motion ── */
    --r-sm: 8px;
    --r-md: 12px;
    --r-lg: 16px;
    --shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    --ring: 0 0 0 3px rgba(86, 214, 160, 0.22);
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(html) {
    background: var(--bg);
  }
  :global(body) {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(1100px 600px at 50% -10%, rgba(46, 161, 121, 0.1), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family:
      ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic',
      'Noto Sans CJK SC', 'Noto Sans JP', sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  :global(code) {
    font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace;
    font-size: 0.86em;
  }
  :global(a) {
    color: var(--accent);
  }
  /* Mirror directional paddings/margins are handled by logical properties in components. */
  :global([dir='rtl']) {
    text-align: right;
  }
</style>
