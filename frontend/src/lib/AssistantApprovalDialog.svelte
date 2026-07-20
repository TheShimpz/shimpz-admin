<script>
  import { assistantApprovalsCopy } from '$lib/assistantApprovalsCopy.js';
  import { locale } from '$lib/i18n.js';

  let { open = false, challenge = undefined, oncancel = undefined, onapprove = undefined } = $props();
  let dialog = $state();
  let copy = $derived(assistantApprovalsCopy($locale));

  function cancel(event) {
    event?.preventDefault();
    oncancel?.();
  }

  $effect(() => {
    if (!dialog) return;
    if (open && challenge && !dialog.open) dialog.showModal();
    if ((!open || !challenge) && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} aria-labelledby="assistant-approval-title" oncancel={cancel}>
  <section class="dialog-panel">
    <header>
      <p>{copy.kicker}</p>
      <h2 id="assistant-approval-title">{copy.title}</h2>
      <span>{copy.lead}</span>
    </header>

    <div class="requirements">
      {#each challenge?.requirements ?? [] as requirement, index (`${requirement.assistant_id}:${requirement.power_id}:${index}`)}
        <article>
          <header>
            <div>
              <strong>{requirement.assistant_name}</strong>
              <code>{requirement.assistant_id}</code>
            </div>
            <code>{requirement.power_id}</code>
          </header>
          <p>{requirement.power_summary}</p>
          <span class="policy">{requirement.approval === 'once' ? copy.once : copy.always}</span>
          <span class="input-label">{copy.input}</span>
          <pre><code>{JSON.stringify(requirement.input, null, 2)}</code></pre>
        </article>
      {/each}
    </div>

    <footer>
      <button type="button" class="secondary" onclick={cancel}>{copy.cancel}</button>
      <button type="button" class="primary" onclick={() => onapprove?.()}>{copy.approve}</button>
    </footer>
  </section>
</dialog>

<style>
  dialog { width: min(48rem, calc(100vw - 2rem)); max-height: 90dvh; border: 0; padding: 0; background: transparent; color: var(--text); }
  dialog::backdrop { background: rgba(0, 0, 0, 0.86); backdrop-filter: blur(8px); }
  .dialog-panel { --pad: clamp(1.2rem, 3vw, 2rem); display: grid; max-height: 90dvh; grid-template-rows: auto minmax(0, 1fr) auto; padding: var(--pad); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px #000; clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut)); overflow: hidden; }
  .dialog-panel > header p { margin: 0 0 0.7rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
  .dialog-panel > header h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.45rem); letter-spacing: -0.05em; }
  .dialog-panel > header span { display: block; margin: 0.7rem 0 1.1rem; color: var(--text-dim); font-size: 0.72rem; line-height: 1.55; }
  .requirements { display: grid; min-height: 0; gap: 0.8rem; overflow-y: auto; overscroll-behavior: contain; }
  article { display: grid; gap: 0.6rem; border: 1px solid var(--border-strong); padding: 0.85rem; background: #030506; }
  article > header { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; }
  article > header div { display: grid; gap: 0.18rem; }
  article strong { font-size: 0.8rem; }
  article code { color: var(--accent); font-size: 0.58rem; overflow-wrap: anywhere; }
  article p { margin: 0; color: var(--text); font-size: 0.72rem; line-height: 1.5; }
  .policy { border-inline-start: 2px solid var(--warn); padding-inline-start: 0.55rem; color: var(--text-dim); font-size: 0.64rem; line-height: 1.45; }
  .input-label { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.54rem; letter-spacing: 0.1em; text-transform: uppercase; }
  pre { max-height: 14rem; margin: 0; border: 1px solid var(--border); padding: 0.7rem; background: #000; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  pre code { color: var(--text-dim); font-size: 0.62rem; line-height: 1.5; }
  footer { display: flex; margin: 1rem calc(0px - var(--pad)) calc(0px - var(--pad)); }
  footer button { width: 50%; min-height: 3.2rem; flex: 1 1 0; border: 0; cursor: pointer; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 700; text-transform: uppercase; }
  footer .secondary { box-shadow: inset 0 0 0 1px var(--border-strong); background: transparent; color: var(--text-dim); }
  footer .primary { background: var(--accent); color: var(--accent-ink); }
  @media (max-width: 640px) { dialog { width: calc(100vw - 1rem); } .dialog-panel { --pad: 1rem; max-height: 94dvh; } }
</style>
