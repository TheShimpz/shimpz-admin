<script>
  import { locale } from '$lib/i18n.js';
  import { routineNotice } from '$lib/routine.js';

  // A Routine's creation in a Team's transcript (ADR-0086), the one Routine notice the chat shows: its runs and later
  // outcomes are its own history, which only its panel shows. One line of an activity timeline: the notice's time on
  // the timeline's rail, the Routine's name, and a status phrase. Consecutive notices share one thin rail through their
  // times (`joinAbove`, `joinBelow`). The name is only the one Team froze into this notice (ADR-0101), never the live
  // Routine list and never a request, so a reloaded transcript reads alike and still names a Routine deleted since.
  // Every name and value is plain text, and the notice is not part of the Brain's conversation.
  let { entry, copy, joinAbove = false, joinBelow = false } = $props();

  let shown = $derived(routineNotice(entry, { copy, locale: $locale }));
</script>

<div
  class={['routine-run', joinAbove && 'join-above', joinBelow && 'join-below']}
  role="group"
  aria-label={entry.name}
  tabindex="-1"
>
  <p class="head">
    <span class="name">{entry.name}</span>
    <span class="status">{shown.status}</span>
  </p>
  <time class="time" datetime={entry.createdAt}>{shown.time}</time>
</div>

<style>
  /*
   * A timeline entry, never a card: the notice's time sits on a thin rail at the start, and the Routine's name and
   * status read as one line beside it. The rail is two hairline segments that stop short of the
   * time, so consecutive notices read as one thread; the segment above reaches back across the gap between transcript
   * exchanges.
   */
  .routine-run {
    --tone: var(--shimpz-color-text-dim);
    --time-column: 3.5rem;
    --head-line: 1.5rem;
    --rail-clearance: 0.1rem;
    position: relative;
    display: grid;
    justify-items: start;
    gap: var(--gap-inside);
    min-width: 0;
    padding-inline-start: calc(var(--time-column) + var(--gap-item));
    outline-offset: 4px;
  }

  .time {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    width: var(--time-column);
    color: var(--shimpz-color-text-dim);
    font: 0.72rem/var(--head-line) var(--shimpz-font-mono);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .join-above::before,
  .join-below::after {
    position: absolute;
    inset-inline-start: calc(var(--time-column) / 2);
    width: 1px;
    background: var(--shimpz-color-border);
    content: '';
  }

  /* Up to the previous notice, across the exchange gap; down to this entry's own bottom edge. */
  .join-above::before {
    inset-block-start: calc(-1 * var(--routine-rail-gap, var(--gap-group)));
    height: calc(var(--routine-rail-gap, var(--gap-group)) + var(--rail-clearance));
  }

  .join-below::after {
    inset-block: calc(var(--head-line) - var(--rail-clearance)) 0;
  }

  /* The name and status wrap as one phrase. */
  .routine-run .head {
    width: 100%;
    margin: 0;
    color: var(--shimpz-color-text);
    white-space: normal;
    font-size: 0.95rem;
    line-height: var(--head-line);
    overflow-wrap: anywhere;
  }

  .name { font-weight: 600; }

  .status {
    color: var(--tone);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  @media (max-width: 40rem) {
    .routine-run .head { font-size: 0.9rem; }
  }
</style>
