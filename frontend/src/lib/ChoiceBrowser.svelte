<script>
  import { Button, TextField } from '@shimpz/frontend';

  import ChoiceList from '$lib/ChoiceList.svelte';
  import RoutineIcon from '$lib/RoutineIcon.svelte';
  import { fillRoutineCopy } from '$lib/routine.js';
  import { rankBySimilarity } from '$lib/textSimilarity.js';

  // A ChoiceList a person can search and page through: a search field on top finds items by text similarity (typos,
  // accents, and partial words allowed) over each item's `search` text or its label and line, and Previous and Next
  // below move between pages of `pageSize`. The page starts on `initial` when it is listed, and a new search starts on
  // the first page. `copy` holds the field's label, its placeholder, the empty result, the page words, and the two
  // page buttons.
  let {
    label, items = [], copy, variant = 'item', pageSize = 3, initial = '', disabled = false, onchoose = () => {},
  } = $props();

  const id = $props.id();
  let query = $state('');
  let page = $state(0);
  // The first page shown holds `initial`, once; later the person pages and searches.
  let placed = false;
  $effect(() => {
    if (placed) return;
    placed = true;
    const at = items.findIndex((item) => item.id === initial);
    if (at > 0) page = Math.floor(at / pageSize);
  });

  let found = $derived(
    rankBySimilarity(items, query, (item) => item.search ?? `${item.label} ${item.description ?? ''}`),
  );
  let pages = $derived(Math.max(1, Math.ceil(found.length / pageSize)));
  let shown = $derived(found.slice(page * pageSize, (page + 1) * pageSize));

  // Searching again shows its best matches from the first page; a shorter list never leaves the page past its end.
  function search(value) {
    query = value;
    page = 0;
  }
  $effect(() => {
    if (page > pages - 1) page = pages - 1;
  });
</script>

<div class="browser">
  {#if items.length > 0}
    <div class="search">
      <TextField
        id={`${id}-search`}
        type="search"
        label={copy.search}
        visuallyHiddenLabel
        placeholder={copy.searchPlaceholder}
        autocomplete="off"
        value={query}
        oninput={(event) => search(event.currentTarget.value)}
      />
    </div>
  {/if}

  {#if shown.length > 0}
    <ChoiceList {label} items={shown} {variant} {disabled} {onchoose} />
  {:else}
    <p class="empty" role="status">{fillRoutineCopy(copy.noMatch, { query })}</p>
  {/if}

  {#if pages > 1}
    <nav class="pager" aria-label={copy.pages}>
      <Button variant="ghost" size="sm" type="button" disabled={page === 0} onclick={() => (page -= 1)}>
        {#snippet icon()}<span class="flip"><RoutineIcon name="chevron" /></span>{/snippet}{copy.previous}
      </Button>
      <p class="where" aria-live="polite">{fillRoutineCopy(copy.page, { n: page + 1, total: pages })}</p>
      <Button variant="ghost" size="sm" type="button" disabled={page === pages - 1} onclick={() => (page += 1)}>
        {copy.next}<RoutineIcon name="chevron" />
      </Button>
    </nav>
  {/if}
</div>

<style>
  /* Search above, the list in between, and the page controls below, all on the host's inline padding. */
  .browser { display: grid; min-width: 0; }
  .search { padding-block: var(--gap-group); }
  .empty { margin: 0; padding: var(--gap-group) 0; color: var(--shimpz-color-text-muted); font-size: 0.88rem; text-align: center; }
  .pager { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-group); padding-block-start: var(--gap-group); }
  .pager :global(.shimpz-button) { --button-color: var(--shimpz-color-text-muted); --button-border: transparent; }
  .pager :global(.routine-icon) { width: 0.85rem; height: 0.85rem; }
  .flip { display: inline-flex; transform: scaleX(-1); }
  :global([dir="rtl"]) .flip { transform: none; }
  :global([dir="rtl"]) .pager :global(.shimpz-button > .button-content > .routine-icon) { transform: scaleX(-1); }
  .where { margin: 0; color: var(--shimpz-color-text-dim); font: 500 0.72rem/1.3 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; font-variant-numeric: tabular-nums; }
</style>
