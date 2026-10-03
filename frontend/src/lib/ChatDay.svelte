<script>
  import { dayLabel } from '$lib/chatDays.js';

  // The day above that day's first transcript item. It stays at the top of the transcript while that day's items
  // scroll under it, and the next day's header takes its place. A heading, so a screen reader can move by day; it
  // takes no focus and announces nothing on its own.
  let { day, today, locale } = $props();
  let label = $derived(dayLabel(day, today, locale));
</script>

<h2 class="chat-day"><time datetime={day}>{label}</time></h2>

<style>
  /* A quiet label on a hairline, on the transcript's own background so text scrolling under it never shows through. */
  .chat-day {
    position: sticky;
    z-index: 1;
    inset-block-start: var(--chat-day-inset, 0);
    display: flex;
    align-items: center;
    gap: var(--shimpz-space-3);
    min-width: 0;
    margin: 1.4rem 0 0.35rem;
    padding-block: 0.45rem;
    background: var(--surface-1);
    color: var(--shimpz-color-text-dim);
    font: 500 0.66rem/1.2 var(--shimpz-font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .chat-day:first-child {
    margin-block-start: 0;
  }

  .chat-day::after {
    flex: 1;
    height: 1px;
    background: var(--shimpz-color-border);
    content: '';
  }

  time {
    flex: none;
    white-space: nowrap;
  }

  @media (forced-colors: active) {
    .chat-day::after { background: CanvasText; }
  }
</style>
