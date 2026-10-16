<script>
  import { AssistantIcon, Disclosure, TextAreaField, TextLink } from '@shimpz/frontend';
  import { tick } from 'svelte';

  import DialogAction from '#lib/DialogAction.svelte';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import Inputs from '#lib/routines/Inputs.svelte';
  import Tag from '#lib/routines/Tag.svelte';

  import { call, commandsReady } from '#lib/session/socket.js';
  import { installedIconUrl } from '#lib/assistants/icons.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { refreshTeamRoutines } from '#lib/routines/context.js';
  import { humanizeId } from '#lib/ids.js';
  import { confirmRoutineProposal, revokeRoutineProposal } from '#lib/routines/protocol.js';
  import {
    fillParts, outputChoiceWords, proposalInputValue, proposalRequest, proposalWhen, routineFailureWords, stepTag,
  } from '#lib/routines/words.js';
  import { recoverFocus } from '#lib/shell/focus.js';

  // The card of a Routine a recording turn recorded (ADR-0101), under its reply, kept short for a person
  // who is not technical: the recording agent's plain description of the work, when it runs in its zone and what each
  // run does with its result in Team's own fixed words (amendment 2026-10-16), and a warning when a step changes
  // something. Its footer row holds a closed disclosure that, once the person opens it, lists each step's Assistant,
  // linked to its page, its Action, whether it changes something, and every input's complete value, and at its end
  // three buttons, none preselected: Cancel revokes the card, Edit turns it into the prompt that records it again, and
  // Create confirms it. All of it is escaped text. A card past its lifetime is no longer shown.
  // `answered` is how the person already answered this card, kept in the transcript, so a reload never offers it again.
  // `onleave` hears that an answer here took the card out of the chat, with the focus its button had.
  let { teamId, proposal, copy, disabled, answered, onrewrite, onleave } = $props();

  // Edit turns the card into the prompt that records the Routine again: its description, then its schedule, zone, and
  // output in words Team reads back as exactly the card's. Sending it revokes this card and sends the edited text as the
  // person's next message, so the Routine's ordinary flow asks for anything it lacks.
  let editing = $state(false);
  // The steps stay closed until the person opens them.
  let stepsOpen = $state(false);
  let draft = $state('');
  let prompt = $state();
  let section = $state();

  let card = $derived(copy.proposal);
  let working = $state(false);
  // `created`, `changed`, or `revoked` once the person answered here or before. A created or changed Routine says so
  // in its own message below, so the card leaves; a revoked card gives way to one line saying so.
  let given = $state('');
  let revoked = $state(false);
  // A card this page revoked for an edit keeps its editor until the edited text went out, whatever the transcript says.
  let answer = $derived(revoked ? given : answered || given);
  let error = $state('');
  let now = $state(Date.now());
  let expired = $derived(now >= Date.parse(proposal.expires_at));

  // A step's Assistant opens its own page for the Team the card belongs to.
  const assistantHref = (id) => `/assistants/${encodeURIComponent(id)}?team=${encodeURIComponent(teamId)}`;

  // A card expires on its own; an idle page withdraws its buttons then.
  $effect(() => {
    const left = Date.parse(proposal.expires_at) - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => (now = Date.now()), Math.min(left, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });

  // Once the card has left the chat, `onleave` gives the focus its button had to the composer, also when the
  // transcript took the card out before its answer returned; the host's own guard keeps focus the person moved. An
  // answer that keeps the card gives the focus back to the button pressed once it is enabled again (`recoverFocus`).
  async function settle(action) {
    working = true;
    error = '';
    try {
      const result = await action(call, teamId, proposal.proposal_id);
      given = result.status;
      onleave();
      if (result.status !== 'revoked') await refreshTeamRoutines(teamId);
    } catch (failure) {
      error = routineFailureWords(failure, copy.errors, $t('shell.outcomeUnknown'));
    } finally {
      working = false;
    }
  }

  let changes = $derived(proposal.steps.some((step) => !step.read_only));

  // The field takes the keyboard at once, its caret after the text, so the person types straight away.
  async function edit() {
    draft = proposalRequest(proposal, copy, $locale);
    editing = true;
    await tick();
    prompt?.focus();
    prompt?.setSelectionRange(draft.length, draft.length);
  }

  // The card is revoked once; the edited text is then sent as the next message of this card's own Team. A send the
  // page cannot take now keeps the text in its field to send again, never revoking twice.
  // The card answers only while it is shown: a revocation that ends after it left sends nothing.
  let shown = true;
  $effect(() => () => {
    shown = false;
  });

  async function rewrite() {
    const text = draft.trim();
    // The Team is the card's own as the person sent it; a later selection of another Team never receives it.
    const origin = teamId;
    if (!text || working) return;
    if (!revoked) {
      working = true;
      error = '';
      try {
        const result = await revokeRoutineProposal(call, teamId, proposal.proposal_id);
        if (result.status !== 'revoked') {
          // The card was already confirmed: its Routine exists, so the edited text is not sent again.
          editing = false;
          given = result.status;
          onleave();
          return;
        }
        revoked = true;
      } catch (failure) {
        error = routineFailureWords(failure, copy.errors, $t('shell.outcomeUnknown'));
        return;
      } finally {
        working = false;
      }
    }
    if (!shown) return;
    if (onrewrite(text, origin)) given = 'revoked';
    else error = card.rewriteUnsent;
  }

  // Leaving the editor shows the card again with focus on its Edit button, unless it was already revoked for a send
  // that did not go out: then the card leaves.
  async function stopEditing() {
    editing = false;
    if (revoked) {
      given = 'revoked';
      onleave();
      return;
    }
    await tick();
    section?.querySelector('.tone-edit')?.focus();
  }
</script>

<!-- A revoked card whose edited text has not gone out yet stays open to send it, past its lifetime too. -->
{#if answer === 'revoked'}
  <p class="routine-result" role="status">{card.revoked}</p>
{:else if answer}
  <!-- Its Routine was created or changed; the answer's own message says so. -->
{:else if !expired || revoked}
<section class="routine-proposal" aria-label={card.title} bind:this={section} {@attach recoverFocus}>
  <div class="sheet admin-frame">
    <header>
      <p class="kicker"><RoutineIcon name="clock" />{editing ? card.editTitle : card.title}</p>
      {#if !editing}
        <h3 class="name">{fill(card.routineTitle, { name: proposal.name })}</h3>
        {#if proposal.replaces}<p class="note">{fill(card.replaces, { name: proposal.name })}</p>{/if}
      {/if}
      {#if editing}
        <TextAreaField id={`proposal-prompt-${proposal.proposal_id}`} class="prompt" label={card.prompt} visuallyHiddenLabel
          rows={4} bind:value={draft} bind:element={prompt} />
      {:else}
        <p class="description">{proposal.description}</p>
        <dl class="settings">
          <div><dt>{card.whenLabel}</dt><dd>{proposalWhen(proposal, copy, $locale)}</dd></div>
          <div><dt>{card.outputLabel}</dt><dd>{outputChoiceWords(proposal.output, card.questions)}</dd></div>
        </dl>
        <!-- An interval starts at once, never at a time of day. -->
        {#if proposal.schedule.kind === 'continuous'}<p class="note">{card.firstRun}</p>{/if}
      {/if}
      {#if changes}<p class="warning"><RoutineIcon name="warning" />{card.changes}</p>{/if}
    </header>

    <!-- The footer row: the steps' disclosure at its start and the card's buttons at its end; the steps open below it
         only when the person opens the disclosure. -->
    <div class="footer">
      <div class="bar">
        {#if !editing}
          <Disclosure class="details" bind:open={stepsOpen}>
            {#snippet summary()}{card.steps}{/snippet}
            {#snippet children()}{/snippet}
          </Disclosure>
        {/if}
        <div class="actions">
          {#if editing}
            <DialogAction kind="cancel" class="tone-cancel" size="sm" type="button" disabled={working} onclick={stopEditing}>
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
      </div>
      {#if !editing && stepsOpen}
        <ol class="rows" aria-label={card.steps}>
          {#each proposal.steps as step (step.position)}
            <li>
              <div class="row">
                <span class="index" aria-hidden="true">{String(step.position).padStart(2, '0')}</span>
                <span class="what">
                  {#each fillParts(card.stepLine, {
                    assistant: $assistantName(step.assistant), action: humanizeId(step.action),
                  }) as part, index (index)}
                    {#if part.key === 'assistant'}<TextLink class="assistant glitch-host" href={assistantHref(step.assistant)}><AssistantIcon
                        class="glitch-icon" assistant={step.assistant} src={installedIconUrl(teamId, step.assistant)} size={18}
                      /><span class="glitch-text">{part.text}</span></TextLink>
                    {:else}<span class={part.key || 'joint'}>{part.text}</span>{/if}
                  {/each}
                </span>
                <!-- Each step reads or writes, each in its own color. -->
                <Tag size="xs" {...stepTag(step.read_only, card)} />
              </div>
              {#if step.inputs.length}
                <div class="inputs">
                  <Inputs inputs={step.inputs} words={(input) => proposalInputValue(input, card, copy.plan)} />
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>

  {#if working}<p class="note notice" role="status">{card.working}</p>{/if}
  {#if error}<p class="error notice" role="alert">{error}</p>{/if}
</section>
{/if}

<style>
  /* One cut-corner sheet: the heading, the agent's plain description, and any warning on top; a raised footer row with
     the steps' disclosure at its start and the buttons at its end, the steps opening below it. */
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
  p, h3, ol { margin: 0; }
  header { display: grid; gap: var(--shimpz-space-2); padding: var(--shimpz-space-4); }
  .kicker {
    display: flex;
    align-items: center;
    gap: var(--gap-item);
    color: var(--shimpz-color-cyan);
    font: var(--label);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .kicker :global(.routine-icon) { width: 0.8rem; height: 0.8rem; }
  .name { font: 700 1rem/1.3 var(--shimpz-font-mono); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .description { font-size: 0.86rem; line-height: 1.6; overflow-wrap: anywhere; }
  /* When it runs and what it shows: Team's own words, each under its small label. */
  .settings { display: grid; gap: var(--shimpz-space-1); margin: 0; }
  .settings > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-item); }
  .settings dt { color: var(--shimpz-color-text-dim); font: var(--label); letter-spacing: 0.12em; text-transform: uppercase; }
  .settings dd { margin: 0; overflow-wrap: anywhere; }
  .warning { display: flex; align-items: center; gap: var(--gap-item); color: var(--shimpz-color-yellow); font-size: 0.75rem; }
  .warning :global(.routine-icon) { width: 0.85rem; height: 0.85rem; }
  /* Scoped under the card, so the chat's own paragraph color never overrides these gray notes. */
  .routine-proposal .note { color: var(--shimpz-color-text-dim); font-size: 0.7rem; }
  header :global(.prompt textarea) { min-height: 6rem; font: 0.86rem/1.6 var(--shimpz-font-sans); resize: vertical; }
  /* The footer: a raised band whose row starts with the disclosure toggle and ends with the buttons. */
  .footer {
    display: grid;
    gap: var(--shimpz-space-2);
    padding: var(--shimpz-space-2) var(--shimpz-space-4);
    border-block-start: 1px solid var(--shimpz-color-border-subtle);
    border-radius: 0;
    background: var(--shimpz-color-surface-high);
  }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap-item); }
  .bar :global(.details) { border: 0; border-radius: 0; padding: 0; }
  .bar :global(.details > summary) { padding-block: var(--shimpz-space-1); }
  /* The steps render below the row, so the disclosure's own content box holds nothing. */
  .bar :global(.details > .content) { display: none; }
  .rows { display: grid; padding: 0; list-style: none; }
  .rows > li { display: grid; gap: var(--gap-inside); padding-block: var(--shimpz-space-2); }
  .rows > li + li { border-block-start: 1px dashed var(--shimpz-color-border-subtle); border-radius: 0; }
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
  /* A step's inputs wrap as one line of "Member: value" pairs under its Action, as a Routine's plan lists them. */
  .inputs {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--gap-inside) var(--gap-group);
    margin-inline-start: calc(var(--index) + var(--shimpz-space-2));
    color: var(--shimpz-color-text-muted);
    font-size: 0.76rem;
  }
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
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-item); margin-inline-start: auto; }
  .notice { justify-self: end; }
  .routine-result { color: var(--shimpz-color-text-muted); }
  .error { color: var(--shimpz-color-danger); font-size: 0.75rem; }
  @media (max-width: 420px) {
    .inputs { margin-inline-start: 0; }
  }
</style>
