<script>
  import { Disclosure } from '@shimpz/frontend';

  import DialogAction from '#lib/DialogAction.svelte';
  import { assistantName } from '#lib/assistants/names.js';
  import { humanizeId } from '#lib/ids.js';
  import RoutineIcon from '#lib/routines/Icon.svelte';
  import RoutineStep from '#lib/routines/Step.svelte';
  import Tag from '#lib/routines/Tag.svelte';

  import { call, commandsReady } from '#lib/session/socket.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import { refreshTeamRoutines } from '#lib/routines/context.js';
  import { confirmRoutineProposal, revokeRoutineProposal } from '#lib/routines/protocol.js';
  import { outputChoiceWords, proposalInputValue, proposalWhen, routineFailureWords } from '#lib/routines/words.js';
  import { recoverFocus } from '#lib/shell/focus.js';

  // The card of a refinement (ADR-0122), under its reply: an existing Routine's next revision. It says what changes
  // (each step added, replacing another, or removed) beside the description, when the Routine runs and what each run
  // shows in Team's own fixed words, which a refinement keeps, and whether each run now shows another step's result.
  // Its footer row holds a closed disclosure listing the complete resulting plan, each step tagged with its change, and
  // two buttons, neither preselected: Cancel revokes the card and Apply confirms it. All of it is escaped text. A card past
  // its lifetime is no longer shown. `answered` is how the person already answered this card, kept in the transcript;
  // `onleave` hears that an answer took the card out of the chat.
  let { teamId, refinement, copy, answered, onleave } = $props();

  let stepsOpen = $state(false);
  let card = $derived(copy.proposal);
  let words = $derived(copy.refinement);
  let working = $state(false);
  let given = $state('');
  let answer = $derived(answered || given);
  let error = $state('');
  let now = $state(Date.now());
  let expired = $derived(now >= Date.parse(refinement.expires_at));

  $effect(() => {
    const left = Date.parse(refinement.expires_at) - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => (now = Date.now()), Math.min(left, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });

  // What changes, in plan order: each added or replacing step where it now stands, then each step that went.
  let changed = $derived([
    ...refinement.steps.filter((step) => step.change !== 'kept').map((step) => ({ ...step, at: step.position })),
    ...refinement.removed.filter((step) => step.change === 'removed').map((step) => ({ ...step, at: step.position })),
  ]);
  let writes = $derived(refinement.steps.some((step) => !step.read_only));
  const TONES = { added: 'accent', replaced: 'warning', removed: 'danger' };

  function stepWords(step) {
    return fill(words[step.change === 'removed' ? 'was' : 'at'], {
      n: step.at,
      assistant: $assistantName(step.assistant),
      action: humanizeId(step.action),
    });
  }

  async function settle(action) {
    working = true;
    error = '';
    try {
      const result = await action(call, teamId, refinement.proposal_id);
      given = result.status;
      onleave();
      if (result.status !== 'revoked') await refreshTeamRoutines(teamId);
    } catch (failure) {
      error = routineFailureWords(failure, copy.errors, $t('shell.outcomeUnknown'));
    } finally {
      working = false;
    }
  }
</script>

{#if answer === 'revoked'}
  <p class="routine-result" role="status">{words.revoked}</p>
{:else if answer}
  <!-- Its Routine was changed; the answer's own message says so. -->
{:else if !expired}
<section class="routine-refinement" aria-label={card.title} {@attach recoverFocus}>
  <div class="sheet admin-frame">
    <header>
      <p class="kicker"><RoutineIcon name="edit" />{card.title}</p>
      <h3 class="name">{fill(words.heading, { name: refinement.name })}</h3>
      <p class="description">{refinement.description}</p>
      <dl class="settings">
        <div><dt>{card.whenLabel}</dt><dd>{proposalWhen(refinement, copy, $locale)}</dd></div>
        <div><dt>{card.outputLabel}</dt><dd>{outputChoiceWords(refinement.output, card.questions)}</dd></div>
      </dl>
      {#if changed.length}
        <ul class="changes" aria-label={words.changes}>
          {#each changed as step (`${step.change}:${step.at}`)}
            <li><Tag size="xs" tone={TONES[step.change]} label={words.change[step.change]} /><span>{stepWords(step)}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="note">{words.unchanged}</p>
      {/if}
      {#if refinement.last_changed}<p class="note">{fill(words.lastChanged, { n: refinement.steps.length })}</p>{/if}
      {#if writes}<p class="warning"><RoutineIcon name="warning" />{card.changes}</p>{/if}
    </header>

    <div class="footer">
      <div class="bar">
        <Disclosure class="details" bind:open={stepsOpen}>
          {#snippet summary()}{words.plan}{/snippet}
          {#snippet children()}{/snippet}
        </Disclosure>
        <div class="actions">
          <DialogAction kind="cancel" class="tone-cancel" size="sm" type="button" disabled={working || !$commandsReady}
            onclick={() => settle(revokeRoutineProposal)}>{card.cancel}</DialogAction>
          <DialogAction kind="confirm" size="sm" type="button" disabled={working || !$commandsReady}
            onclick={() => settle(confirmRoutineProposal)}>{words.confirm}</DialogAction>
        </div>
      </div>
      {#if stepsOpen}
        <ol class="rows" aria-label={words.plan}>
          {#each refinement.steps as step (step.position)}
            <RoutineStep {teamId} position={step.position} assistant={step.assistant} action={step.action}
              readOnly={step.read_only} inputs={step.inputs} words={(input) => proposalInputValue(input, card, copy.plan)}
              copy={card}>
              {#snippet status()}
                {#if step.change !== 'kept'}<Tag size="xs" tone={TONES[step.change]} label={words.change[step.change]} />{/if}
              {/snippet}
            </RoutineStep>
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
  /* The recording card's sheet (Proposal.svelte): the heading, description, settings, and changes on top; a raised footer
     row with the plan's disclosure at its start and the buttons at its end, the plan opening below it. */
  .routine-refinement {
    --label: 600 0.6rem/1.5 var(--shimpz-font-mono);
    display: grid;
    gap: var(--gap-item);
    max-width: 62ch;
    margin-block-start: var(--gap-group);
  }
  .sheet { position: relative; display: grid; color: var(--shimpz-color-text); font-size: 0.8rem; line-height: 1.55; }
  p, h3, ol, ul { margin: 0; }
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
  .settings { display: grid; gap: var(--shimpz-space-1); margin: 0; }
  .settings > div { display: flex; flex-wrap: wrap; gap: 0 var(--gap-item); }
  .settings dt { color: var(--shimpz-color-text-dim); font: var(--label); letter-spacing: 0.12em; text-transform: uppercase; }
  .settings dd { margin: 0; overflow-wrap: anywhere; }
  .changes { display: grid; gap: var(--shimpz-space-1); padding: 0; list-style: none; }
  .changes li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap-item); overflow-wrap: anywhere; }
  .warning { display: flex; align-items: center; gap: var(--gap-item); color: var(--shimpz-color-yellow); font-size: 0.75rem; }
  .warning :global(.routine-icon) { width: 0.85rem; height: 0.85rem; }
  .routine-refinement .note { color: var(--shimpz-color-text-dim); font-size: 0.7rem; }
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
  .bar :global(.details > .content) { display: none; }
  .rows { display: grid; padding: 0; list-style: none; }
  .actions :global(.tone-cancel) {
    --button-color: var(--shimpz-color-danger);
    --button-border: transparent !important;
    --button-bg: color-mix(in srgb, var(--shimpz-color-danger) 8%, var(--shimpz-color-surface));
    --button-hover-bg: var(--shimpz-color-danger);
    --button-hover-color: #fff;
  }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--gap-item); margin-inline-start: auto; }
  .notice { justify-self: end; }
  .routine-result { color: var(--shimpz-color-text-muted); }
  .error { color: var(--shimpz-color-danger); font-size: 0.75rem; }
</style>
