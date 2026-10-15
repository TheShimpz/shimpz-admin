<script>
  import { untrack } from 'svelte';
  import { fetchFileBytes } from '#lib/chat/attachments/files.js';
  import { MAX_PDF_PAGES, PAGE_COUNT_HEADER, pageUrl } from '#lib/chat/attachments/previews.js';
  import Unavailable from '#lib/chat/attachments/Unavailable.svelte';
  import { t } from '#lib/i18n/index.js';

  // A PDF's pages in the viewer (ADR-0093), one under another: each is Team's sanitized rendition of that page, never
  // the PDF itself. The first page's answer names the page count; every later page is asked for only once it comes
  // within NEAR_PX of the stage, one at a time, and a page Team is too busy to render now is asked for again after the
  // delay Team names (fetchFileBytes). Closing the viewer, or moving to another file, drops every page.
  let { teamId, file } = $props();

  const NEAR_PX = 600;
  let stage = $state();
  let count = $state(0);
  let failed = $state(false);
  let shown = $state({});
  // Pages after the first that could not be rendered; the pages after them still load.
  let lost = $state({});
  let wanted = $state(new Set([1]));
  let pumpNow = () => {};

  // One page's rendition, as an object URL, and for the first page the document's page count.
  async function fetchPage(page, signal) {
    const response = await fetchFileBytes(pageUrl(teamId, file.id, page), signal);
    const total = Number(response.headers.get(PAGE_COUNT_HEADER));
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_PDF_PAGES) throw new Error('Invalid page count.');
    return { url: URL.createObjectURL(await response.blob()), total };
  }

  // Pages load in order, one at a time, while any page near the stage is still missing. The loader runs once per file:
  // what it reads as it goes never restarts it.
  $effect(() => {
    const controller = new AbortController();
    const urls = [];
    let running = false;
    async function pump() {
      if (running) return;
      running = true;
      try {
        for (;;) {
          const next = [...wanted].filter((page) => !shown[page] && !lost[page]).sort((a, b) => a - b)[0];
          if (next === undefined || controller.signal.aborted) return;
          try {
            const { url, total } = await fetchPage(next, controller.signal);
            urls.push(url);
            if (next === 1) count = total;
            shown = { ...shown, [next]: url };
          } catch {
            if (controller.signal.aborted) return;
            // Without its first page the document has no page count, so it has no preview at all.
            if (next === 1) {
              failed = true;
              return;
            }
            lost = { ...lost, [next]: true };
          }
        }
      } finally {
        running = false;
      }
    }
    pumpNow = pump;
    untrack(pump);
    return () => {
      controller.abort();
      pumpNow = () => {};
      for (const url of urls) URL.revokeObjectURL(url);
    };
  });

  // A page placeholder near the stage asks for its page.
  function nearby(node, page) {
    const observer = new IntersectionObserver((records) => {
      if (!records.some((record) => record.isIntersecting) || wanted.has(page)) return;
      wanted = new Set([...wanted, page]);
      pumpNow();
    }, { root: stage, rootMargin: `${NEAR_PX}px 0px` });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

<div class="pdf-stage" bind:this={stage}>
  {#if failed}
    <Unavailable text={$t('attachments.noPreview')} fill />
  {:else}
    <ol class="pages">
      {#each Array.from({ length: Math.max(count, 1) }, (_, offset) => offset + 1) as page (page)}
        <li class="page" use:nearby={page}>
          {#if shown[page]}
            <img src={shown[page]} alt={$t('attachments.pageNumber', { page })} />
          {:else if lost[page]}
            <p class="page-lost">{$t('attachments.pageNumber', { page })} · {$t('attachments.notRead')}</p>
          {:else}
            <span class="page-pending" aria-hidden="true"></span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  /* The pages scroll inside the stage, each fitted to its width. */
  .pdf-stage {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .pages {
    display: grid;
    justify-items: center;
    gap: var(--gap-item);
    margin: 0;
    padding: var(--gap-item);
    list-style: none;
  }

  .page {
    display: grid;
    width: min(100%, 52rem);
  }

  img {
    display: block;
    width: 100%;
    height: auto;
    background: #fff;
  }

  /* A page that could not be rendered says so in its place. */
  .page-lost {
    margin: 0;
    padding: var(--gap-item);
    color: var(--shimpz-color-text-dim);
    font: 600 0.72rem/1.4 var(--shimpz-font-mono);
    text-align: center;
    background: color-mix(in srgb, var(--shimpz-color-text) 6%, var(--shimpz-color-bg));
  }

  /* A page not loaded yet holds a sheet's proportions, so the scroll does not jump when it arrives. */
  .page-pending {
    aspect-ratio: 1 / 1.414;
    background: color-mix(in srgb, var(--shimpz-color-text) 6%, var(--shimpz-color-bg));
  }
</style>
