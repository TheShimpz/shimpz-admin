<script>
  import Markdown from '$lib/Markdown.svelte';
  import { fillRoutineCopy } from '$lib/routine.js';

  // One Routine outcome in a Team's transcript (ADR-0086). It names the Routine by its quoted request and never
  // carries an Action's raw input or result; it is not part of the Brain's conversation.
  let { entry, copy } = $props();

  let detail = $derived(entry.detail);
  let actions = $derived(
    (detail.actions ?? []).map(([assistant, action]) => `${assistant} · ${action}`).join(', '),
  );
  let summary = $derived.by(() => {
    const run = copy.run;
    switch (entry.outcome) {
      case 'done': return run.done;
      case 'needs-input': return fillRoutineCopy(run.needsInput, { question: detail.question });
      case 'failed': return fillRoutineCopy(run.failed, { code: detail.code });
      case 'denied': return run.denied;
      case 'stopped': return run.stopped;
      case 'uncertain': return run.uncertain;
      case 'skipped': return fillRoutineCopy(run.skipped, { missed: detail.missed });
      case 'scope-changed': return fillRoutineCopy(run.scopeChanged, { assistants: detail.assistants.join(', ') });
      default:
        return fillRoutineCopy(detail.request_kind === 'human' ? run.frozenHuman : run.frozenIntegrations, {
          assistant: detail.assistant_id,
          action: detail.action,
        });
    }
  });
  let tone = $derived(
    ['failed', 'denied', 'uncertain'].includes(entry.outcome)
      ? 'bad'
      : ['frozen', 'needs-input', 'scope-changed'].includes(entry.outcome)
        ? 'waiting'
        : 'neutral',
  );
</script>

<div class={['routine-run', tone]}>
  <p class="label">{copy.run.label} · <span class="quote">{entry.quote}</span></p>
  <p class="summary">{summary}</p>
  {#if entry.outcome === 'done'}
    <Markdown markdown={detail.reply} variant="chat" />
  {/if}
  {#if actions}
    <p class="actions">{fillRoutineCopy(copy.run.actions, { actions })}</p>
  {/if}
</div>

<style>
  .routine-run { display: grid; gap: var(--shimpz-space-1); }
  .label { margin: 0; color: var(--shimpz-color-cyan); font: 700 0.7rem/1.4 var(--shimpz-font-mono); letter-spacing: 0.08em; text-transform: uppercase; overflow-wrap: anywhere; }
  .quote { color: var(--shimpz-color-text-muted); letter-spacing: 0; text-transform: none; font-family: var(--shimpz-font-sans); font-weight: 600; }
  .summary { margin: 0; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .bad .summary { color: var(--shimpz-color-danger); }
  .waiting .summary { color: var(--shimpz-color-yellow); }
  .actions { margin: 0; color: var(--shimpz-color-text-muted); font-size: 0.8rem; overflow-wrap: anywhere; }
</style>
