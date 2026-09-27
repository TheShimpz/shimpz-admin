<script>
  import { DropdownMenu } from '@shimpz/frontend';

  import { showAdminNotice } from '$lib/adminNotice.js';
  import { t } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain } from '$lib/modelContext.js';
  import { teamContext } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  let options = $derived(
    $modelContext.providers.flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      label: model.title,
      provider: provider.id,
      model: model.id,
      title: model.title,
    }))),
  );
  let selected = $derived(
    options.find((entry) => (
      entry.provider === $modelContext.provider && entry.model === $modelContext.model
    )) ?? null,
  );
  let unavailable = $derived(
    disabled
      || !$teamContext.selectedTeamId
      || $teamContext.phase === 'loading'
      || ['idle', 'loading', 'saving'].includes($modelContext.phase),
  );
  let triggerLabel = $derived(selected?.title ?? $t('chatContext.modelLoading'));

  async function choose(value) {
    const teamId = $teamContext.selectedTeamId;
    const option = options.find((entry) => entry.value === value);
    if (!teamId || !option || unavailable || option.value === selected?.value) return;
    try {
      await selectTeamBrain(fetch, teamId, option.provider, option.model);
    } catch {
      showAdminNotice({ tone: 'error', label: $t('brainMenu.label'), message: $t('chatContext.modelFailed') });
    }
  }
</script>

<fieldset class="brain-menu" disabled={unavailable}>
  <DropdownMenu
    items={options}
    value={selected?.value}
    ariaLabel={$t('brainMenu.current', { model: triggerLabel })}
    menuLabel={$t('brainMenu.label')}
    {triggerLabel}
    onSelect={choose}
  >
    {#snippet triggerIcon()}
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10"></rect>
        <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"></path>
      </svg>
    {/snippet}
  </DropdownMenu>
</fieldset>

<style>
  .brain-menu { min-width: 0; margin: 0; padding: 0; border: 0; }
  .brain-menu :global(.shimpz-dropdown) { max-width: 16rem; }
  .brain-menu svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .brain-menu:disabled { opacity: 0.6; }
</style>
