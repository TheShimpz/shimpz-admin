<script>
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

<section class="provider-gate" aria-labelledby="provider-gate-title">
  <div class="gate-mark" aria-hidden="true"><span></span></div>
  <p class="eyebrow">{copy.eyebrow}</p>
  <h2 id="provider-gate-title">{copy.title}</h2>
  <p class="lead">{copy.lead}</p>

  {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
    <p class="loading" role="status">{copy.loading}</p>
  {:else if !selected || !selectedModel}
    <div class="gate-error" role="alert">
      <span>{$modelContext.error || copy.loading}</span>
      <button type="button" onclick={retry}>{copy.retry}</button>
    </div>
  {:else}
    <form onsubmit={submit}>
      <dl>
        <div><dt>{copy.provider}</dt><dd>{selected.title}</dd></div>
        <div><dt>{copy.model}</dt><dd>{selectedModel.title}</dd></div>
      </dl>

      {#if selected.configured}
        <p class="verification">
          <span aria-hidden="true">✓</span>
          {copy.verified}
        </p>
      {/if}

      {#if !selected.configured}
        <label>
          <span>{copy.key}</span>
          <input
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
        </label>
      {/if}

      {#if $modelContext.error}<p class="gate-error" role="alert">{$modelContext.error}</p>{/if}
      <button
        class="unlock"
        type="submit"
        disabled={submitting || $modelContext.phase === 'saving' || (!selected.configured && apiKey.trim().length < 16)}
      >
        {submitting || $modelContext.phase === 'saving'
          ? copy.validating
          : copy.startChatting}
      </button>
    </form>
  {/if}
</section>

<style>
  .provider-gate {
    display: grid;
    width: min(34rem, calc(100% - 2rem));
    justify-items: center;
    margin: auto;
    padding: clamp(1.3rem, 4vw, 2.2rem);
    text-align: center;
  }
  .gate-mark { display: grid; width: 2.4rem; height: 2.4rem; place-items: center; margin-bottom: 0.9rem; border: 1px solid var(--accent); transform: rotate(45deg); }
  .gate-mark span { width: 0.55rem; height: 0.55rem; background: var(--accent); box-shadow: 0 0 10px rgba(0, 240, 255, 0.6); }
  .eyebrow { margin: 0 0 0.45rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.15rem); letter-spacing: -0.05em; }
  .lead { max-width: 29rem; margin: 0.75rem 0 0; color: var(--text-dim); font-size: 0.76rem; line-height: 1.55; }
  form { display: grid; width: 100%; gap: 0.8rem; margin-top: 1.25rem; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border: 1px solid var(--admin-divider); }
  dl div { display: grid; gap: 0.25rem; padding: 0.7rem; text-align: start; }
  dl div + div { border-inline-start: 1px solid var(--admin-divider); }
  dt, label > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.09em; text-transform: uppercase; }
  dd { min-width: 0; margin: 0; overflow: hidden; font-family: var(--font-mono); font-size: 0.68rem; text-overflow: ellipsis; white-space: nowrap; }
  .verification { margin: 0; color: var(--success); font-family: var(--font-mono); font-size: 0.62rem; letter-spacing: 0.05em; text-transform: uppercase; }
  label { display: grid; gap: 0.35rem; text-align: start; }
  input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: #020304; color: var(--text); font-family: var(--font-mono); }
  input:focus-visible { border-color: var(--border-strong); }
  button { min-height: 2.7rem; border: 1px solid var(--border-strong); padding: 0 0.85rem; background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  button.unlock { border: 0; background: linear-gradient(90deg, var(--accent), #8feaf3 55%, var(--accent-alt)); color: #001013; }
  button:disabled { cursor: not-allowed; opacity: 0.42; }
  .loading { margin: 1rem 0 0; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.68rem; }
  .gate-error { display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.7rem; margin: 0; color: var(--danger); font-size: 0.66rem; line-height: 1.45; }
  @media (max-width: 520px) { dl { grid-template-columns: 1fr; } dl div + div { border-inline-start: 0; border-top: 1px solid var(--admin-divider); } }
</style>
