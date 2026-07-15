<script>
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n.js';

  let {
    integration,
    values = $bindable({}),
    results = {},
    busy = {},
    saveBusy = false,
    saveMsg = '',
    saveNote = '',
    generated = [],
    contentFor,
    onClose,
    onValidate,
    onSave,
    onToggle,
  } = $props();

  let dialog;

  function handleKeydown(event) {
    if (event.key === 'Escape') onClose();
  }

  onMount(() => {
    const returnFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocus?.focus?.();
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<button class="backdrop" type="button" onclick={onClose} aria-label={$t('integration.close')}></button>
<div class="drawer" bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="integration-title" tabindex="-1">
  <header>
    <img src={`/integrations/${integration.logo}`} alt="" width="40" height="40" />
    <div class="title">
      <p>Integration // configure</p>
      <h2 id="integration-title">{integration.public_name}</h2>
      <span>{integration.blurb}</span>
    </div>
    <button class="icon-button" type="button" onclick={onClose} aria-label={$t('integration.close')}>✕</button>
  </header>

  <div class="body">
    {#if integration.auto_apply}
      <div class="toggle-row">
        <div>
          <span class="status-dot" class:on={integration.enabled}></span>
          <strong>{integration.enabled ? $t('integration.configured') : $t('integration.notSet')}</strong>
        </div>
        <button class="secondary small" type="button" onclick={() => onToggle(!integration.enabled)} disabled={saveBusy}>
          {integration.enabled ? $t('integration.disable') : $t('integration.enable')}
        </button>
      </div>
    {/if}

    {#each integration.fields.filter((field) => !field.generated) as field (field.key)}
      {@render fieldRow(field)}
    {/each}
  </div>

  <footer>
    {#if saveMsg === 'ok'}
      <div class="message success" role="status">{$t('integration.saved')}{saveNote ? ` — ${saveNote}` : ''}</div>
    {/if}
    {#if saveMsg === 'error'}<div class="message error" role="alert">{saveNote}</div>{/if}
    {#if generated.length}<p class="generated">◆ {$t('review.generatedNote')}</p>{/if}
    <button class="primary" type="button" onclick={onSave} disabled={saveBusy}>
      {saveBusy ? $t('integration.saving') : $t('integration.save')}
      <span aria-hidden="true">→</span>
    </button>
  </footer>
</div>

{#snippet fieldRow(field)}
  {@const content = contentFor(field)}
  <section class="field-row">
    <div class="field-head">
      <label for={field.key}><code>{field.key}</code></label>
      <span class:required={field.required} class="tag">
        {field.required ? $t('field.required') : $t('field.optional')}
      </span>
      {#if field.set}<span class="saved">{$t('field.saved')} {field.masked}</span>{/if}
    </div>

    {#if content.help}<p class="help">{content.help}</p>{/if}

    <div class="input-row">
      <input
        id={field.key}
        type={field.secret ? 'password' : 'text'}
        placeholder={field.set ? $t('field.replace') : ''}
        bind:value={values[field.key]}
        onblur={() => onValidate(field.key)}
        autocomplete={field.secret ? 'new-password' : 'off'}
        spellcheck="false"
      />
      <button
        class="secondary small"
        type="button"
        onclick={() => onValidate(field.key)}
        disabled={busy[field.key] || !(values[field.key] ?? '').trim()}
      >
        {busy[field.key] ? $t('field.testing') : field.live ? $t('field.test') : $t('field.check')}
      </button>
    </div>

    {#if results[field.key]}
      <p class:success={results[field.key].ok} class:error={!results[field.key].ok} class="result" role="status">
        {results[field.key].ok ? '✓' : '✕'} {results[field.key].detail}
      </p>
    {/if}

    {#if content.steps}
      <div class="steps">
        <ol>{#each content.steps as step, index (index)}<li>{step}</li>{/each}</ol>
        {#if content.link}
          <a href={content.link} target="_blank" rel="noopener noreferrer">
            {content.linkLabel ?? $t('field.open')} <span aria-hidden="true">↗</span>
          </a>
        {/if}
      </div>
    {/if}
  </section>
{/snippet}

<style>
  .backdrop {
    position: fixed;
    z-index: 40;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    padding: 0;
    background: rgba(0, 0, 0, 0.74);
    cursor: default;
    backdrop-filter: blur(3px);
  }

  .drawer {
    position: fixed;
    z-index: 50;
    inset-block: 0;
    inset-inline-end: 0;
    display: flex;
    width: min(38rem, 100%);
    flex-direction: column;
    border-inline-start: 1px solid var(--border-strong);
    background: var(--surface-1);
    box-shadow: -20px 0 70px rgba(0, 0, 0, 0.65);
    outline: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    padding: 1.4rem clamp(1rem, 4vw, 1.6rem);
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }

  header img {
    flex: none;
    object-fit: contain;
  }

  .title {
    min-width: 0;
    flex: 1;
  }

  .title p {
    margin: 0 0 0.25rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.61rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 1.2rem;
    letter-spacing: -0.03em;
  }

  .title > span {
    display: block;
    margin-top: 0.18rem;
    color: var(--text-dim);
    font-size: 0.78rem;
  }

  button {
    min-height: 2.75rem;
    border: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  button:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .icon-button {
    width: 2.75rem;
    flex: none;
    padding: 0;
    background: transparent;
    color: var(--text-faint);
  }

  .icon-button:hover {
    color: var(--accent);
  }

  .body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 clamp(1rem, 4vw, 1.6rem);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem;
    margin: 1rem 0 0.25rem;
    background: var(--surface-2);
    box-shadow: inset 0 0 0 1px var(--border);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  }

  .toggle-row > div {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.78rem;
  }

  .status-dot {
    width: 0.45rem;
    height: 0.45rem;
    background: var(--text-faint);
    border-radius: 50%;
  }

  .status-dot.on {
    background: var(--success);
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.5);
  }

  .field-row {
    padding: 1.15rem 0;
    border-bottom: 1px solid var(--border);
  }

  .field-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  label code {
    color: var(--text);
    font-size: 0.8rem;
  }

  .tag {
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border-strong);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.56rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .tag.required {
    border-color: rgba(255, 96, 125, 0.4);
    color: var(--danger);
  }

  .saved {
    color: var(--success);
    font-family: var(--font-mono);
    font-size: 0.66rem;
  }

  .help {
    margin: 0.5rem 0 0.65rem;
    color: var(--text-dim);
    font-size: 0.82rem;
    line-height: 1.55;
  }

  .input-row {
    display: flex;
    gap: 0.55rem;
  }

  input {
    width: 100%;
    min-width: 0;
    min-height: 2.85rem;
    flex: 1;
    border: 0;
    padding: 0.65rem 0.8rem;
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    outline: 0;
  }

  input:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
    filter: drop-shadow(0 0 6px rgba(0, 240, 255, 0.2));
  }

  .secondary {
    padding: 0 0.8rem;
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    color: var(--text-dim);
  }

  .secondary:hover:not(:disabled) {
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--accent);
  }

  .small {
    flex: none;
  }

  .result {
    margin: 0.55rem 0 0;
    font-family: var(--font-mono);
    font-size: 0.7rem;
  }

  .success {
    color: var(--success);
  }

  .error {
    color: var(--danger);
  }

  .steps {
    padding-inline-start: 0.9rem;
    margin-top: 0.7rem;
    border-inline-start: 1px solid var(--border-strong);
  }

  ol {
    padding-inline-start: 1.1rem;
    margin: 0;
    color: var(--text-dim);
    font-size: 0.76rem;
    line-height: 1.55;
  }

  li + li {
    margin-top: 0.35rem;
  }

  .steps a {
    display: inline-block;
    margin-top: 0.6rem;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    text-decoration: underline dashed var(--accent);
    text-underline-offset: 0.28em;
  }

  .steps a:hover {
    color: var(--accent);
    text-decoration-color: var(--accent-alt);
  }

  footer {
    display: grid;
    gap: 0.65rem;
    padding: 1rem clamp(1rem, 4vw, 1.6rem) 1.25rem;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }

  .message {
    padding: 0.65rem 0.75rem;
    border-inline-start: 2px solid currentColor;
    background: var(--bg);
    font-size: 0.78rem;
  }

  .generated {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.72rem;
  }

  .primary {
    display: flex;
    width: 100%;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    padding: 0 1rem;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    color: var(--accent-ink);
  }

  .primary:hover:not(:disabled) {
    filter: brightness(1.08) drop-shadow(0 0 10px rgba(0, 240, 255, 0.28));
  }

  @media (max-width: 520px) {
    .input-row {
      align-items: stretch;
      flex-direction: column;
    }

    .input-row .small {
      align-self: flex-start;
    }
  }
</style>
