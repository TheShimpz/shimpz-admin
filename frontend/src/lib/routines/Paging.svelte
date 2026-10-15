<script>
  import { Button } from '@shimpz/frontend';

  import { PAGE_SIZE } from '#lib/routines/paging.svelte.js';
  import { countWords } from '#lib/routines/words.js';

  // The footer of a Routine list revealed page by page (`PagedList`): why its next items could not be read, that they
  // are being read, or a button revealing how many more one press shows.
  let { paging, remaining, unavailable, loading, more, locale, onmore } = $props();
</script>

{#if paging.failed}
  <p class="note">{unavailable}</p>
{:else if paging.loading}
  <p class="note" role="status">{loading}</p>
{:else if remaining > 0}
  <Button class="more" variant="ghost" size="sm" type="button" onclick={onmore}>
    {countWords(more, Math.min(PAGE_SIZE, remaining), locale)}
  </Button>
{/if}

<style>
  .note { margin: var(--gap-inside) 0 0; color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  :global(.shimpz-button.more) { justify-self: start; }
</style>
