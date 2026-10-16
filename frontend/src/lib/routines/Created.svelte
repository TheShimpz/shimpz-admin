<script>
  import { Button } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import { fill } from '#lib/i18n/fill.js';
  import { t } from '#lib/i18n/index.js';
  import { routineContext } from '#lib/routines/context.js';
  import RoutineDetailsDialog from '#lib/routines/Details.svelte';

  // A Routine's creation in the chat (ADR-0101), named only in the words Team froze into its notice. While the Team
  // lists that Routine, the line opens its panel, the same one the Team's Routines list opens; a Routine no longer
  // listed keeps the line as text. Closing the panel gives the focus back to the line.
  let { teamId, teamName, notice } = $props();

  let copy = $derived($t('routine'));
  let listed = $derived($routineContext.get(teamId));
  let routine = $derived(listed?.routines.find((item) => item.routine_id === notice.routineId));
  let words = $derived(fill(copy.proposal.answers.created, { name: notice.name }));
  let open = $state(false);
  let line = $state();

  async function close() {
    open = false;
    await tick();
    (line?.querySelector('button') ?? line)?.focus();
  }

  // The Routine stopped being listed while its panel was open, such as when another window deleted it: the panel is
  // gone, so the line takes the focus back.
  $effect(() => {
    if (open && !routine) void close();
  });
</script>

<p class="routine-run" role="group" aria-label={notice.name} tabindex="-1" bind:this={line}>
  {#if routine}
    <Button class="open" variant="ghost" size="sm" type="button" aria-haspopup="dialog" onclick={() => (open = true)}>
      {words}</Button>
  {:else}{words}{/if}
</p>
{#if open && routine}
  <RoutineDetailsDialog {teamId} {teamName} {routine} runs={listed.runs} incidents={listed.incidents} {copy}
    onclose={close} ondeleted={close} />
{/if}

<style>
  .routine-run { margin: 0; color: var(--shimpz-color-green); font-weight: 600; outline-offset: 4px; }
  /* The line reads as the message it is and opens its Routine like a link: underlined on hover and focus. */
  .routine-run :global(.open.open) {
    --button-border: transparent;
    --button-bg: transparent;
    --button-hover-bg: transparent;
    --button-color: inherit;
    --button-hover-color: inherit;
    justify-content: flex-start;
    height: auto;
    min-height: 0;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    text-align: start;
    text-transform: none;
    white-space: normal;
    clip-path: none;
  }
  .routine-run :global(.open.open:hover), .routine-run :global(.open.open:focus-visible) {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
