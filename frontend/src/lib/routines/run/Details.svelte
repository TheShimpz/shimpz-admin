<script>
  import { Notice } from '@shimpz/frontend';

  import { locale } from '#lib/i18n/index.js';
  import { fill } from '#lib/i18n/fill.js';
  import RoutineModal from '#lib/routines/Modal.svelte';
  import RoutineRunSteps from '#lib/routines/run/Steps.svelte';
  import { RunDiagnostics, entryBinding } from '#lib/routines/run/diagnostics.svelte.js';
  import { attemptWords, conditionWords, instantWords, routineErrorMessage } from '#lib/routines/words.js';

  // One Routine run's execution details (ADR-0092 section 8): its own step records, read page by page for its
  // historical revision (ADR-0092 amendment, 2026-10-05, scale), then Team's sanitized record of each failed attempt.
  // Every text member is literal evidence shown as escaped text, never Markdown or HTML, and never proof of what
  // changed. It closes from its header, as every Routine modal does. `copy` is the whole Routine copy; the run is the
  // history `entry` of one run.
  let { teamId, entry, copy: routineCopy, onclose } = $props();

  let copy = $derived(routineCopy.details);
  let errors = $derived(routineCopy.errors);
  let runId = $derived(entry.runId);
  let binding = $derived(entryBinding(entry));

  const id = $props.id();
  const reading = new RunDiagnostics();
  let diagnostics = $derived(reading.value);
  let error = $derived(reading.failure === null ? '' : routineErrorMessage(reading.failure, errors));

  $effect(() => reading.read(teamId, runId));
</script>

<RoutineModal class="routine-run-details" size="md" title={copy.open} {onclose}>
  <div class="content">
    <p class="muted">{copy.lead}</p>
    <section class="records" aria-labelledby={`${id}-steps`}>
      <h3 id={`${id}-steps`}>{routineCopy.result.steps}</h3>
      <RoutineRunSteps {teamId} {runId} {binding} copy={routineCopy} locale={$locale} />
    </section>
    {#if error}
      <Notice variant="error">{error}</Notice>
    {:else if diagnostics === null}
      <p class="muted" role="status">{copy.loading}</p>
    {:else if diagnostics.length === 0}
      <p class="muted">{copy.empty}</p>
    {:else}
      <ol class="attempts">
        {#each diagnostics as item (`${item.operation_id}:${item.attempt}`)}
          <li>
            <p class="heading">
              {attemptWords(item, copy.attempt)}
            </p>
            <p class="muted">{fill(copy.recorded, { at: instantWords(item.recorded_at, $locale) })}</p>
            {#if item.failure}
              <dl>
                <dt>{copy.type}</dt><dd><code>{item.failure.error_type}</code></dd>
                {#if item.failure.http_status !== null}<dt>{copy.status}</dt><dd>{item.failure.http_status}</dd>{/if}
                {#if item.failure.provider !== null}<dt>{copy.provider}</dt><dd><code>{item.failure.provider}</code></dd>{/if}
                {#if item.failure.message}<dt>{copy.message}</dt><dd class="text">{item.failure.message}</dd>{/if}
                {#if item.failure.response_excerpt !== null}
                  <dt>{copy.excerpt}</dt><dd><pre>{item.failure.response_excerpt}</pre></dd>
                {/if}
              </dl>
              {#if item.failure.redacted}<p class="muted">{copy.redacted}</p>{/if}
              {#if item.failure.truncated}<p class="muted">{copy.truncated}</p>{/if}
            {:else}
              <p>{conditionWords(item.condition, copy)}</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</RoutineModal>

<style>
  .content { display: grid; flex: 1 1 auto; align-content: start; gap: var(--gap-group); min-height: 0; padding: var(--gap-panel); overflow: auto; }
  .records { display: grid; gap: var(--gap-item); }
  h3 { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; font-weight: 600; }
  .attempts { display: grid; gap: var(--gap-item); margin: 0; padding: 0; list-style: none; }
  .attempts li { display: grid; gap: var(--gap-inside); padding-block-end: var(--gap-item); border-block-end: 1px solid var(--shimpz-color-border-subtle); }
  .attempts li:last-child { border-block-end: 0; }
  .heading { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .muted { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--gap-inside) var(--gap-item); margin: 0; font-size: 0.8rem; }
  dt { color: var(--shimpz-color-text-muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; }
  pre { margin: 0; max-height: 12rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 0.75rem/1.4 var(--shimpz-font-mono); }
</style>
