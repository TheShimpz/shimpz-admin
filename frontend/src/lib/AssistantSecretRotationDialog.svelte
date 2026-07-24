<script>
  import { t } from '$lib/i18n.js';

  let { open = false, assistant = undefined, onclose = undefined, onsubmit = undefined } = $props();
  let dialog = $state();
  let values = $state({});
  let submitting = $state(false);
  let submitError = $state('');
  let activeAssistantId = $state('');
  let copy = $derived($t('assistantSecrets'));
  let management = $derived($t('assistantSecretManagement'));
  let complete = $derived(Object.values(values).some((value) => typeof value === 'string' && value.length > 0));

  function clearValues() { values = {}; submitError = ''; }
  function updateValue(secretId, event) { values = { ...values, [secretId]: event.currentTarget.value }; }
  function close(event) {
    event?.preventDefault();
    if (submitting) return;
    clearValues();
    onclose?.();
  }
  async function submit(event) {
    event.preventDefault();
    if (!assistant || !complete || submitting) return;
    submitting = true;
    submitError = '';
    const outgoing = assistant.secrets
      .filter((secret) => typeof values[secret.id] === 'string' && values[secret.id].length > 0)
      .map((secret) => ({ secret_id: secret.id, value: values[secret.id] }));
    try {
      await onsubmit?.(assistant.id, outgoing);
      clearValues();
    } catch {
      clearValues();
      submitError = management.failed;
    } finally {
      submitting = false;
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && assistant && !dialog.open) dialog.showModal();
    if ((!open || !assistant) && dialog.open) dialog.close();
  });
  $effect(() => {
    const assistantId = assistant?.id ?? '';
    if (assistantId === activeAssistantId) return;
    activeAssistantId = assistantId;
    clearValues();
  });
  $effect(() => { if (!open) clearValues(); });
</script>

<dialog bind:this={dialog} aria-labelledby="secret-rotation-title" oncancel={close}>
  <form class="dialog-panel" autocomplete="off" onsubmit={submit}>
    <header>
      <p>{copy.drawerKicker}</p>
      <h2 id="secret-rotation-title">{management.rotationTitle}</h2>
      <strong>{assistant?.name}</strong>
      <span>{management.rotationLead}</span>
    </header>
    <div class="fields">
      {#each assistant?.secrets ?? [] as secret (secret.id)}
        <label for={`rotate-${assistant.id}-${secret.id}`}>
          <span><strong>{secret.name}</strong><code>{secret.id}</code></span>
          <small>{secret.summary}</small>
          <input
            id={`rotate-${assistant.id}-${secret.id}`}
            type="password"
            value={values[secret.id] ?? ''}
            oninput={(event) => updateValue(secret.id, event)}
            maxlength="16384"
            placeholder={copy.placeholder}
            autocomplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            autocapitalize="none"
            spellcheck="false"
          />
        </label>
      {/each}
    </div>
    {#if submitError}<p class="error" role="alert">{submitError}</p>{/if}
    <footer>
      <button type="button" class="secondary" disabled={submitting} onclick={close}>{copy.cancel}</button>
      <button type="submit" class="primary" disabled={!complete || submitting}>{management.save}</button>
    </footer>
  </form>
</dialog>

<style>
  dialog { width: min(44rem, calc(100vw - 2rem)); max-height: 90dvh; border: 0; padding: 0; background: transparent; color: var(--text); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.86); backdrop-filter: blur(8px); }
  .dialog-panel { --pad: clamp(1.2rem, 3vw, 2rem); display: grid; max-height: 90dvh; grid-template-rows: auto minmax(0, 1fr) auto auto; padding: var(--pad); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px #000; clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut)); overflow: hidden; }
  header p { margin: 0 0 0.7rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.62rem; letter-spacing: 0.14em; text-transform: uppercase; }
  header h2 { margin: 0; font-size: clamp(1.4rem, 4vw, 2.3rem); }
  header strong { display: block; margin-top: 0.55rem; color: var(--accent); font-size: 0.72rem; }
  header span { display: block; margin: 0.5rem 0 1rem; color: var(--text-dim); font-size: 0.7rem; line-height: 1.5; }
  .fields { display: grid; min-height: 0; overflow-y: auto; border: 1px solid var(--border-strong); }
  label { display: grid; gap: 0.4rem; padding: 0.8rem; }
  label + label { border-top: 1px solid var(--border); }
  label > span { display: flex; justify-content: space-between; gap: 0.6rem; }
  label strong { font-size: 0.75rem; } label code { color: var(--accent); font-size: 0.56rem; }
  label small { color: var(--text-dim); font-size: 0.64rem; line-height: 1.45; }
  input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.7rem; background: #000; color: var(--text); font-family: var(--font-mono); }
  .error { margin: 0.7rem 0 0; color: var(--danger); font-size: 0.68rem; }
  footer { display: flex; margin: 1rem calc(0px - var(--pad)) calc(0px - var(--pad)); }
  footer button { width: 50%; min-height: 3.2rem; flex: 1 1 0; border: 0; cursor: pointer; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; text-transform: uppercase; }
  .secondary { box-shadow: inset 0 0 0 1px var(--border-strong); background: transparent; color: var(--text-dim); }
  .primary { background: var(--accent); color: var(--accent-ink); } button:disabled { opacity: 0.42; }
</style>
