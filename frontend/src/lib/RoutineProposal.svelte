<script>
  import { Button } from '@shimpz/frontend';

  import { assistantNames, loadAssistantNames } from '$lib/assistantNames.js';
  import { loadTeamRoutines } from '$lib/routineContext.js';
  import {
    confirmRoutineProposal,
    displayZone,
    dispositionWords,
    fillRoutineCopy,
    humanizeId,
    instantWords,
    proposalInputWords,
    revokeRoutineProposal,
    routineErrorMessage,
    scheduleWords,
  } from '$lib/routine.js';

  // The card of a Routine a recording turn recorded (ADR-0101 section 5.2), under its reply: everything the person
  // confirms, in full and as escaped text — its name, schedule, timezone, next runs, daily cap, what each run does
  // with its result, every step with whether it changes something and each input with where its value comes from, the
  // Actions it may call. It states facts only: the work ran once now, and approvals ask on every run. Exactly two
  // buttons, none preselected or recommended: Create confirms the card, Cancel revokes it. A card past its
  // lifetime offers neither and says so.
  let { teamId, proposal, copy, locale } = $props();

  let card = $derived(copy.proposal);
  let working = $state(false);
  // `created`, `changed`, or `revoked` once the person answered; the card then gives way to one line saying so.
  let answer = $state('');
  let error = $state('');
  let now = $state(Date.now());
  let expired = $derived(now >= Date.parse(proposal.expires_at));

  const assistantName = (id) => $assistantNames[id] ?? humanizeId(id);

  $effect(() => { void loadAssistantNames(fetch); });

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
      const result = await action(fetch, teamId, proposal.proposal_id);
      answer = result.status;
      if (result.status !== 'revoked') await loadTeamRoutines(fetch, teamId).catch(() => {});
    } catch (failure) {
      error = routineErrorMessage(failure, copy.errors);
    } finally {
      working = false;
    }
  }

  const changeWords = (readOnly) => (readOnly ? card.reads : card.changes);
</script>

{#if answer}
  <p class="routine-result" role="status">{card[answer]}</p>
{:else if !expired}
<section class="routine-proposal" aria-label={card.title}>
  <header>
    <p class="kicker">{card.title}</p>
    <h3 class="name">{proposal.name}</h3>
    {#if proposal.replaces}<p class="dim">{fillRoutineCopy(card.replaces, { name: proposal.name })}</p>{/if}
  </header>

  <dl class="facts">
    <div><dt>{card.schedule}</dt><dd>{scheduleWords(proposal.schedule, copy.schedule, locale)}</dd></div>
    <div>
      <dt>{card.timezone}</dt>
      <dd>{proposal.timezone_source === 'none'
        ? fillRoutineCopy(card.timezoneFallback, { timezone: proposal.timezone })
        : proposal.timezone}</dd>
    </div>
    <div>
      <dt>{card.nextRuns}</dt>
      <dd>
        <ul class="runs">
          {#each proposal.next_runs as run (run)}
            <li><time datetime={run}>{instantWords(run, locale, displayZone(proposal))}</time></li>
          {/each}
        </ul>
      </dd>
    </div>
    <div>
      <dt>{fillRoutineCopy(card.dailyCap, { cap: new Intl.NumberFormat(locale).format(proposal.daily_cap) })}</dt>
    </div>
    <div>
      <dt>{card.output}</dt>
      <dd>{dispositionWords({ ...proposal.output, step: proposal.steps.length }, copy.plan)}</dd>
    </div>
  </dl>

  <h4>{card.steps}</h4>
  <ol class="steps">
    {#each proposal.steps as step (step.position)}
      <li>
        <p class="step">
          {fillRoutineCopy(card.stepLine, {
            n: step.position, assistant: assistantName(step.assistant), action: humanizeId(step.action),
          })}
          <span class={['effect', !step.read_only && 'effect--changes']}>{changeWords(step.read_only)}</span>
        </p>
        {#if step.inputs.length}
          <dl class="inputs">
            {#each step.inputs as input (input.member)}
              {@const words = proposalInputWords(input, card, copy.plan)}
              <div>
                <dt>{humanizeId(input.member)}</dt>
                <dd>{#if words.value}<span class="value">{words.value}</span>{/if}<span class="origin">{words.origin}</span></dd>
              </div>
            {/each}
          </dl>
        {/if}
      </li>
    {/each}
  </ol>

  {#if proposal.permitted.length}
    <h4>{card.permitted}</h4>
    <ul class="permitted">
      {#each proposal.permitted as item (`${item.assistant}\u0000${item.action}`)}
        <li>{assistantName(item.assistant)} · {humanizeId(item.action)}
          <span class={['effect', !item.read_only && 'effect--changes']}>{changeWords(item.read_only)}</span></li>
      {/each}
    </ul>
  {/if}

  <ul class="statements">
    <li>{card.ranOnce}</li>
    <li>{card.approvals}</li>
  </ul>

  <div class="actions">
      <Button size="sm" variant="secondary" type="button" disabled={working}
        onclick={() => settle(confirmRoutineProposal)}>{card.confirm}</Button>
      <Button size="sm" variant="secondary" type="button" disabled={working}
        onclick={() => settle(revokeRoutineProposal)}>{card.cancel}</Button>
    </div>
    {#if working}<p class="dim" role="status">{card.working}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
{/if}

<style>
  /* One bordered sheet under the reply: mono labels, plain values, and two equal buttons at its foot. */
  .routine-proposal {
    display: grid;
    gap: var(--gap-group);
    max-width: 68ch;
    margin-block-start: var(--gap-group);
    padding: var(--gap-panel);
    border: 1px solid var(--shimpz-color-border);
    border-radius: var(--shimpz-radius-md, 6px);
    color: var(--shimpz-color-text);
    font-size: 0.85rem;
  }
  header { display: grid; gap: var(--gap-inside); }
  p, h3, h4, ul, ol, dl { margin: 0; }
  .kicker, h4, dt {
    color: var(--shimpz-color-text-dim);
    font: 600 0.62rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .name { font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
  .facts { display: grid; gap: var(--gap-item); }
  .facts > div { display: grid; gap: var(--gap-inside); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .runs, .steps, .permitted, .statements { display: grid; gap: var(--gap-item); padding: 0; list-style: none; }
  .steps > li { display: grid; gap: var(--gap-inside); }
  .step { font-weight: 600; overflow-wrap: anywhere; }
  .effect { margin-inline-start: var(--gap-item); color: var(--shimpz-color-text-dim); font-weight: 400; font-size: 0.75rem; }
  .effect--changes { color: var(--shimpz-color-yellow); }
  .inputs { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--gap-inside) var(--gap-item); padding-inline-start: var(--gap-group); }
  .inputs > div { display: contents; }
  .inputs dt { font: 0.78rem/1.4 var(--shimpz-font-sans); letter-spacing: 0; text-transform: none; }
  .inputs dd { display: grid; gap: var(--gap-inside); }
  .value { font: 0.76rem/1.4 var(--shimpz-font-mono); }
  .origin, .dim { color: var(--shimpz-color-text-dim); font-size: 0.75rem; }
  .statements { color: var(--shimpz-color-text-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--gap-group); }
  .routine-result { color: var(--shimpz-color-text-muted); }
  .error { color: var(--shimpz-color-danger); }
</style>
