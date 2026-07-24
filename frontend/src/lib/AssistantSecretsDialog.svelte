<script>
  import { t } from '$lib/i18n.js';

  let {
    open = false,
    challenge = undefined,
    onclose = undefined,
    onsubmit = undefined,
  } = $props();

  let dialog = $state();
  let values = $state({});
  let submitting = $state(false);
  let submitError = $state('');
  let activeChallengeId = $state('');

  let copy = $derived($t('assistantSecrets'));
  let fields = $derived.by(() => (challenge?.requirements ?? []).flatMap((requirement) => (
    requirement.secrets.map((secret) => ({
      assistantId: requirement.assistant_id,
      secretId: secret.id,
      key: `${requirement.assistant_id}\u0000${secret.id}`,
    }))
  )));
  let complete = $derived(
    fields.length > 0 && fields.every((field) => typeof values[field.key] === 'string' && values[field.key].length > 0),
  );

  function clearValues() {
    values = {};
    submitError = '';
  }

  function updateValue(key, event) {
    values = { ...values, [key]: event.currentTarget.value };
  }

  function close() {
    if (submitting) return;
    clearValues();
    onclose?.();
  }

  function cancel(event) {
    event.preventDefault();
    close();
  }

  function submit(event) {
    event.preventDefault();
    if (submitting || !complete || !challenge) return;
    submitting = true;
    submitError = '';
    const outgoing = fields.map((field) => ({
      assistant_id: field.assistantId,
      secret_id: field.secretId,
      value: values[field.key],
    }));
    try {
      onsubmit?.(challenge.challenge_id, outgoing);
      clearValues();
    } catch {
      clearValues();
      submitError = copy.submitFailed;
    } finally {
      submitting = false;
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && challenge && !dialog.open) dialog.showModal();
    if ((!open || !challenge) && dialog.open) dialog.close();
  });

  $effect(() => {
    const challengeId = challenge?.challenge_id ?? '';
    if (challengeId === activeChallengeId) return;
    activeChallengeId = challengeId;
    clearValues();
  });

  $effect(() => {
    if (!open) clearValues();
  });
</script>

