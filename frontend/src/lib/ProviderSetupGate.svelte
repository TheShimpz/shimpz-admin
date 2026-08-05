<script>
  import { Button, Card, Notice, StatusBadge, TextField } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';
  import { configureModelContext, loadModelContext, modelContext } from '$lib/modelContext.js';


  let apiKey = $state('');
  let submitting = $state(false);
  let copy = $derived($t('providerSetup'));
  let selected = $derived($modelContext.providers.find((entry) => entry.id === $modelContext.provider) ?? null);
  let selectedModel = $derived(selected?.models.find((entry) => entry.id === $modelContext.model) ?? null);

  async function submit(event) {
    event.preventDefault();
    if (submitting || !$modelContext.teamId || !selected) return;
    submitting = true;
    try {
      await configureModelContext(fetch, $modelContext.teamId, selected.configured ? '' : apiKey);
      apiKey = '';
    } catch {
      apiKey = '';
    } finally {
      submitting = false;
    }
  }

  function retry() {
    if ($modelContext.teamId) loadModelContext(fetch, $modelContext.teamId).catch(() => {});
  }
</script>

<Card class="provider-gate" tone="accent" aria-labelledby="provider-gate-title">
  <div class="gate-mark" aria-hidden="true"><span></span></div>
  <p class="eyebrow">{copy.eyebrow}</p>
  <h2 id="provider-gate-title">{copy.title}</h2>
  <p class="lead">{copy.lead}</p>

  {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
    <p class="loading" role="status">{copy.loading}</p>
  {:else if !selected || !selectedModel}
    <Notice class="gate-error" variant="error">
      <span>{$modelContext.error || copy.loading}</span>
      <Button variant="secondary" size="compact" type="button" onclick={retry}>{copy.retry}</Button>
    </Notice>
  {:else}
    <form onsubmit={submit}>
      <dl>
        <div><dt>{copy.provider}</dt><dd>{selected.title}</dd></div>
        <div><dt>{copy.model}</dt><dd>{selectedModel.title}</dd></div>
      </dl>

      {#if selected.configured}
        <StatusBadge tone="success">{copy.verified}</StatusBadge>
      {/if}

      {#if !selected.configured}
        <TextField
            id="provider-api-key"
            label={copy.key}
            type="password"
            bind:value={apiKey}
            placeholder={copy.keyPlaceholder}
            minlength="16"
            maxlength="8192"
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            spellcheck="false"
            required
            disabled={submitting || $modelContext.phase === 'saving'}
          />
      {/if}

      {#if $modelContext.error}<Notice variant="error">{$modelContext.error}</Notice>{/if}
      <Button
        type="submit"
        disabled={submitting || $modelContext.phase === 'saving' || (!selected.configured && apiKey.trim().length < 16)}
      >
        {submitting || $modelContext.phase === 'saving'
          ? copy.validating
          : copy.startChatting}
      </Button>
    </form>
  {/if}
</Card>

<style>
  :global(.provider-gate) {
    width: min(30rem, calc(100% - 1.5rem));
    margin: auto;
  }
  :global(.provider-gate [data-slot="card-content"]) {
    display: grid;
    justify-items: center;
    text-align: center;
  }
  .gate-mark { display: grid; width: 2rem; height: 2rem; place-items: center; margin-bottom: 0.7rem; border: 1px solid var(--accent); transform: rotate(45deg); }
  .gate-mark span { width: 0.55rem; height: 0.55rem; background: var(--accent); box-shadow: 0 0 10px rgba(0, 240, 255, 0.6); }
  .eyebrow { margin: 0 0 0.45rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(1.3rem, 3.5vw, 1.8rem); letter-spacing: -0.045em; }
  .lead { max-width: 27rem; margin: 0.6rem 0 0; color: var(--text-dim); font-size: 0.82rem; line-height: 1.5; }
  form { display: grid; width: 100%; gap: 0.65rem; margin-top: 1rem; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border: 1px solid var(--admin-divider); }
  dl div { display: grid; gap: 0.25rem; padding: 0.7rem; text-align: start; }
  dl div + div { border-inline-start: 1px solid var(--admin-divider); }
  dt { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.09em; text-transform: uppercase; }
  dd { min-width: 0; margin: 0; overflow: hidden; font-family: var(--font-mono); font-size: 0.68rem; text-overflow: ellipsis; white-space: nowrap; }
  .loading { margin: 1rem 0 0; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.68rem; }
  @media (max-width: 520px) { dl { grid-template-columns: 1fr; } dl div + div { border-inline-start: 0; border-top: 1px solid var(--admin-divider); } }
</style>
