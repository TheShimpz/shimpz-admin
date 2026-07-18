<script>
  import { onMount } from 'svelte';
  import { locale } from '$lib/i18n.js';
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
      emptyTeams: 'Create a Team from the sidebar to start chatting.',
      loading: 'Loading your Team…', loadFailed: 'Local chat data is unavailable.',
      connecting: 'Connecting…', disconnected: 'The secure chat connection was interrupted. Reconnecting…',
      protocolError: 'The secure chat response was invalid.',
      turnFailed: 'The chat turn could not start.', capacityFailed: 'The local chat is busy. Try again shortly.',
      runtimeFailed: 'The local chat runtime is unavailable.', requestFailed: 'The Team could not complete this turn.',
      technicalDetail: 'Technical detail',
    },
    pt: {
      kicker: 'Time // Chat', title: 'Seu Time',
      placeholder: 'Envie uma mensagem para {team}…', send: 'Enviar', sending: '{team} está pensando…', you: 'Você',
      stop: 'Parar', stopped: 'O turno ativo foi interrompido.',
      emptyTeams: 'Crie um Time pela barra lateral para começar a conversar.',
      loading: 'Carregando seu Time…', loadFailed: 'Os dados do chat local estão indisponíveis.',
      connecting: 'Conectando…', disconnected: 'A conexão segura do chat foi interrompida. Reconectando…',
      protocolError: 'A resposta segura do chat era inválida.',
      turnFailed: 'Não foi possível iniciar o turno do chat.', capacityFailed: 'O chat local está ocupado. Tente novamente em instantes.',
      runtimeFailed: 'O runtime do chat local está indisponível.', requestFailed: 'O Time não conseguiu concluir este turno.',
      technicalDetail: 'Detalhe técnico',
    },
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

  let copy = $derived(COPY[$locale] ?? COPY.en);
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === selectedTeamId) ?? null,
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived(copy.placeholder.replace('{team}', teamName));
  let thinking = $derived(copy.sending.replace('{team}', teamName));
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
    if (reconnectTimer || !mounted || $teamContext.selectedTeamId !== expectedTeamId) return;
    const delay = Math.min(400 * (2 ** reconnectAttempt), 5000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (mounted && $teamContext.selectedTeamId === expectedTeamId) connectSocket(expectedTeamId);
    }, delay);
  }

  function connectSocket(expectedTeamId) {
    closeSocket();
    if (!mounted || !expectedTeamId || $teamContext.selectedTeamId !== expectedTeamId) return;

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
      if (socket !== active || $teamContext.selectedTeamId !== expectedTeamId) return;
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
      if (socket !== active || $teamContext.selectedTeamId !== expectedTeamId) return;
      let terminal;
      try {
        if (typeof event.data !== 'string' || (!busy && !stopping)) throw new Error('unexpected frame');
        terminal = parseChatTerminalEvent(JSON.parse(event.data), expectedTeam.name);
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
        turns = [...turns, { role: 'assistant', text: terminal.reply, author: terminal.team }];
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
      if (socket !== active || $teamContext.selectedTeamId !== expectedTeamId) return;
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
    clearError();
    if (nextTeamId) connectSocket(nextTeamId);
  }

  function send(event) {
    event.preventDefault();
    const teamId = $teamContext.selectedTeamId;
    if (busy || !teamId || !draft.trim() || !socketReady || !socket) return;
    const message = draft.trim();
    let frame;
    try {
      frame = createChatFrame(teamId, {
        message,
        files: $teamContext.selectedFileIds,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      return;
    }
    busy = true;
    clearError();
    turns = [...turns, { role: 'user', text: message }];
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
    const nextTeamId = $teamContext.selectedTeamId;
    if (!mounted || nextTeamId === socketTeamId) return;
    activateTeam(nextTeamId);
  });

  onMount(() => {
    mounted = true;
    const initialTeamId = $teamContext.selectedTeamId;
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
    <section class="conversation" aria-label={`${copy.kicker}: ${teamName}`}>
      <header class="team-header">
        <i aria-hidden="true"></i>
        <div>
          <p>{copy.kicker}</p>
          <h1>{teamName}</h1>
        </div>
      </header>

      <div class="turns" aria-live="polite">
        {#if turns.length}
          {#each turns as turn}
            <article class={turn.role}>
              <small>{turn.role === 'user' ? copy.you : turn.author}</small>
              <p>{turn.text}</p>
            </article>
          {/each}
        {:else}
          <p class="conversation-empty">{placeholder}</p>
        {/if}
      </div>

      {#if visibleError}
        <div class="error" role="alert">
          <strong>{visibleError}</strong>
          {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
        </div>
      {/if}

      <form class="composer" onsubmit={send}>
        <textarea
          bind:value={draft}
          maxlength="16000"
          rows="2"
          placeholder={placeholder}
          disabled={busy}
          onkeydown={handleComposerKeydown}
        ></textarea>
        <div>
          {#if busy}<button class="stop" type="button" onclick={stop} disabled={stopping}>{copy.stop}</button>{/if}
          <button class="send" type="submit" disabled={busy || !socketReady || !draft.trim()}>
            {busy ? thinking : socketReady ? copy.send : copy.connecting}
          </button>
        </div>
      </form>
    </section>
  {:else}
    <section class="empty-state" aria-live="polite">
      <div aria-hidden="true"><span></span></div>
      {#if visibleError}
        <div class="empty-error" role="alert">
          <strong>{visibleError}</strong>
          {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
        </div>
      {:else}
        <p>{contextLoading ? copy.loading : copy.emptyTeams}</p>
      {/if}
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

  .conversation {
    display: grid;
    height: 100%;
    min-width: 0;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto auto;
    border: 0;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    background: var(--surface-1);
    overflow: hidden;
  }

  .team-header {
    display: flex;
    min-height: 3.6rem;
    align-items: center;
    gap: 0.75rem;
    border-bottom: 1px solid var(--admin-divider);
    padding: 0.7rem 1rem;
    background: rgba(0, 0, 0, 0.2);
  }

  .team-header > i {
    width: 0.5rem;
    height: 0.5rem;
    flex: 0 0 auto;
    background: var(--success);
    border-radius: 50%;
    box-shadow: 0 0 8px rgba(5, 255, 161, 0.5);
  }

  .team-header p {
    margin: 0 0 0.16rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.52rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(1rem, 2vw, 1.3rem);
    line-height: 1.1;
    letter-spacing: -0.03em;
  }

  .turns {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: 0.8rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 1rem;
  }

  article {
    max-width: min(80%, 46rem);
    padding: 0.8rem 1rem;
    background: #080b0d;
    box-shadow: inset 0 0 0 1px var(--border);
  }

  article.user {
    align-self: flex-end;
    border-right: 2px solid var(--accent);
  }

  article.assistant {
    align-self: flex-start;
    border-left: 2px solid var(--accent-alt);
  }

  article small {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.55rem;
    text-transform: uppercase;
  }

  article p {
    margin: 0.35rem 0 0;
    white-space: pre-wrap;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .conversation-empty {
    margin: auto;
    color: var(--text-faint);
    text-align: center;
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
    max-height: min(8rem, 24dvh);
    margin: 0 0.9rem;
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
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 0.65rem;
    padding: 0.8rem;
    background: var(--surface-1);
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

  .composer > div {
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
    place-content: center;
    justify-items: center;
    gap: 1rem;
    border: 0;
    border-inline-end: 1px solid var(--admin-divider);
    border-bottom: 1px solid var(--admin-divider);
    color: var(--text-faint);
    text-align: center;
    overflow: auto;
  }

  .empty-state > div:first-child {
    display: grid;
    width: 2.7rem;
    height: 2.7rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    transform: rotate(45deg);
  }

  .empty-state > div:first-child span {
    width: 0.5rem;
    height: 0.5rem;
    background: var(--accent);
    box-shadow: 0 0 9px rgba(0, 240, 255, 0.55);
  }

  .empty-state > p {
    max-width: 28rem;
    margin: 0;
  }

  @media (max-width: 640px) {
    article { max-width: 92%; }
    .composer { gap: 0.45rem; padding: 0.6rem; }
    .composer > div { gap: 0.3rem; }
    button { padding-inline: 0.65rem; }
  }
</style>
