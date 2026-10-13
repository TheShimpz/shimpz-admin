<script>
  import { AssistantIcon, ChatTask } from '@shimpz/frontend';
  import { catalogIconUrl, installedIconUrl } from '#lib/assistants/icons.js';
  import { installPlanIconStatus, installPlanStatus, installPlanVisualState } from '#lib/chat/turns.js';
  import AssistantMeta from '#lib/chat/lifecycle/AssistantMeta.svelte';

  // The Assistants a chat turn installs, one task card each (ADR-0066). `teamId` is the shown Team, whose installed
  // icons the cards show; `words` are the chat's (chat/turns.js).
  let { plan, teamId, words } = $props();

  function iconSource(assistant) {
    if (assistant.status === 'installed' && teamId) return installedIconUrl(teamId, assistant.id);
    if (assistant.provenance === 'local') return undefined;
    return catalogIconUrl(assistant.id);
  }
</script>

<div
  class="assistant-install-plan"
  role="group"
  aria-label={words.install.label}
>
  {#each plan.assistants as assistant (assistant.id)}
    {#snippet planMedia()}
      <AssistantIcon
        assistant={assistant.id}
        src={iconSource(assistant)}
        status={installPlanIconStatus(assistant)}
        size={44}
      />
    {/snippet}
    {#snippet planMeta()}<AssistantMeta local={assistant.provenance === 'local'} creator={assistant.creator} version={assistant.version} />{/snippet}
    {#snippet planDetails()}
      {#if assistant.status === 'failed' && plan.status}
        <span class="assistant-lifecycle-detail-copy">
          HTTP {plan.status}
        </span>
      {/if}
    {/snippet}
    <ChatTask
      class="assistant-lifecycle-task"
      label={words.install.label}
      title={assistant.name}
      meta={planMeta}
      description={assistant.summary}
      state={installPlanVisualState(assistant.status)}
      status={installPlanStatus(
        assistant.status,
        plan.outcome,
        words,
      )}
      media={planMedia}
      details={assistant.status === 'failed' ? planDetails : undefined}
    />
  {/each}
</div>

<style>
  .assistant-install-plan { display: grid; gap: var(--gap-item); margin-block-start: var(--gap-group); }
</style>
