<script>
  import { DialogFrame, Modal, Notice } from '@shimpz/frontend';

  import DialogAction from '$lib/DialogAction.svelte';
  import { locale } from '$lib/i18n.js';
  import { fillRoutineCopy, instantWords, readRunDiagnostics, routineErrorMessage } from '$lib/routine.js';

  // One Routine run's execution details (ADR-0092 section 8): Team's sanitized record of each failed attempt. Every
  // text member is literal evidence shown as escaped text, never Markdown or HTML, and never proof of what changed.
  let { teamId, runId, copy, errors, onclose } = $props();

  const id = $props.id();
  let dialog = $state();
  let diagnostics = $state(null);
  let error = $state('');

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  $effect(() => {
    let current = true;
    readRunDiagnostics(fetch, teamId, runId)
      .then((value) => { if (current) diagnostics = value; })
      .catch((failure) => { if (current) error = routineErrorMessage(failure, errors); });
    return () => { current = false; };
  });

  function conditionWords(condition) {
    const exit = condition.match(/^exit-status:(-?\d+)$/);
    if (exit) return fillRoutineCopy(copy.conditions.exit, { code: exit[1] });
    return {
      'stderr-output': copy.conditions.stderr,
      timeout: copy.conditions.timeout,
      'frame-invalid': copy.conditions.frame,
      'exit-unavailable': copy.conditions.exitUnavailable,
      'transport-failed': copy.conditions.transport,
    }[condition];
  }

  function close(event) {
    event?.preventDefault();
    dialog?.close();
    onclose();
  }
</script>

<Modal bind:element={dialog} labelledBy={`${id}-title`} oncancel={close}>
  <DialogFrame title={copy.open} titleId={`${id}-title`} lead={copy.lead}>
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
              {fillRoutineCopy(copy.attempt, { assistant: item.assistant_id, action: item.action, attempt: item.attempt })}
            </p>
            <p class="muted">{fillRoutineCopy(copy.recorded, { at: instantWords(item.recorded_at, $locale) })}</p>
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
              <p>{conditionWords(item.condition)}</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    {#snippet footer()}
      <DialogAction kind="cancel" type="button" onclick={close}>{copy.close}</DialogAction>
    {/snippet}
  </DialogFrame>
</Modal>

<style>
  .attempts { display: grid; gap: var(--shimpz-space-3); margin: 0; padding: 0; list-style: none; }
  .attempts li { display: grid; gap: var(--shimpz-space-1); padding-block-end: var(--shimpz-space-2); border-block-end: 1px solid var(--shimpz-color-border-subtle); }
  .attempts li:last-child { border-block-end: 0; }
  .heading { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .muted { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; }
  p { margin: 0; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px var(--shimpz-space-3); margin: 0; font-size: 0.8rem; }
  dt { color: var(--shimpz-color-text-muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; }
  pre { margin: 0; max-height: 12rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 0.75rem/1.4 var(--shimpz-font-mono); }
</style>