<dialog bind:this={dialog} aria-labelledby="assistant-secret-dialog-title" oncancel={cancel}>
  <form class="dialog-panel" autocomplete="off" onsubmit={submit}>
    <header>
      <p>{copy.dialogKicker}</p>
      <h2 id="assistant-secret-dialog-title">{copy.dialogTitle}</h2>
      <span>{copy.dialogLead}</span>
    </header>

    <div class="requirements">
      {#each challenge?.requirements ?? [] as requirement (requirement.assistant_id)}
        <fieldset>
          <legend>
            <strong>{requirement.assistant_name}</strong>
            <code>{requirement.assistant_id}</code>
          </legend>
          <div class="powers">
            <span>{copy.powers}</span>
            <div>
              {#each requirement.power_ids as powerId (powerId)}<code>{powerId}</code>{/each}
            </div>
          </div>
          <div class="secret-fields">
            {#each requirement.secrets as secret (secret.id)}
              {@const fieldKey = `${requirement.assistant_id}\u0000${secret.id}`}
              {@const inputId = `secret-${requirement.assistant_id}-${secret.id}`}
              <label for={inputId}>
                <span class="secret-title">
                  <strong>{secret.name}</strong>
                  <code>{secret.id}</code>
                </span>
                <span id={`${inputId}-summary`} class="secret-summary">{secret.summary}</span>
                <span class="value-label">{copy.value}</span>
                <input
                  id={inputId}
                  type="password"
                  value={values[fieldKey] ?? ''}
                  oninput={(event) => updateValue(fieldKey, event)}
                  aria-describedby={`${inputId}-summary`}
                  placeholder={copy.placeholder}
                  maxlength="16384"
                  autocomplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  autocapitalize="none"
                  spellcheck="false"
                  required
                />
              </label>
            {/each}
          </div>
        </fieldset>
      {/each}
    </div>

    <p class="privacy">{copy.privacy}</p>
    {#if submitError}<p class="dialog-error" role="alert">{submitError}</p>{/if}

    <footer>
      <button type="button" class="secondary" disabled={submitting} onclick={close}>{copy.cancel}</button>
      <button type="submit" class="primary" disabled={submitting || !complete}>
        {submitting ? copy.submitting : copy.submit}
      </button>
    </footer>
  </form>
</dialog>

<style>
  dialog {
    width: min(46rem, calc(100vw - 2rem));
    max-height: min(90vh, 90dvh);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.84); backdrop-filter: blur(8px); }
  .dialog-panel {
    --dialog-pad: clamp(1.2rem, 3.5vw, 2rem);
    display: grid;
    max-height: min(90vh, 90dvh);
    grid-template-rows: auto minmax(0, 1fr) auto auto auto;
    padding: var(--dialog-pad);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.7);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    overflow: hidden;
  }
  .dialog-panel > header > p { margin: 0 0 0.75rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.65rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; }
  .dialog-panel > header h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.35rem); letter-spacing: -0.05em; }
  .dialog-panel > header span { display: block; margin: 0.7rem 0 1.1rem; color: var(--text-dim); font-size: 0.75rem; line-height: 1.6; }
  .requirements { display: grid; min-height: 0; gap: 0.85rem; overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 0.2rem; }
  fieldset { min-width: 0; margin: 0; border: 1px solid var(--border-strong); padding: 0; background: #030506; }
  legend { display: flex; max-width: calc(100% - 1rem); align-items: baseline; gap: 0.55rem; margin-inline-start: 0.6rem; padding: 0 0.35rem; }
  legend strong { font-size: 0.78rem; }
  legend code { color: var(--accent); font-size: 0.55rem; overflow-wrap: anywhere; }
  .powers { display: grid; gap: 0.35rem; padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); }
  .powers > span, .value-label { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.53rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .powers > div { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .powers code { border: 1px solid var(--border-strong); padding: 0.16rem 0.35rem; color: var(--accent); font-size: 0.54rem; }
  .secret-fields { display: grid; }
  .secret-fields label { display: grid; min-width: 0; gap: 0.35rem; padding: 0.75rem; }
  .secret-fields label + label { border-top: 1px solid var(--border); }
  .secret-title { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.45rem; }
  .secret-title strong { font-size: 0.75rem; }
  .secret-title code { color: var(--accent); font-size: 0.55rem; }
  .secret-summary { color: var(--text-dim); font-size: 0.67rem; line-height: 1.5; }
  .value-label { margin-top: 0.15rem; }
  input { width: 100%; min-height: 2.7rem; border: 1px solid var(--border-strong); padding: 0 0.7rem; background: #000; color: var(--text); font-family: var(--font-mono); font-size: 0.72rem; }
  input:focus { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .privacy { margin: 0.8rem 0 0; border-inline-start: 2px solid var(--accent); padding: 0.55rem 0.7rem; color: var(--text-faint); font-size: 0.64rem; line-height: 1.5; }
  .dialog-error { margin: 0.7rem 0 0; color: var(--danger); font-size: 0.7rem; }
  footer { display: flex; margin: 1rem calc(0px - var(--dialog-pad)) calc(0px - var(--dialog-pad)); }
  footer button { width: 100%; min-height: 3rem; flex: 1 1 0; border: 0; padding: 0 1rem; cursor: pointer; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; text-transform: uppercase; }
  footer .secondary { box-shadow: inset 0 0 0 1px var(--border-strong); background: transparent; color: var(--text-dim); }
  footer .primary { background: var(--accent); color: var(--accent-ink); }
  footer button:disabled { cursor: not-allowed; opacity: 0.42; }

  @media (max-width: 640px) {
    dialog { width: calc(100vw - 1rem); }
    .dialog-panel { --dialog-pad: 1rem; max-height: 94dvh; }
    .secret-title { display: grid; }
  }
</style>
