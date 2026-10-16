<script>
  import { AssistantIcon, TextLink } from '@shimpz/frontend';

  import { installedIconUrl } from '#lib/assistants/icons.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { humanizeId } from '#lib/ids.js';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import Tag from '#lib/routines/Tag.svelte';
  import { fillParts, stepTag } from '#lib/routines/words.js';

  // One numbered step of a Routine, laid out alike wherever a step is listed (ADR-0101): a Routine card's details, a
  // Routine's plan, and a run's steps. Its two-digit position, its Assistant (the installed icon before its name, linked
  // to its page for the Team) and Action in the card's words, whether it reads or writes when that is known
  // (`readOnly`), what the view says of it (`status`), its inputs as one wrapping line of "Member: value" pairs, the
  // value in its own mono face (`words` puts one value in the view's words; `locked` are the inputs whose value is never
  // shown, such as a saved key: each a lock chip with its `name`, and `label` saying what it is), and anything the view
  // adds after them (`children`). A step its view knows no Action for, such as a run's step that never ran, shows only its
  // position and what the view says. `copy` is the Routine card's (`routine.proposal`). Every value is escaped text.
  let {
    teamId,
    position,
    assistant,
    action,
    readOnly = null,
    inputs,
    words,
    locked = [],
    copy,
    class: className = '',
    status,
    children,
  } = $props();

  // A step's Assistant opens its own page for the Team the step belongs to.
  let href = $derived(`/assistants/${encodeURIComponent(assistant)}?team=${encodeURIComponent(teamId)}`);
</script>

<li class={['routine-step', className]} tabindex="-1">
  <div class="row">
    <span class="index" aria-hidden="true">{String(position).padStart(2, '0')}</span>
    <span class="what">
      {#if assistant && action}
        {#each fillParts(copy.stepLine, {
          assistant: $assistantName(assistant), action: humanizeId(action),
        }) as part, index (index)}
          {#if part.key === 'assistant'}<TextLink class="assistant glitch-host" {href}><AssistantIcon
              class="glitch-icon" {assistant} src={installedIconUrl(teamId, assistant)} size={18}
            /><span class="glitch-text">{part.text}</span></TextLink>
          {:else}<span class={part.key || 'joint'}>{part.text}</span>{/if}
        {/each}
      {/if}
    </span>
    <!-- Each step reads or writes, each in its own color. -->
    {#if readOnly !== null}<Tag size="xs" {...stepTag(readOnly, copy)} />{/if}
  </div>
  {#if status}<div class="aside">{@render status()}</div>{/if}
  {#if inputs.length || locked.length}
    <div class="inputs aside">
      <dl>
        {#each inputs as input (input.member)}
          <div><dt>{humanizeId(input.member)}</dt><dd>{words(input)}</dd></div>
        {/each}
      </dl>
      {#each locked as item (item.name)}
        <p class="locked" title={item.label}>
          <RoutineIcon name="lock" /><span class="sr-only">{item.label}</span><span aria-hidden="true">{item.name}</span>
        </p>
      {/each}
    </div>
  {/if}
  {#if children}<div class="aside">{@render children()}</div>{/if}
</li>

<style>
  /* A numbered row: the two-digit position, the Assistant and its Action, and its effect at the end; what follows
     lines up after the position. Rows part with a dashed rule. */
  .routine-step {
    /* The position's column: just wide enough for two digits. */
    --index: 1.1rem;
    display: grid;
    gap: var(--gap-inside);
    padding-block: var(--shimpz-space-2);
    color: var(--shimpz-color-text);
    font-size: 0.8rem;
    line-height: 1.55;
    outline-offset: 2px;
  }
  .routine-step + .routine-step { border-block-start: 1px dashed var(--shimpz-color-border-subtle); border-radius: 0; }
  .row { display: grid; grid-template-columns: var(--index) minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-2); }
  .index { color: var(--shimpz-color-cyan); font: 600 0.7rem/1 var(--shimpz-font-mono); }
  .what { min-width: 0; overflow-wrap: anywhere; }
  /* Each step's Assistant, its icon before its name, links to its page in the line's muted tone. */
  .what :global(.assistant) {
    display: inline-flex;
    align-items: center;
    gap: var(--shimpz-space-2);
    vertical-align: middle;
    color: var(--shimpz-color-text-muted);
    font-weight: inherit;
  }
  /* On hover it brightens and takes Admin's shared glitch (app.css), never an underline. */
  .what :global(.assistant:hover) { color: var(--shimpz-color-text); }
  .what :global(.assistant .shimpz-assistant-icon) { flex: none; }
  .what .joint { color: var(--shimpz-color-text-dim); }
  .what .action { color: var(--shimpz-color-text); font-weight: 600; }
  .aside { margin-inline-start: calc(var(--index) + var(--shimpz-space-2)); min-width: 0; }
  /* A step's inputs wrap as one line of "Member: value" pairs under its Action. */
  .inputs {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--gap-inside) var(--gap-group);
    color: var(--shimpz-color-text-muted);
    font-size: 0.76rem;
  }
  dl { display: contents; }
  dl > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-inside); min-width: 0; }
  dt::after { content: ":"; }
  dd { margin: 0; min-width: 0; color: var(--shimpz-color-text); font-family: var(--shimpz-font-mono); font-size: 0.74rem; overflow-wrap: anywhere; }
  .locked { display: inline-flex; align-items: center; gap: var(--gap-inside); margin: 0; font-family: var(--shimpz-font-mono); font-size: 0.74rem; }
  .locked :global(.routine-icon) { width: 0.75rem; height: 0.75rem; }
  @media (max-width: 420px) {
    .aside { margin-inline-start: 0; }
  }
</style>
