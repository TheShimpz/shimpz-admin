<script>
  import { onMount, tick } from 'svelte';
  import AssistantHelpDrawer from '$lib/AssistantHelpDrawer.svelte';
  import ChatContextControls from '$lib/ChatContextControls.svelte';
  import HelpMarkdown from '$lib/HelpMarkdown.svelte';
  import { locale } from '$lib/i18n.js';
  import { modelContext } from '$lib/modelContext.js';
  import ProviderSetupGate from '$lib/ProviderSetupGate.svelte';
  import ShimpzThinking from '$lib/ShimpzThinking.svelte';
  import { teamContext } from '$lib/teamContext.js';
  import {
    CHAT_WS_PROTOCOL,
    chatSocketUrl,
    createChatFrame,
    createStopFrame,
    parseChatTerminalEvent,
  } from '$lib/localChat.js';

  const COPY = {
    en: {
      kicker: 'Team // Chat', title: 'Your Team',
      placeholder: 'Message {team}…', send: 'Send', sending: '{team} is thinking…', you: 'You',
      stop: 'Stop', stopped: 'The active turn was stopped.',
      emptyTeams: 'Create a Team below to start chatting.',
      loading: 'Loading your Team…', loadFailed: 'Local chat data is unavailable.',
      connecting: 'Connecting…', disconnected: 'The secure chat connection was interrupted. Reconnecting…',
      protocolError: 'The secure chat response was invalid.',
      turnFailed: 'The chat turn could not start.', capacityFailed: 'The local chat is busy. Try again shortly.',
      runtimeFailed: 'The local chat runtime is unavailable.', requestFailed: 'The Team could not complete this turn.',
      technicalDetail: 'Technical detail',
      help: 'Assistant Help',
    },
    pt: {
      kicker: 'Time // Chat', title: 'Seu Time',
      placeholder: 'Envie uma mensagem para {team}…', send: 'Enviar', sending: '{team} está pensando…', you: 'Você',
      stop: 'Parar', stopped: 'O turno ativo foi interrompido.',
      emptyTeams: 'Crie um Time abaixo para começar a conversar.',
      loading: 'Carregando seu Time…', loadFailed: 'Os dados do chat local estão indisponíveis.',
      connecting: 'Conectando…', disconnected: 'A conexão segura do chat foi interrompida. Reconectando…',
      protocolError: 'A resposta segura do chat era inválida.',
      turnFailed: 'Não foi possível iniciar o turno do chat.', capacityFailed: 'O chat local está ocupado. Tente novamente em instantes.',
      runtimeFailed: 'O runtime do chat local está indisponível.', requestFailed: 'O Time não conseguiu concluir este turno.',
      technicalDetail: 'Detalhe técnico',
      help: 'Ajuda dos Assistants',
    },
    es: { help: 'Ayuda de Assistants' },
    zh: { help: 'Assistant 帮助' },
    fr: { help: 'Aide des Assistants' },
    de: { help: 'Assistant-Hilfe' },
    ja: { help: 'Assistant ヘルプ' },
    ar: { help: 'مساعدة الـ Assistants' },
  };

  let mounted = false;
  let socketTeamId = '';
  let draft = $state('');
  let turns = $state([]);
  let busy = $state(false);
  let stopping = $state(false);
  let error = $state('');
  let errorDetail = $state('');
  let socket = $state(null);
  let socketReady = $state(false);
  let reconnectTimer;
  let reconnectAttempt = 0;
  let helpOpen = $state(false);
  let helpButton = $state();
  let turnsViewport = $state();
  let scrollRequest = 0;

  let copy = $derived({ ...COPY.en, ...(COPY[$locale] ?? {}) });
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === selectedTeamId) ?? null,
  );
  let chatTeamId = $derived(
    $modelContext.ready && $modelContext.teamId === selectedTeamId ? selectedTeamId : '',
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived(copy.placeholder.replace('{team}', teamName));
  let thinking = $derived(copy.sending.replace('{team}', teamName));
  let helpAssistants = $derived.by(() => {
    const catalog = new Map($teamContext.catalog.map((assistant) => [assistant.id, assistant]));
    const selected = new Set($teamContext.selectedAssistantIds);
    return $teamContext.installedAssistants
      .filter((runtime) => runtime.status === 'running' && selected.has(runtime.assistant))
      .map((runtime) => ({
        id: runtime.assistant,
        name: catalog.get(runtime.assistant)?.name ?? runtime.assistant,
      }));
  });
  let contextLoading = $derived(
    $teamContext.phase === 'idle' || $teamContext.phase === 'loading',
  );
  let contextFailed = $derived($teamContext.phase === 'error');
  let contextErrorDetail = $derived(
    contextFailed &&
      typeof $teamContext.error === 'string' &&
      $teamContext.error === $teamContext.error.trim() &&
      $teamContext.error.length > 0 &&
      $teamContext.error.length <= 300
      ? $teamContext.error
      : '',
  );
  let visibleError = $derived(error || (contextFailed ? copy.loadFailed : ''));
  let visibleErrorDetail = $derived(error ? errorDetail : contextErrorDetail);

  function clearError() {
    error = '';
    errorDetail = '';
  }

  function setError(message, detail = '') {
    error = message;
    errorDetail = detail;
  }

  async function revealLatestTurn() {
    const request = ++scrollRequest;
    await tick();
    if (request !== scrollRequest || !turnsViewport) return;
    const latest = turnsViewport.querySelector('article:last-of-type');
    if (!latest) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    turnsViewport.scrollTo({
      top: Math.max(0, latest.offsetTop - 16),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }

  function friendlyChatError(status) {
    if (status === 409) return copy.turnFailed;
    if (status === 429) return copy.capacityFailed;
    if (status === 503) return copy.runtimeFailed;
    return copy.requestFailed;
  }

  function closeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const current = socket;
    socket = null;
    socketReady = false;
    current?.close(1000, 'Team changed');
  }

  function scheduleReconnect(expectedTeamId) {
    if (reconnectTimer || !mounted || chatTeamId !== expectedTeamId) return;
    const delay = Math.min(400 * (2 ** reconnectAttempt), 5000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (mounted && chatTeamId === expectedTeamId) connectSocket(expectedTeamId);
    }, delay);
  }

  function connectSocket(expectedTeamId) {
    closeSocket();
    if (!mounted || !expectedTeamId || chatTeamId !== expectedTeamId) return;

    const expectedTeam = $teamContext.teams.find((entry) => entry.id === expectedTeamId);
    if (!expectedTeam) return;

    let active;
    try {
      active = new WebSocket(chatSocketUrl(location, expectedTeamId), CHAT_WS_PROTOCOL);
    } catch {
      setError(copy.protocolError);
      return;
    }
    socket = active;

    active.onopen = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      if (active.protocol !== CHAT_WS_PROTOCOL) {
        socket = null;
        active.close(1002, 'Protocol required');
        setError(copy.protocolError);
        return;
      }
      reconnectAttempt = 0;
      socketReady = true;
      if (error === copy.disconnected) clearError();
    };
    active.onmessage = (event) => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      let terminal;
      try {
        if (typeof event.data !== 'string' || (!busy && !stopping)) throw new Error('unexpected frame');
        terminal = parseChatTerminalEvent(
          JSON.parse(event.data),
          expectedTeam.id,
          expectedTeam.name,
        );
      } catch {
        socket = null;
        socketReady = false;
        busy = false;
        stopping = false;
        setError(copy.protocolError);
        active.close(1002, 'Invalid terminal event');
        return;
      }

      busy = false;
      stopping = false;
      if (terminal.type === 'done') {
        turns = [...turns, { role: 'assistant', text: terminal.reply, author: terminal.team_name }];
        void revealLatestTurn();
        clearError();
      } else if (terminal.type === 'stopped') {
        setError(copy.stopped);
      } else {
        setError(
          friendlyChatError(terminal.status),
          `HTTP ${terminal.status} · ${terminal.detail}`,
        );
      }
    };
    active.onclose = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      socket = null;
      socketReady = false;
      stopping = false;
      if (busy) busy = false;
      setError(copy.disconnected);
      scheduleReconnect(expectedTeamId);
    };
  }

  function activateTeam(nextTeamId) {
    closeSocket();
    socketTeamId = nextTeamId;
    reconnectAttempt = 0;
    busy = false;
    stopping = false;
    draft = '';
    turns = [];
    scrollRequest += 1;
    helpOpen = false;
    clearError();
    if (nextTeamId) connectSocket(nextTeamId);
  }

  function closeHelp() {
    helpOpen = false;
    queueMicrotask(() => helpButton?.focus());
  }

  function send(event) {
    event.preventDefault();
    const teamId = $teamContext.selectedTeamId;
    if (busy || !teamId || chatTeamId !== teamId || !draft.trim() || !socketReady || !socket) return;
    const message = draft.trim();
    let frame;
    try {
      frame = createChatFrame(teamId, {
        message,
        files: $teamContext.selectedFileIds,
        assistant_ids: $teamContext.selectedAssistantIds,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      return;
    }
    busy = true;
    clearError();
    turns = [...turns, { role: 'user', text: message }];
    void revealLatestTurn();
    draft = '';
    try {
      socket.send(JSON.stringify(frame));
    } catch (reason) {
      busy = false;
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      socket.close();
    }
  }

  function handleComposerKeydown(event) {
    if (
      event.key !== 'Enter' ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing
    ) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function stop() {
    const teamId = $teamContext.selectedTeamId;
    if (!busy || stopping || !teamId || !socketReady || !socket) return;
    stopping = true;
    clearError();
    try {
      socket.send(JSON.stringify(createStopFrame(teamId)));
    } catch (reason) {
      stopping = false;
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      socket.close();
    }
  }

  $effect(() => {
    const nextTeamId = chatTeamId;
    if (!mounted || nextTeamId === socketTeamId) return;
    activateTeam(nextTeamId);
  });

  $effect(() => {
    if (helpOpen && helpAssistants.length === 0) helpOpen = false;
  });

  onMount(() => {
    mounted = true;
    const initialTeamId = chatTeamId;
    if (initialTeamId !== socketTeamId) activateTeam(initialTeamId);
    return () => {
      mounted = false;
      closeSocket();
    };
  });
</script>

<svelte:head><title>{teamName} — Shimpz Admin</title></svelte:head>

<div class="chat-route">
  {#if activeTeam}
    {#if chatTeamId}
      <div class="chat-workspace" class:help-open={helpOpen}>
        <section class="conversation" class:empty-conversation={turns.length === 0} aria-label={teamName}>
        <div class="turns" bind:this={turnsViewport} aria-live="polite">
          {#each turns as turn}
            <article
              class={turn.role}
              aria-label={turn.role === 'user' ? copy.you : turn.author}
            >
              {#if turn.role === 'assistant'}
                <HelpMarkdown markdown={turn.text} variant="chat" />
              {:else}
                <p>{turn.text}</p>
              {/if}
            </article>
          {/each}
          {#if busy}<ShimpzThinking label={thinking} />{/if}
        </div>

        {#if visibleError}
          <div class="error" role="alert">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
          </div>
        {/if}

          <form class="composer" onsubmit={send}>
            <ChatContextControls disabled={busy || stopping} />
            <div class="composer-input">
              <textarea
                bind:value={draft}
                maxlength="16000"
                rows="2"
                placeholder={placeholder}
                disabled={busy}
                onkeydown={handleComposerKeydown}
              ></textarea>
              <div class="composer-actions">
              {#if busy}<button class="stop" type="button" onclick={stop} disabled={stopping}>{copy.stop}</button>{/if}
              <button
                bind:this={helpButton}
                class="help"
                type="button"
                onclick={() => { helpOpen = !helpOpen; }}
                disabled={helpAssistants.length === 0}
                aria-label={copy.help}
                title={copy.help}
                aria-expanded={helpOpen}
                aria-controls="assistant-help-drawer"
              >?</button>
              <button class="send" type="submit" disabled={busy || !socketReady || !draft.trim()}>
                {busy ? thinking : socketReady ? copy.send : copy.connecting}
              </button>
              </div>
            </div>
          </form>
        </section>
        <AssistantHelpDrawer
          open={helpOpen}
          teamId={chatTeamId}
          assistants={helpAssistants}
          onclose={closeHelp}
        />
      </div>
    {:else}
      <section class="provider-setup" aria-live="polite">
        <ProviderSetupGate />
        <div class="context-dock"><ChatContextControls /></div>
      </section>
    {/if}
  {:else}
    <section class="empty-state" aria-live="polite">
      <div class="empty-copy">
        <div class="empty-mark" aria-hidden="true"><span></span></div>
        {#if visibleError}
          <div class="empty-error" role="alert">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
          </div>
        {:else}
          <p>{contextLoading ? copy.loading : copy.emptyTeams}</p>
        {/if}
      </div>
      <div class="context-dock"><ChatContextControls /></div>
    </section>
  {/if}
</div>

<style>
  .chat-route {
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .chat-workspace {
    position: relative;
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    overflow: hidden;
  }

  .chat-workspace.help-open {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .conversation {
    --chat-rail-gutter: 0.8rem;
    --chat-rail-width: 52rem;
    display: grid;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr) auto auto;
    border: 0;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    background: var(--surface-1);
    overflow: hidden;
  }

  .provider-setup {
    display: grid;
    height: 100%;
    min-width: 0;
    min-height: 0;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    grid-template-rows: minmax(0, 1fr) auto;
    overflow: auto;
  }

  .turns {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: 0.8rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-block: 1rem;
    padding-inline: max(
      var(--chat-rail-gutter),
      calc((100% - var(--chat-rail-width)) / 2)
    );
  }

  .empty-conversation .turns {
    display: none;
  }

  article {
    position: relative;
    max-width: min(80%, 46rem);
    padding: 0.3rem 1rem;
    background: transparent;
  }

  article::before {
    position: absolute;
    top: 0.85rem;
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 50%;
    content: '';
    box-shadow: 0 0 0.4rem currentColor;
  }

  article.user {
    align-self: flex-end;
    color: var(--accent);
  }

  article.user::before {
    inset-inline-end: 0;
    background: var(--accent);
  }

  article.assistant {
    align-self: flex-start;
    color: var(--accent-alt);
  }

  article.assistant::before {
    inset-inline-start: 0;
    background: var(--accent-alt);
  }

  article p {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .error,
  .empty-error {
    display: grid;
    gap: 0.35rem;
    border-left: 2px solid var(--danger);
    padding: 0.65rem 0.9rem;
    color: var(--danger);
    font-size: 0.72rem;
  }

  .error {
    grid-row: 2;
    width: min(
      calc(100% - (2 * var(--chat-rail-gutter))),
      var(--chat-rail-width)
    );
    max-height: min(8rem, 24dvh);
    margin: 0;
    justify-self: center;
    overflow-y: auto;
  }

  .error strong,
  .empty-error strong {
    font-weight: 600;
  }

  .error code,
  .empty-error code {
    color: var(--text-faint);
    font-size: 0.6rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .composer {
    display: grid;
    width: min(
      calc(100% - (2 * var(--chat-rail-gutter))),
      var(--chat-rail-width)
    );
    grid-template-columns: minmax(0, 1fr);
    grid-row: 3;
    align-items: end;
    justify-self: center;
    gap: 0.45rem;
    padding: 0.8rem 0;
    background: var(--surface-1);
  }

  .empty-conversation .composer {
    grid-row: 1;
    align-self: center;
  }

  textarea {
    width: 100%;
    height: 3.2rem;
    min-height: 0;
    resize: none;
    border: 1px solid var(--border-strong);
    padding: 0.7rem 0.75rem;
    background: #050708;
    color: var(--text);
    font-family: var(--font-mono);
    line-height: 1.45;
    overflow-y: auto;
  }

  .composer-input {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 0.65rem;
  }

  .composer-actions {
    display: flex;
    gap: 0.5rem;
  }

  .composer button {
    height: 3.2rem;
    min-height: 0;
  }

  button {
    min-height: 3rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.9rem;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
  }

  button.send {
    border: 0;
    background: var(--accent);
    color: #001013;
  }

  button.help {
    width: 3.2rem;
    padding: 0;
    font-size: 0.9rem;
  }

  button.stop {
    border-color: var(--danger);
    color: var(--danger);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .empty-state {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr) auto;
    border: 0;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    color: var(--text-faint);
    overflow: auto;
  }

  .empty-copy {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1rem;
    padding: 1rem;
    text-align: center;
  }

  .empty-mark {
    display: grid;
    width: 2.7rem;
    height: 2.7rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    transform: rotate(45deg);
  }

  .empty-mark span {
    width: 0.5rem;
    height: 0.5rem;
    background: var(--accent);
    box-shadow: 0 0 9px rgba(0, 240, 255, 0.55);
  }

  .empty-copy > p {
    max-width: 28rem;
    margin: 0;
  }

  .context-dock {
    width: min(calc(100% - 1.6rem), 52rem);
    justify-self: center;
    padding: 0.8rem 0;
  }

  @media (max-width: 640px) {
    article { max-width: 92%; }
    .conversation { --chat-rail-gutter: 0.6rem; }
    .composer { gap: 0.45rem; padding: 0.6rem 0; }
    .composer-input { gap: 0.45rem; }
    .composer-actions { gap: 0.3rem; }
    button { padding-inline: 0.65rem; }
  }
</style>
