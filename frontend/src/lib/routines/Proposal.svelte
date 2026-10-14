<script>
  import { AssistantIcon, Disclosure, TextAreaField } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import DialogAction from '#lib/DialogAction.svelte';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import Tag from '#lib/routines/Tag.svelte';

  import { call, commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { installedIconUrl } from '#lib/assistants/icons.js';
  import { assistantNames } from '#lib/assistants/names.js';
  import { t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { refreshTeamRoutines } from '#lib/routines/context.js';
  import { humanizeId } from '#lib/ids.js';
  import { confirmRoutineProposal, revokeRoutineProposal } from '#lib/routines/protocol.js';
  import {
    dispositionWords,
    fillParts,
    proposalInputValue,
    routineErrorMessage,
    scheduleWords,
  } from '#lib/routines/words.js';

  // The card of a Routine a recording turn recorded (ADR-0101 section 5.2), under its reply, kept short for a person
  // who is not technical: its name, when it runs and in which timezone, each step's Action with whether it changes
  // something and every input's complete value, what each run does with its result, any permitted Action no step
  // names, and that the work ran once now and approvals ask on every run. The steps start collapsed. All of it is
  // escaped text. Exactly two buttons under the card, as every Admin prompt's actions: Create confirms it, Cancel
  // revokes it, and neither is preselected. A card past its lifetime offers neither and says so.
  let { teamId, proposal, copy, locale, disabled = false, onrewrite = () => false } = $props();

  // Edit turns the description into the prompt that records the Routine again: sending it revokes this card and
  // sends the edited text as the person's next message, so the Routine's ordinary flow asks for anything it lacks.
  let editing = $state(false);
  let draft = $state('');
  let prompt = $state();

  let card = $derived(copy.proposal);
  let working = $state(false);
  // `created`, `changed`, or `revoked` once the person answered; the card then gives way to one line saying so.
  let answer = $state('');
  let error = $state('');
  let now = $state(Date.now());
  let expired = $derived(now >= Date.parse(proposal.expires_at));

  const assistantName = (id) => $assistantNames[id] ?? humanizeId(id);
  // A step's Assistant opens its own page for the Team the card belongs to.
  const assistantHref = (id) => `/assistants/${encodeURIComponent(id)}?team=${encodeURIComponent(teamId)}`;

  // A card expires on its own; an idle page withdraws its buttons then.
  $effect(() => {
    const left = Date.parse(proposal.expires_at) - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => (now = Date.now()), Math.min(left, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });

  async function settle(action) {
    working = true;
    error = '';
    try {
      const result = await action(call, teamId, proposal.proposal_id);
      answer = result.status;
      if (result.status !== 'revoked') await refreshTeamRoutines(teamId);
    } catch (failure) {
      error = outcomeUnknown(failure) ? $t('shell.outcomeUnknown') : routineErrorMessage(failure, copy.errors);
    } finally {
      working = false;
    }
  }

  const changeWords = (readOnly) => (readOnly ? card.reads : card.changes);
  let changes = $derived(proposal.steps.some((step) => !step.read_only));

  // The field takes the keyboard at once, its caret after the text, so the person types straight away.
  async function edit() {
    draft = proposal.description;
    editing = true;
    await tick();
    prompt?.focus();
    prompt?.setSelectionRange(draft.length, draft.length);
  }

  async function rewrite() {
    const text = draft.trim();
    if (!text) return;
    await settle(revokeRoutineProposal);
    if (answer === 'revoked') onrewrite(text);
  }
</script>

{#if answer}
  <p class="routine-result" role="status">{card[answer]}</p>
{:else if !expired}
<section class="routine-proposal" aria-label={card.title}>
  <div class="sheet admin-frame">
    <header>
      <p class="kicker"><RoutineIcon name="clock" />{editing ? card.editTitle : card.title}</p>
      {#if !editing}
        <h3 class="name">{card.newRoutine}</h3>
        {#if proposal.replaces}<p class="note">{fill(card.replaces, { name: proposal.name })}</p>{/if}
      {/if}
      {#if editing}
        <TextAreaField id={`proposal-prompt-${proposal.proposal_id}`} class="prompt" label={card.prompt} visuallyHiddenLabel
          rows={4} bind:value={draft} bind:element={prompt} />
      {:else}
        <p class="description">{proposal.description}</p>
      {/if}
      {#if changes}<p class="warning"><RoutineIcon name="warning" />{card.changes}</p>{/if}
      {#if !editing}<p class="footnote">{card.ranOnce} {card.approvals}</p>{/if}
    </header>

    {#if !editing}
      <Disclosure class="details">
        {#snippet summary()}{card.steps}{/snippet}
        <ol class="rows" aria-label={card.steps}>
          {#each proposal.steps as step (step.position)}
            <li>
              <div class="row">
                <span class="index" aria-hidden="true">{String(step.position).padStart(2, '0')}</span>
                <span class="what">
                  {#each fillParts(card.stepLine, {
                    assistant: assistantName(step.assistant), action: humanizeId(step.action),
                  }) as part, index (index)}
                    {#if part.key === 'assistant'}<a class="assistant glitch-host" href={assistantHref(step.assistant)}><AssistantIcon
                        class="glitch-icon" assistant={step.assistant} src={installedIconUrl(teamId, step.assistant)} size={18}
                      /><span class="glitch-text">{part.text}</span></a>
                    {:else}<span class={part.key || 'joint'}>{part.text}</span>{/if}
                  {/each}
                </span>
                <Tag size="xs" tone={step.read_only ? 'neutral' : 'warning'} label={changeWords(step.read_only)} />
              </div>
              {#if step.inputs.length}
                <dl class="inputs">
                  {#each step.inputs as input (input.member)}
                    <div><dt>{humanizeId(input.member)}</dt><dd>{proposalInputValue(input, card, copy.plan)}</dd></div>
                  {/each}
                </dl>
              {/if}
            </li>
          {/each}
        </ol>
      </Disclosure>
    {/if}
  </div>

  <div class="actions">
    {#if editing}
      <DialogAction kind="cancel" class="tone-cancel" size="sm" type="button" disabled={working} onclick={() => (editing = false)}>
        {card.cancel}</DialogAction>
      <DialogAction kind="confirm" size="sm" type="button" disabled={working || disabled || !$commandsReady || !draft.trim()}
        onclick={rewrite}>{card.send}</DialogAction>
    {:else}
      <DialogAction kind="cancel" class="tone-cancel" size="sm" type="button" disabled={working || !$commandsReady}
        onclick={() => settle(revokeRoutineProposal)}>{card.cancel}</DialogAction>
      <DialogAction kind="edit" class="tone-edit" size="sm" type="button" disabled={working || disabled || !$commandsReady}
        onclick={edit}>{card.edit}</DialogAction>
      <DialogAction kind="confirm" size="sm" type="button" disabled={working || !$commandsReady}
        onclick={() => settle(confirmRoutineProposal)}>{card.confirm}</DialogAction>
    {/if}
  </div>
  {#if working}<p class="note notice" role="status">{card.working}</p>{/if}
  {#if error}<p class="error notice" role="alert">{error}</p>{/if}
</section>
{/if}

<style>
  /* One cut-corner sheet: the heading, the agent's plain description, and the run notes on top; Team's facts and every
     step in a footer disclosure on a raised surface, its title centered. The two buttons sit under the sheet. */
  .routine-proposal {
    --label: 600 0.6rem/1.5 var(--shimpz-font-mono);
    /* The step number's column: just wide enough for two digits. */
    --index: 1.1rem;
    display: grid;
    gap: var(--gap-item);
    max-width: 62ch;
    margin-block-start: var(--gap-group);
  }
  /* The sheet is Admin's shared frame (app.css .admin-frame): its border, rounding, and chamfer are never its own. */
  .sheet {
    position: relative;
    display: grid;
    color: var(--shimpz-color-text);
    font-size: 0.8rem;
    line-height: 1.55;
  }
  p, h3, ol, dl, dd { margin: 0; }
  header { display: grid; gap: var(--shimpz-space-2); padding: var(--shimpz-space-4); }
  .kicker, dt { font: var(--label); letter-spacing: 0.12em; text-transform: uppercase; }
  .kicker { display: flex; align-items: center; gap: var(--gap-item); color: var(--shimpz-color-cyan); }
  .kicker :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
  .name { font: 700 1rem/1.3 var(--shimpz-font-mono); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .description { font-size: 0.86rem; line-height: 1.6; overflow-wrap: anywhere; }
  .warning { display: flex; align-items: center; gap: var(--gap-item); color: var(--shimpz-color-yellow); font-size: 0.75rem; }
  .warning :global(.routine-icon) { width: 0.85rem; height: 0.85rem; }
  /* Scoped under the card, so the chat's own paragraph color never overrides these gray notes. */
  .routine-proposal .note { color: var(--shimpz-color-text-dim); font-size: 0.7rem; }
  /* The run notes as the header's footnote, just under the description and aligned with it: small, italic, and gray. */
  .routine-proposal .footnote {
    padding-block-start: var(--shimpz-space-1);
    color: var(--shimpz-color-text-dim);
    font-style: italic;
    font-size: 0.66rem;
    line-height: 1.5;
  }
  header :global(.prompt textarea) { min-height: 6rem; font: 0.86rem/1.6 var(--shimpz-font-sans); resize: vertical; }
  /* The footer: a raised band whose disclosure title is centered across it. */
  .sheet > :global(.details) {
    border-radius: 0;
    padding: var(--shimpz-space-2) var(--shimpz-space-4);
    border-block-start: 1px solid var(--shimpz-color-border-subtle);
    background: var(--shimpz-color-surface-high);
  }
  .sheet > :global(.details > summary) { width: 100%; text-align: center; padding-block: var(--shimpz-space-1); }
  .sheet > :global(.details > .content) { display: grid; gap: var(--shimpz-space-3); margin-block: var(--shimpz-space-2); }
  .rows { display: grid; padding: 0; list-style: none; }
  .rows > li { display: grid; gap: var(--gap-inside); padding-block: var(--shimpz-space-2); }
  .rows > li + li { border-block-start: 1px dashed var(--shimpz-color-border-subtle); }
  .row { display: grid; grid-template-columns: var(--index) minmax(0, 1fr) auto; align-items: center; gap: var(--shimpz-space-2); }
  .index { color: var(--shimpz-color-cyan); font: 600 0.7rem/1 var(--shimpz-font-mono); }
  .what { min-width: 0; overflow-wrap: anywhere; }
  /* Each step's Assistant, its icon before its name, links to its page in the line's muted tone. */
  .what .assistant {
    display: inline-flex;
    align-items: center;
    gap: var(--shimpz-space-2);
    vertical-align: middle;
    color: var(--shimpz-color-text-muted);
    text-decoration: none;
  }
  /* On hover it brightens and takes Admin's shared glitch (app.css), never an underline. */
  .what .assistant:hover { color: var(--shimpz-color-text); }
  .what .assistant :global(.shimpz-assistant-icon) { flex: none; }
  .what .joint { color: var(--shimpz-color-text-dim); }
  .what .action { color: var(--shimpz-color-text); font-weight: 600; }
  .inputs {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.1rem var(--shimpz-space-3);
    margin-inline-start: calc(var(--index) + var(--shimpz-space-2));
    padding-inline-start: var(--shimpz-space-2);
    border-inline-start: 1px solid color-mix(in srgb, var(--shimpz-color-cyan) 35%, transparent);
    font: 0.68rem/1.5 var(--shimpz-font-mono);
  }
  .inputs > div { display: contents; }
  .inputs dt { color: color-mix(in srgb, var(--shimpz-color-cyan) 70%, var(--shimpz-color-text-dim)); font: inherit; letter-spacing: 0; text-transform: none; }
  .inputs dd { color: var(--shimpz-color-text-muted); min-width: 0; overflow-wrap: anywhere; }
  /* Cancel and Edit each carry their own tone without a border: its text and icon at rest, its fill on hover. */
  .actions :global(.tone-cancel) {
    --button-color: var(--shimpz-color-danger);
    /* Admin's secondary buttons force the cyan line; these carry no border. */
    --button-border: transparent !important;
    --button-bg: color-mix(in srgb, var(--shimpz-color-danger) 8%, var(--shimpz-color-surface));
    --button-hover-bg: var(--shimpz-color-danger);
    --button-hover-color: #fff;
  }
  /* Edit is gray, the quiet tone between Cancel and Create; its fill keeps dark text for contrast. */
  .actions :global(.tone-edit) {
    --edit-tone: var(--shimpz-color-text-muted);
    --button-color: var(--edit-tone);
    --button-border: transparent !important;
    --button-bg: color-mix(in srgb, var(--edit-tone) 8%, var(--shimpz-color-surface));
    --button-hover-bg: var(--edit-tone);
    --button-hover-color: var(--shimpz-color-bg);
  }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-item); }
  .notice { justify-self: end; }
  .routine-result { color: var(--shimpz-color-text-muted); }
  .error { color: var(--shimpz-color-danger); font-size: 0.75rem; }
  @media (max-width: 420px) {
    .inputs { grid-template-columns: minmax(0, 1fr); margin-inline-start: 0; }
    .inputs dd { margin-block-end: var(--gap-inside); }
  }
</style>
