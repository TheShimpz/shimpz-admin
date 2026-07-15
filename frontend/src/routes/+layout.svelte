<script>
  import '../app.css';
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
