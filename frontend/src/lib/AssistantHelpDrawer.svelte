<script>
  import { locale, t } from '$lib/i18n.js';
  import { getAssistantHelp } from '$lib/localApi.js';
  import HelpMarkdown from '$lib/HelpMarkdown.svelte';

  let { open = false, teamId = '', assistants = [], onclose = undefined } = $props();


  let selectedId = $state('');
  let phase = $state('idle');
  let markdown = $state('');
  let closeButton = $state();
  let requestSequence = 0;

  let copy = $derived($t('assistantHelp'));
  let activeId = $derived(
    assistants.some((assistant) => assistant.id === selectedId)
      ? selectedId
      : (assistants[0]?.id ?? ''),
  );
  function changeAssistant(event) {
    selectedId = event.currentTarget.value;
  }

  function handleKeydown(event) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      onclose?.();
    }
  }

  $effect(() => {
    if (!open) return;
    const button = closeButton;
    queueMicrotask(() => button?.focus());
  });

  $effect(() => {
    const currentTeam = teamId;
    const currentAssistant = activeId;
    const currentLocale = $locale;
    if (!open || !currentTeam || !currentAssistant) {
      phase = 'idle';
      markdown = '';
      return;
    }

    const sequence = ++requestSequence;
    phase = 'loading';
    markdown = '';
    getAssistantHelp(fetch, currentTeam, currentAssistant, currentLocale)
      .then((result) => {
        if (sequence !== requestSequence || !open || teamId !== currentTeam || activeId !== currentAssistant) return;
        markdown = result.markdown;
        phase = 'ready';
      })
      .catch(() => {
        if (sequence !== requestSequence || !open || teamId !== currentTeam || activeId !== currentAssistant) return;
        phase = 'error';
      });
    return () => { requestSequence += 1; };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<aside id="assistant-help-drawer" aria-labelledby="assistant-help-title" hidden={!open}>
  <header>
    <p id="assistant-help-title">{copy.kicker}</p>
    <button bind:this={closeButton} type="button" onclick={() => onclose?.()} aria-label={copy.close} title={copy.close}>×</button>
  </header>

  {#if assistants.length > 1}
    <div class="picker">
      <label for="assistant-help-select">{copy.choose}</label>
      <select id="assistant-help-select" value={activeId} onchange={changeAssistant}>
        {#each assistants as assistant (assistant.id)}
          <option value={assistant.id}>{assistant.name}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="help-content" aria-live="polite">
    {#if phase === 'loading'}
      <p class="status">{copy.loading}</p>
    {:else if phase === 'error'}
      <p class="status error" role="alert">{copy.failed}</p>
    {:else if phase === 'ready'}
      <HelpMarkdown {markdown} />
    {/if}
  </div>
</aside>

<style>
  aside {
    display: grid;
    width: min(25rem, 34vw);
    height: 100vh;
    height: 100dvh;
    min-width: 18rem;
    min-height: 0;
    max-height: 100dvh;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 0.8rem;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    padding: 1rem;
    background: #050708;
    overflow: hidden;
  }

  aside[hidden] { display: none; }
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.75rem; }
  header { grid-row: 1; }
  header p, label { margin: 0 0 0.25rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.12em; text-transform: uppercase; }
  button { display: grid; width: 2.25rem; height: 2.25rem; place-items: center; border: 1px solid var(--border-strong); padding: 0; background: transparent; color: var(--accent); cursor: pointer; font-size: 1.1rem; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .picker { grid-row: 2; }
  label { display: block; color: var(--text-faint); }
  select { width: 100%; min-height: 2.55rem; border: 1px solid var(--border-strong); padding: 0 2rem 0 0.7rem; background: #020405; color: var(--text); font-family: var(--font-mono); font-size: 0.68rem; }
  .help-content { grid-row: 3; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 0.25rem; }
  .status { margin: 1rem 0; color: var(--text-faint); font-size: 0.72rem; }
  .status.error { color: var(--danger); }

  @media (max-width: 820px) {
    aside { position: fixed; z-index: 110; inset-block: 0; inset-inline-end: 0; width: min(90vw, 25rem); min-width: 0; box-shadow: -1rem 0 2rem rgba(0, 0, 0, 0.65); }
  }
</style>
