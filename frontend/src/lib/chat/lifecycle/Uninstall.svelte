<script>
  import { AssistantIcon, ChatTask } from '@shimpz/frontend';
  import { installedIconUrl } from '#lib/assistants/icons.js';
  import { lifecycleStatus, lifecycleVisualState } from '#lib/chat/turns.js';
  import AssistantMeta from '#lib/chat/lifecycle/AssistantMeta.svelte';
  import DialogAction from '#lib/DialogAction.svelte';
  import Markdown from '#lib/chat/Markdown.svelte';
  import { escapeMarkdownText } from '#lib/chat/markdown.js';
  import { fill } from '#lib/i18n/fill.js';

  // One Assistant uninstall a chat turn proposed (ADR-0066): its card with Cancel and Uninstall while it waits for the
  // Supervisor, then how it went, and once Team's inventory confirms it, the outcome in the Team's words. `teamId` is
  // the shown Team, whose installed icon the card shows until its snapshot replaces it; `author` the Team's name;
  // `disabled` holds the decision while it cannot be sent; `ondecide('yes' | 'no')` sends it.
  let { lifecycle, author, teamId, words, disabled, ondecide } = $props();

  let lifecycleMessages = $derived(words.uninstall);

  function iconSource() {
    if (lifecycle.state === 'uninstalled') return lifecycle.iconSnapshot;
    if (!teamId) return undefined;
    return installedIconUrl(teamId, lifecycle.assistant.id);
  }

  function outcome() {
    if (lifecycle.state !== 'uninstalled') return '';
    const reply = fill(lifecycle.uninstalled ? lifecycleMessages.uninstalledReply : lifecycleMessages.absentReply, {
      assistant: escapeMarkdownText(lifecycle.assistant.name),
      version: escapeMarkdownText(lifecycle.assistant.version),
      team: escapeMarkdownText(author),
    });
    return `${reply}\n\n${lifecycleMessages.reinstall}`;
  }
</script>

{#snippet lifecycleMedia()}
  <AssistantIcon
    assistant={lifecycle.assistant.id}
    src={iconSource()}
    status={lifecycle.state === 'uninstalled' ? 'failed' : 'loading'}
    size={44}
  />
{/snippet}
{#snippet lifecycleMeta()}<AssistantMeta local={lifecycle.assistant.provenance === 'local'} creator={lifecycle.assistant.creator} version={lifecycle.assistant.version} />{/snippet}
{#snippet lifecycleDetails()}
  <div class="assistant-lifecycle-details">
    {#if lifecycle.state === 'proposed'}
      <div class="assistant-lifecycle-actions">
        <DialogAction
          kind="cancel"
          size="compact"
          type="button"
          onclick={() => ondecide('no')}
          {disabled}
          aria-label={fill(lifecycleMessages.cancelActionLabel, { assistant: lifecycle.assistant.name })}
        >
          {lifecycleMessages.cancelAction}
        </DialogAction>
        <DialogAction
          kind="danger"
          size="compact"
          type="button"
          onclick={() => ondecide('yes')}
          {disabled}
          aria-label={fill(lifecycleMessages.uninstallActionLabel, { assistant: lifecycle.assistant.name })}
        >
          {lifecycleMessages.uninstallAction}
        </DialogAction>
      </div>
    {/if}
    {#if lifecycle.status}
      <span class="assistant-lifecycle-detail-copy">HTTP {lifecycle.status}</span>
    {/if}
  </div>
{/snippet}
<ChatTask
  class={['assistant-lifecycle-task', lifecycle.state === 'proposed' && 'assistant-uninstall-proposed']}
  id={`assistant-lifecycle-${lifecycle.proposal_id}`}
  label={lifecycleMessages.label}
  title={lifecycle.assistant.name}
  meta={lifecycleMeta}
  description={lifecycleMessages.consequences}
  state={lifecycleVisualState(lifecycle.state)}
  status={lifecycleStatus(lifecycle, words)}
  media={lifecycleMedia}
  details={lifecycle.state === 'proposed' || lifecycle.status
    ? lifecycleDetails
    : undefined}
  tabindex={lifecycle.state === 'working' ? -1 : undefined}
/>
{#if lifecycle.state === 'uninstalled' && lifecycle.completionAnnounced}
  <div class="assistant-lifecycle-outcome">
    <Markdown
      markdown={outcome()}
      variant="chat"
    />
  </div>
{/if}

<style>
  .assistant-lifecycle-outcome { padding-block-start: var(--gap-group); }

  /* An uninstall waiting for the person's decision is framed in the danger colour, like its Uninstall action. */
  :global(.shimpz-chat-task.assistant-lifecycle-task.assistant-uninstall-proposed) {
    --task-color: var(--shimpz-color-danger);
    border-color: color-mix(in srgb, var(--shimpz-color-danger) 30%, transparent);
  }
  /* Its Cancel reads neutral white beside the red Uninstall. */
  :global(.assistant-uninstall-proposed .assistant-lifecycle-actions .shimpz-button.shimpz-button--secondary) {
    --button-color: var(--shimpz-color-text);
    --button-border: color-mix(in srgb, var(--shimpz-color-text) 30%, transparent) !important;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-details) {
    display: grid;
    gap: var(--gap-item);
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-actions) {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--gap-group);
    margin-block-start: var(--gap-item);
  }
</style>
