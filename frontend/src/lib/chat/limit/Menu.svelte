<script>
  import { Button } from '@shimpz/frontend';

  import ComposerPanel from '#lib/brain/ComposerPanel.svelte';
  import { commandsReady, outcomeUnknown } from '#lib/session/socket.js';
  import { chatLimit, MAX_CHAT_LIMIT, saveChatLimit } from '#lib/chat/limit/store.js';
  import { t } from '#lib/i18n/index.js';
  import { focusMark, regainFocus } from '#lib/shell/focus.js';

  // How many conversations the Space runs at once (ADR-0119), in its own composer control. Team owns the limit; the
  // control shows the one Admin read, and a change shows only that it is under way until the limit is read again.
  let { disabled = false } = $props();

  let open = $state(false);
  let panel = $state();
  let saving = $state(false);
  let error = $state('');
  const choices = Array.from({ length: MAX_CHAT_LIMIT }, (_, index) => index + 1);

  let copy = $derived($t('chatLimitMenu'));
  let limit = $derived($chatLimit.value);
  let phase = $derived(saving ? 'saving' : $chatLimit.status === 'error' ? 'unavailable' : limit ? 'ready' : 'loading');
  let blocked = $derived(saving || !$commandsReady);

  async function choose(value) {
    if (phase !== 'ready' || blocked || value === limit) return;
    saving = true;
    error = '';
    const mark = focusMark();
    try {
      await saveChatLimit(value);
    } catch (failed) {
      error = outcomeUnknown(failed) ? $t('shell.outcomeUnknown') : copy.failed;
    }
    saving = false;
    void regainFocus(() => panel?.querySelector(`[data-limit="${value}"]`), { shown: () => open, since: mark });
  }
</script>

<ComposerPanel
  bind:open
  bind:panel
  label={limit ? `${copy.label}: ${limit}` : copy.label}
  {disabled}
  busy={phase === 'loading' || blocked}
  focusTarget={'[aria-pressed="true"], .limit-choice'}
  content={phase}
  onclose={() => { error = ''; }}
>
  {#snippet icon()}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h11M19 5v14"></path></svg>
  {/snippet}
  {#snippet children(panelId)}
    <p class="title" id={`${panelId}-title`}>{copy.label}</p>
    <p class="summary">{copy.summary}</p>
    {#if phase === 'unavailable'}
      <p class="status" role="status">{copy.unavailable}</p>
    {:else if phase === 'loading'}
      <p class="status">…</p>
    {:else}
      <div class="choices" role="group" aria-label={copy.label}>
        {#each choices as value (value)}
          <Button
            class="limit-choice"
            type="button"
            size="sm"
            variant={value === limit ? 'primary' : 'secondary'}
            aria-pressed={value === limit}
            data-limit={value}
            disabled={blocked}
            onclick={() => choose(value)}
          >
            {value}
          </Button>
        {/each}
      </div>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {/snippet}
</ComposerPanel>

<style>
  .choices { display: flex; gap: var(--gap-inside); }
</style>
