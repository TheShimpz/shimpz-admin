<script>
  // A slim catalog row: the whole row opens the Assistant's own page, where it is installed or removed. The row is the
  // shared text link primitive; its presentation here makes it read as one list entry.
  import { AssistantIcon, TextLink } from '@shimpz/frontend';

  let {
    name,
    summary,
    iconSrc,
    iconStatus = 'loading',
    badge,
    badgeTone = 'free',
    installed = false,
    installedLabel,
    href,
    class: className,
    ...attributes
  } = $props();
</script>

<TextLink class={['assistant-row', installed && 'is-installed', className]} {href} {...attributes}>
  <span class="icon-frame">
    <AssistantIcon assistant={name} size={36} src={iconSrc} status={iconStatus} loading="eager" />
  </span>

  <span class="identity">
    <span class="title">
      <span class="name">{name}</span>
      <span class={['badge', badgeTone === 'local' && 'local']}>{badge}</span>
      {#if installed}<span class="sr-only">{installedLabel}</span>{/if}
    </span>
    <span class="summary">{summary}</span>
  </span>

  <span class="chevron" aria-hidden="true">›</span>
</TextLink>

<style>
  :global(a.shimpz-text-link.assistant-row) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0 var(--gap-item);
    padding: var(--gap-item) var(--shimpz-page-padding);
    color: inherit;
    text-decoration: none;
    transition: background 0.16s ease;
  }

  :global(a.shimpz-text-link.assistant-row:hover),
  :global(a.shimpz-text-link.assistant-row:focus-visible) {
    color: inherit;
    background: color-mix(in oklab, var(--shimpz-color-cyan) 4%, var(--shimpz-color-surface-raised));
    outline: none;
  }

  :global(.assistant-row:focus-visible) .icon-frame,
  :global(.assistant-row:hover) .icon-frame {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--shimpz-color-cyan) 55%, transparent);
  }

  .icon-frame {
    display: grid;
    place-items: center;
    width: 2.6rem;
    height: 2.6rem;
    background: var(--shimpz-color-bg);
    clip-path: polygon(
      var(--shimpz-cut) 0,
      100% 0,
      100% calc(100% - var(--shimpz-cut)),
      calc(100% - var(--shimpz-cut)) 100%,
      0 100%,
      0 var(--shimpz-cut)
    );
    box-shadow: inset 0 0 0 1px var(--shimpz-color-border);
    transition: box-shadow 0.16s ease;
  }

  :global(.is-installed) .icon-frame {
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--shimpz-color-green) 45%, var(--shimpz-color-border));
  }

  .identity {
    display: grid;
    min-width: 0;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: var(--gap-item);
    min-width: 0;
  }

  .name {
    overflow: hidden;
    color: var(--shimpz-color-text);
    font: 600 0.92rem/1.25 var(--shimpz-font-mono);
    letter-spacing: -0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    flex: none;
    color: var(--shimpz-color-text-dim);
    font: 700 0.56rem/1 var(--shimpz-font-mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .badge.local {
    color: var(--shimpz-color-yellow);
  }

  .summary {
    margin-top: var(--gap-inside);
    color: var(--shimpz-color-text-muted);
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .chevron {
    color: var(--shimpz-color-text-dim);
    font: 400 1.1rem/1 var(--shimpz-font-mono);
    transition: color 0.16s ease, transform 0.16s ease;
  }

  :global(.assistant-row:hover) .chevron,
  :global(.assistant-row:focus-visible) .chevron {
    color: var(--shimpz-color-cyan);
    transform: translateX(2px);
  }

  /* Two per row on a phone: each Assistant stands upright, icon first, so its name and summary keep the width. */
  @media (max-width: 640px) {
    :global(a.shimpz-text-link.assistant-row) {
      grid-template-columns: 1fr;
      align-content: start;
      align-items: start;
      gap: var(--gap-item);
      padding: var(--gap-group);
    }
    .title { flex-wrap: wrap; gap: var(--gap-inside) var(--gap-item); }
    .name { white-space: normal; overflow-wrap: anywhere; }
    .summary { font-size: 0.78rem; }
    .chevron { display: none; }
  }

  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  @media (prefers-reduced-motion: reduce) {
    :global(a.shimpz-text-link.assistant-row), .icon-frame, .chevron { transition: none; }
  }
</style>
