<script>
  import { Button } from '@shimpz/frontend';

  import RoutineIcon from '$lib/RoutineIcon.svelte';

  // The one Admin choice list: an optional question as its title, then one row per choice between hairlines. Each row
  // is one shared Button: its icon in a small chamfered tile (tinted by an optional `tone`), its label, one line that
  // says what it is or does, and a chevron. `variant="choice"` sets the label as a mono uppercase verb, `"item"` as a
  // plain name. The row is named by its label and described by its line, plus any `status` words that only assistive
  // technology reads. Text always wraps, never truncates; the hover glitch moves the label and icon, never the line.
  // A host may size and frame the list with `--choice-*` properties (see the style block).
  let { label, title = '', items = [], variant = 'choice', disabled = false, onchoose = () => {} } = $props();

  const id = $props.id();
</script>

<div class={['choices', `choices--${variant}`]} role="group" aria-label={label}>
  {#if title}<p class="ask">{title}</p>{/if}
  {#each items as item (item.id)}
    <div class="segment">
      <Button
        class={['choice', item.tone && `tone--${item.tone}`]}
        variant="ghost"
        type="button"
        {disabled}
        aria-label={item.label}
        aria-describedby={[item.description && `${id}-${item.id}`, item.status && `${id}-${item.id}-status`]
          .filter(Boolean).join(' ') || undefined}
        data-choice={item.id}
        onclick={() => onchoose(item.id)}
      >
        <span class="tile" aria-hidden="true"><RoutineIcon name={item.icon} /></span>
        <span class="label">{item.label}</span>
        <span class="go" aria-hidden="true"><RoutineIcon name="chevron" /></span>
        {#if item.description}<span class="line" id={`${id}-${item.id}`}>{item.description}</span>{/if}
        {#if item.status}<span class="sr-only" id={`${id}-${item.id}-status`}>{item.status}</span>{/if}
      </Button>
    </div>
  {/each}
</div>

<style>
  /* Host properties: `--choice-inline` (the row's inline padding, and how far the list bleeds into its host's padding),
     `--choice-ask-align`, `--choice-width` (narrows the title and rows), `--choice-justify`, `--choice-rule` (the
     list's top rule), and `--choice-list-border` (frames the rows as one list). */
  .choices {
    container-type: inline-size;
    display: grid;
    justify-items: var(--choice-justify, stretch);
    margin-inline: calc(-1 * var(--choice-inline, 0px));
    border-block-start: var(--choice-rule, 1px solid var(--shimpz-color-border));
  }
  /* The question is the list's title, and each row below answers it: a heading-sized line over a short cyan rule. */
  .ask {
    display: grid;
    gap: var(--gap-item);
    margin: 0;
    padding: var(--gap-group) var(--choice-inline, var(--gap-group));
    color: var(--shimpz-color-text);
    font: 650 1.12rem/1.3 var(--shimpz-font-sans);
    letter-spacing: -0.01em;
    justify-items: var(--choice-ask-align, start);
    text-align: var(--choice-ask-align, start);
    overflow-wrap: anywhere;
  }
  .ask::after { content: ""; width: 2rem; height: 2px; background: var(--shimpz-color-cyan); box-shadow: 0 0 0.5rem color-mix(in srgb, var(--shimpz-color-cyan) 60%, transparent); }
  .ask + .segment { border-block-start: 1px solid var(--shimpz-color-border); }
  .ask, .segment { box-sizing: border-box; width: var(--choice-width, auto); max-width: 100%; }
  @container (max-width: 34rem) { .ask, .segment { width: auto; justify-self: stretch; } }
  .segment { display: grid; min-width: 0; border-inline: var(--choice-list-border, 0); }
  .segment:last-child { border-block-end: var(--choice-list-border, 0); }
  .segment:first-child { border-block-start: var(--choice-list-border, 0); }
  .segment + .segment { border-block-start: 1px solid var(--shimpz-color-border); }

  /* The row: the shared Button without its chrome. Hover and keyboard focus light a cyan edge at its start, a faint
     chamfered scanline tint behind it, its tile, and its chevron, which steps forward. */
  .segment :global(.choice) {
    --button-color: var(--shimpz-color-text);
    --button-bg: transparent;
    --button-border: transparent;
    --button-hover-color: var(--shimpz-color-text);
    --button-hover-bg: transparent;
    --tone: var(--shimpz-color-text-muted);
    position: relative;
    isolation: isolate;
    width: 100%;
    min-height: 0;
    padding: var(--gap-item) var(--choice-inline, var(--gap-group));
    text-align: start;
    text-transform: none;
    letter-spacing: normal;
    clip-path: none;
  }
  .segment :global(.choice.tone--accent) { --tone: var(--shimpz-color-cyan); }
  .segment :global(.choice.tone--warning) { --tone: var(--shimpz-color-yellow); }
  .segment :global(.choice.tone--danger) { --tone: var(--shimpz-color-danger); }
  .segment :global(.choice::before), .segment :global(.choice::after) { position: absolute; content: ""; pointer-events: none; }
  .segment :global(.choice::before) {
    z-index: -1;
    inset: 0;
    background:
      repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 5%, transparent) 2px 3px),
      linear-gradient(90deg, color-mix(in srgb, var(--shimpz-color-cyan) 9%, transparent), transparent 70%);
    clip-path: var(--shimpz-control-shape);
    opacity: 0;
    transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease);
  }
  .segment :global(.choice::after) {
    inset-block: 0.45rem; /* the hover edge's own length, not rhythm */
    inset-inline-start: 0;
    width: 2px;
    background: var(--shimpz-color-cyan);
    box-shadow: 0 0 0.55rem var(--shimpz-color-cyan);
    transform: scaleY(0);
    transition: transform var(--shimpz-duration-fast) var(--shimpz-ease);
  }
  :global([dir="rtl"]) .segment :global(.choice::before) {
    background:
      repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in srgb, var(--shimpz-color-cyan) 5%, transparent) 2px 3px),
      linear-gradient(270deg, color-mix(in srgb, var(--shimpz-color-cyan) 9%, transparent), transparent 70%);
  }
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled)) { box-shadow: none; }
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled)::before) { opacity: 1; }
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled)::after) { transform: scaleY(1); }
  .segment :global(.choice:focus-visible) { outline: 2px solid var(--shimpz-color-cyan); outline-offset: -2px; box-shadow: none; }
  /* The tile and the chevron sit in the middle of the whole row, beside the label and its line. */
  .segment :global(.choice .button-content) {
    display: grid;
    grid-template-areas: "tile label go" "tile line go";
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    justify-items: start;
    gap: var(--gap-inside) var(--gap-item);
    width: 100%;
  }
  /* The shared Button glitches its whole content on hover; here only the label and the icon do, so the line stays
     still and readable. */
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) > .button-content) { text-shadow: none; animation: none; }
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .label) {
    text-shadow: var(--glitch-split-text);
    animation: admin-glitch-text 280ms steps(1, end);
  }
  .tile {
    display: grid;
    grid-area: tile;
    width: 2.1rem;
    height: 2.1rem;
    place-items: center;
    color: color-mix(in srgb, var(--tone) 80%, var(--shimpz-color-text-dim));
    background: color-mix(in srgb, var(--tone) 6%, var(--shimpz-color-surface-raised));
    border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--shimpz-color-border));
    clip-path: polygon(0 0, calc(100% - var(--shimpz-cut)) 0, 100% var(--shimpz-cut), 100% 100%, 0 100%);
    transition: color var(--shimpz-duration-fast) var(--shimpz-ease), border-color var(--shimpz-duration-fast) var(--shimpz-ease), background var(--shimpz-duration-fast) var(--shimpz-ease);
  }
  :global([dir="rtl"]) .tile { clip-path: polygon(var(--shimpz-cut) 0, 100% 0, 100% 100%, 0 100%, 0 var(--shimpz-cut)); }
  .tile :global(.routine-icon) { width: 1rem; height: 1rem; }
  /* A neutral tile answers in cyan; a toned tile keeps its status color and brightens it. */
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .tile) {
    color: var(--shimpz-color-cyan);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 10%, var(--shimpz-color-surface-raised));
    border-color: var(--shimpz-color-cyan);
  }
  .segment :global(.choice:is(.tone--accent, .tone--warning, .tone--danger):is(:hover, :focus-visible):not(:disabled) .tile) {
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 12%, var(--shimpz-color-surface-raised));
    border-color: var(--tone);
  }
  .label { grid-area: label; min-width: 0; overflow-wrap: anywhere; white-space: normal; }
  .choices--choice .label { font: 700 0.76rem/1.25 var(--shimpz-font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
  .choices--item .label { font: 600 0.95rem/1.3 var(--shimpz-font-sans); letter-spacing: 0; text-transform: none; }
  .go { display: inline-flex; grid-area: go; align-self: center; justify-self: end; color: var(--shimpz-color-text-dim); transition: color var(--shimpz-duration-fast) var(--shimpz-ease), transform var(--shimpz-duration-fast) var(--shimpz-ease); }
  .go :global(.routine-icon) { width: 1rem; height: 1rem; }
  .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .go) { color: var(--shimpz-color-cyan); transform: translateX(3px); }
  :global([dir="rtl"]) .go :global(.routine-icon) { transform: scaleX(-1); }
  :global([dir="rtl"]) .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .go) { transform: translateX(-3px); }
  /* What a row is or does, in plain words: never glitched, never truncated. */
  .line { grid-area: line; min-width: 0; max-width: 68ch; color: var(--shimpz-color-text-muted); font: 400 0.82rem/1.5 var(--shimpz-font-sans); text-shadow: none; text-wrap: pretty; white-space: normal; overflow-wrap: anywhere; }
  .choices--item .line { color: var(--shimpz-color-text-dim); font: 400 0.76rem/1.45 var(--shimpz-font-mono); }
  @media (prefers-reduced-motion: reduce) {
    .segment :global(.choice::before), .segment :global(.choice::after), .tile, .go { transition: none; }
    .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .label) { animation: none; }
    .segment :global(.choice:is(:hover, :focus-visible):not(:disabled) .go) { transform: none; }
  }
  @media (forced-colors: active) {
    .choices, .segment + .segment, .ask + .segment { border-color: CanvasText; }
    .segment :global(.choice::before), .segment :global(.choice::after) { display: none; }
    .tile { border-color: CanvasText; }
  }
</style>
