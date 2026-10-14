<script>
  import { downloadUrl, fetchFileBytes, formatFileSize, MAX_TEXT_SOURCE_BYTES } from '#lib/chat/attachments/files.js';
  import { locale, t } from '#lib/i18n/index.js';

  // A text file's own text in the viewer (ADR-0093): at most MAX_TEXT_SOURCE_BYTES of the stored file, read through
  // Admin's download route and decoded as UTF-8, shown only as text, never interpreted as markup.
  let { teamId, file } = $props();

  let text = $state(null);
  let cut = $state(false);
  let failed = $state(false);

  async function readText(signal) {
    const response = await fetchFileBytes(downloadUrl(teamId, file.id), signal);
    if (!response.body) throw new Error('The file could not be read.');
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    // Reading on past the bound, by at most one chunk, tells a file of exactly the bound from a longer one.
    try {
      while (size <= MAX_TEXT_SOURCE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.byteLength;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(Math.min(size, MAX_TEXT_SOURCE_BYTES));
    let offset = 0;
    for (const part of parts) {
      const take = Math.min(part.byteLength, bytes.length - offset);
      bytes.set(part.subarray(0, take), offset);
      offset += take;
    }
    // A cut may split a character: the stream decoder leaves its start out rather than showing a replacement.
    return { text: new TextDecoder('utf-8').decode(bytes, { stream: size > bytes.length }), cut: size > bytes.length };
  }

  $effect(() => {
    const controller = new AbortController();
    readText(controller.signal).then(
      (read) => {
        text = read.text;
        cut = read.cut;
      },
      () => {
        if (!controller.signal.aborted) failed = true;
      },
    );
    return () => controller.abort();
  });
</script>

<div class="text-stage">
  {#if failed}
    <p class="unavailable">{$t('attachments.notRead')}</p>
  {:else if text !== null}
    {#if cut}
      <p class="text-cut">{$t('attachments.textCut', { size: formatFileSize(MAX_TEXT_SOURCE_BYTES, $locale) })}</p>
    {/if}
    <pre>{text}</pre>
  {/if}
</div>

<style>
  .text-stage {
    width: 100%;
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
  }

  pre {
    margin: 0;
    padding: var(--gap-item);
    color: var(--shimpz-color-text);
    font: 400 0.8rem/1.55 var(--shimpz-font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    unicode-bidi: plaintext;
  }

  .text-cut {
    margin: 0;
    padding: var(--gap-inside) var(--gap-item);
    color: var(--shimpz-color-text-dim);
    font: 400 0.68rem/1.4 var(--shimpz-font-mono);
  }

  .unavailable {
    display: grid;
    height: 100%;
    margin: 0;
    place-items: center;
    color: var(--shimpz-color-text-dim);
    font: 600 0.72rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>
