<script>
  import { onMount } from 'svelte';
  import AdminShell from '$lib/AdminShell.svelte';
  import LocaleMenu from '$lib/LocaleMenu.svelte';
  import { locale, t } from '$lib/i18n.js';
  import { safeApiError } from '$lib/localApi.js';
  import {
    CHAT_WS_PROTOCOL,
    chatSocketUrl,
    createChatFrame,
    createStopFrame,
    listCapsuleFiles,
    parseChatTerminalEvent,
  } from '$lib/localChat.js';

  const CID_RE = /^[a-z0-9_]{1,40}$/;
  const CONTROL_RE = /[\u0000-\u001f\u007f]/;
  const COPY = {
    en: {
      kicker: 'Team // Chat', title: 'Your Team',
      lead: 'Talk naturally with your Team. Its Brain coordinates the installed Assistants and their permitted Powers.',
      team: 'Team', files: 'Files', noFiles: 'No files stored in this Team.',
      placeholder: 'Message {team}…', send: 'Send', sending: '{team} is thinking…', you: 'You',
      stop: 'Stop', stopped: 'The active turn was stopped.', emptyTeams: 'Create a running Team first.',
      openTeams: 'Open Teams',
      loadFailed: 'Local chat data is unavailable.', needAuth: 'Sign in to use local chat.', signIn: 'Open sign-in',
      connecting: 'Connecting…', disconnected: 'The secure chat connection was interrupted. Reconnecting…',
      protocolError: 'The secure chat response was invalid.',
    },
    pt: {
      kicker: 'Time // Chat', title: 'Seu Time',
      lead: 'Converse naturalmente com seu Time. O Brain coordena os Assistants instalados e seus Powers permitidos.',
      team: 'Time', files: 'Arquivos', noFiles: 'Nenhum arquivo armazenado neste Time.',
      placeholder: 'Envie uma mensagem para {team}…', send: 'Enviar', sending: '{team} está pensando…', you: 'Você',
      stop: 'Parar', stopped: 'O turno ativo foi interrompido.', emptyTeams: 'Crie primeiro um Time em execução.',
      openTeams: 'Abrir Times',
      loadFailed: 'Os dados do chat local estão indisponíveis.', needAuth: 'Entre para usar o chat local.', signIn: 'Abrir login',
      connecting: 'Conectando…', disconnected: 'A conexão segura do chat foi interrompida. Reconectando…',
      protocolError: 'A resposta segura do chat era inválida.',
    },
  };

  let phase = $state('checking');
  let capsules = $state([]);
  let capsuleId = $state('');
  let files = $state([]);
  let selectedFiles = $state([]);
  let draft = $state('');
  let turns = $state([]);
  let busy = $state(false);
  let stopping = $state(false);
  let error = $state('');
  let socket = $state(null);
  let socketReady = $state(false);
  let reconnectTimer;
  let reconnectAttempt = 0;

  let copy = $derived(COPY[$locale] ?? COPY.en);
  let runningCapsules = $derived(capsules.filter((entry) => entry.status === 'running'));
  let activeTeam = $derived(runningCapsules.find((entry) => entry.id === capsuleId) ?? null);
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived(copy.placeholder.replace('{team}', teamName));
  let thinking = $derived(copy.sending.replace('{team}', teamName));

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

  function scheduleReconnect(expectedCapsule) {
    if (reconnectTimer || phase !== 'ready' || capsuleId !== expectedCapsule) return;
    const delay = Math.min(400 * (2 ** reconnectAttempt), 5000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (phase === 'ready' && capsuleId === expectedCapsule) connectSocket(expectedCapsule);
    }, delay);
  }

  function connectSocket(expectedCapsule = capsuleId) {
    closeSocket();
    if (!expectedCapsule || phase !== 'ready' || capsuleId !== expectedCapsule) return;
    const active = new WebSocket(chatSocketUrl(location, expectedCapsule), CHAT_WS_PROTOCOL);
    socket = active;

    active.onopen = () => {
      if (socket !== active || capsuleId !== expectedCapsule) return;
      if (active.protocol !== CHAT_WS_PROTOCOL) {
        socket = null;
        active.close(1002, 'Protocol required');
        error = copy.protocolError;
        return;
      }
      reconnectAttempt = 0;
      socketReady = true;
      if (error === copy.disconnected) error = '';
    };
    active.onmessage = (event) => {
      if (socket !== active || capsuleId !== expectedCapsule) return;
      let terminal;
      try {
        if (typeof event.data !== 'string' || (!busy && !stopping)) throw new Error('unexpected frame');
        terminal = parseChatTerminalEvent(JSON.parse(event.data), teamName);
      } catch {
        socket = null;
        socketReady = false;
        busy = false;
        stopping = false;
        error = copy.protocolError;
        active.close(1002, 'Invalid terminal event');
        return;
      }

      busy = false;
      stopping = false;
      if (terminal.type === 'done') {
        capsules = capsules.map((entry) => entry.id === expectedCapsule ? { ...entry, name: terminal.team } : entry);
        turns = [...turns, { role: 'assistant', text: terminal.reply, author: terminal.team }];
        error = '';
      } else if (terminal.type === 'stopped') {
        error = copy.stopped;
      } else {
        error = terminal.detail;
      }
    };
    active.onclose = () => {
      if (socket !== active || capsuleId !== expectedCapsule) return;
      socket = null;
      socketReady = false;
      stopping = false;
      if (busy) busy = false;
      error = copy.disconnected;
      scheduleReconnect(expectedCapsule);
    };
  }

  function normalizeCapsules(document) {
    if (!Array.isArray(document?.capsules)) return [];
    return document.capsules.map((entry) => {
      if (
        !entry ||
        !CID_RE.test(entry.id) ||
        typeof entry.status !== 'string' ||
        typeof entry.name !== 'string' ||
        entry.name !== entry.name.trim() ||
        !entry.name ||
        entry.name.length > 80 ||
        CONTROL_RE.test(entry.name)
      ) throw new Error(copy.loadFailed);
      return { id: entry.id, name: entry.name, status: entry.status };
    });
  }

  async function loadTeamData() {
    files = [];
    selectedFiles = [];
    turns = [];
    error = '';
    if (!capsuleId) return;
    try {
      files = await listCapsuleFiles(fetch, capsuleId);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : copy.loadFailed;
    }
  }

  async function load() {
    phase = 'checking';
    error = '';
    try {
      const sessionResponse = await fetch('/api/session', { cache: 'no-store' });
      if (!sessionResponse.ok || !(await sessionResponse.json()).authenticated) {
        phase = 'needauth';
        return;
      }
      const response = await fetch('/api/capsules', {
        cache: 'no-store', headers: { Accept: 'application/json' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(safeApiError(body, copy.loadFailed));
      capsules = normalizeCapsules(body);
      const requested = new URL(location.href).searchParams.get('capsule') ?? '';
      capsuleId = runningCapsules.some((entry) => entry.id === requested)
        ? requested
        : (runningCapsules[0]?.id ?? '');
      phase = 'ready';
      await loadTeamData();
      connectSocket(capsuleId);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : copy.loadFailed;
      phase = 'ready';
    }
  }

  async function selectTeam(event) {
    closeSocket();
    capsuleId = event.currentTarget.value;
    const url = new URL(location.href);
    url.searchParams.set('capsule', capsuleId);
    history.replaceState(history.state, '', url);
    await loadTeamData();
    connectSocket(capsuleId);
  }

  function toggleFile(fileId) {
    selectedFiles = selectedFiles.includes(fileId)
      ? selectedFiles.filter((value) => value !== fileId)
      : selectedFiles.length < 8 ? [...selectedFiles, fileId] : selectedFiles;
  }

  function send(event) {
    event.preventDefault();
    if (busy || !capsuleId || !draft.trim() || !socketReady || !socket) return;
    const message = draft.trim();
    let frame;
    try {
      frame = createChatFrame(capsuleId, { message, files: selectedFiles });
    } catch (reason) {
      error = reason instanceof Error ? reason.message : copy.loadFailed;
      return;
    }
    busy = true;
    error = '';
    turns = [...turns, { role: 'user', text: message }];
    draft = '';
    try {
      socket.send(JSON.stringify(frame));
    } catch (reason) {
      busy = false;
      error = reason instanceof Error ? reason.message : copy.loadFailed;
      socket.close();
    }
  }

  function stop() {
    if (!busy || stopping || !capsuleId || !socketReady || !socket) return;
    stopping = true;
    error = '';
    try {
      socket.send(JSON.stringify(createStopFrame(capsuleId)));
    } catch (reason) {
      stopping = false;
      error = reason instanceof Error ? reason.message : copy.loadFailed;
      socket.close();
    }
  }

  async function logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } finally { location.assign('/'); }
  }

  onMount(() => {
    void load();
    return closeSocket;
  });
</script>

<svelte:head><title>{teamName} — Shimpz Admin</title></svelte:head>

<AdminShell active="chat" authenticated={phase === 'ready'} actions={shellActions}>
  {#if phase === 'checking'}
    <p class="center" aria-live="polite">Loading local chat…</p>
  {:else if phase === 'needauth'}
    <section class="gate"><h1>{copy.needAuth}</h1><a href="/">{copy.signIn} →</a></section>
  {:else}
    <section class="heading">
      <p>{copy.kicker}</p><h1>{teamName}</h1><span>{copy.lead}</span>
    </section>

    {#if runningCapsules.length}
      <div class="chat-shell">
        <aside>
          <label><span>{copy.team}</span><select value={capsuleId} onchange={selectTeam} disabled={busy}>
            {#each runningCapsules as team (team.id)}<option value={team.id}>{team.name}</option>{/each}
          </select></label>
          <section class="files"><h2>{copy.files} <small>{selectedFiles.length}/8</small></h2>
            {#if files.length}<ul>{#each files as file (file.id)}<li><label>
              <input type="checkbox" checked={selectedFiles.includes(file.id)} disabled={busy} onchange={() => toggleFile(file.id)} />
              <span>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span>
            </label></li>{/each}</ul>{:else}<p>{copy.noFiles}</p>{/if}
          </section>
        </aside>

        <section class="conversation" aria-live="polite">
          <div class="turns">
            {#if turns.length}{#each turns as turn}<article class={turn.role}>
              <small>{turn.role === 'user' ? copy.you : turn.author}</small>
              <p>{turn.text}</p>
            </article>{/each}{:else}<p class="conversation-empty">{placeholder}</p>{/if}
          </div>
          {#if error}<p class="error" role="alert">{error}</p>{/if}
          <form onsubmit={send}>
            <textarea bind:value={draft} maxlength="16000" rows="3" placeholder={placeholder} disabled={busy}></textarea>
            <div>
              {#if busy}<button class="stop" type="button" onclick={stop} disabled={stopping}>{copy.stop}</button>{/if}
              <button class="send" type="submit" disabled={busy || !socketReady || !draft.trim()}>
                {busy ? thinking : socketReady ? copy.send : copy.connecting}
              </button>
            </div>
          </form>
        </section>
      </div>
    {:else}
      <section class="gate"><h2>{copy.emptyTeams}</h2><a href="/capsules/">{copy.openTeams} →</a></section>
    {/if}
  {/if}
</AdminShell>

{#snippet shellActions()}
  <LocaleMenu compact={phase !== 'ready'} />
  {#if phase === 'ready'}<button class="logout" type="button" onclick={logout}>{$t('auth.logout')} ↪</button>{/if}
{/snippet}

<style>
  .heading { margin-bottom: 1.5rem; }
  .heading > p { margin: 0 0 0.7rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.65rem; letter-spacing: 0.16em; text-transform: uppercase; }
  h1 { max-width: 13ch; margin: 0; font-size: clamp(2.3rem, 6vw, 4.6rem); line-height: 0.98; letter-spacing: -0.07em; }
  .heading > span { display: block; max-width: 65ch; margin-top: 0.9rem; color: var(--text-dim); line-height: 1.6; }
  .chat-shell { display: grid; min-height: 34rem; grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr); border: 1px solid var(--border-strong); background: var(--surface-1); }
  aside { padding: 1rem; border-right: 1px solid var(--border); background: rgba(0, 0, 0, 0.2); }
  aside > label { display: grid; gap: 0.35rem; margin-bottom: 0.8rem; }
  label > span, .files h2 { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.56rem; letter-spacing: 0.09em; text-transform: uppercase; }
  select, textarea { width: 100%; border: 1px solid var(--border-strong); background: #050708; color: var(--text); font-family: var(--font-mono); }
  select { min-height: 2.5rem; padding: 0 0.65rem; }
  textarea { resize: vertical; padding: 0.75rem; line-height: 1.5; }
  .files { margin-top: 1.2rem; border-top: 1px solid var(--border); padding-top: 1rem; }
  .files h2 { display: flex; justify-content: space-between; margin: 0 0 0.7rem; }
  .files ul { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
  .files li label { display: flex; align-items: start; gap: 0.45rem; color: var(--text-dim); font-size: 0.7rem; }
  .files li span { display: grid; overflow-wrap: anywhere; }
  .files li small, .files > p { color: var(--text-faint); font-size: 0.58rem; }
  .conversation { display: grid; min-width: 0; grid-template-rows: 1fr auto auto; }
  .turns { display: flex; max-height: 32rem; flex-direction: column; gap: 0.8rem; overflow: auto; padding: 1.2rem; }
  article { max-width: min(80%, 46rem); padding: 0.8rem 1rem; background: #080b0d; box-shadow: inset 0 0 0 1px var(--border); }
  article.user { align-self: flex-end; border-right: 2px solid var(--accent); }
  article.assistant { align-self: flex-start; border-left: 2px solid var(--accent-alt); }
  article small { color: var(--accent); font-family: var(--font-mono); font-size: 0.55rem; text-transform: uppercase; }
  article p { margin: 0.35rem 0 0; white-space: pre-wrap; line-height: 1.55; }
  .conversation-empty { margin: auto; color: var(--text-faint); text-align: center; }
  .conversation form { padding: 0.9rem; border-top: 1px solid var(--border); }
  .conversation form > div { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.55rem; }
  button, .gate a { min-height: 2.4rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.6rem; font-weight: 700; text-decoration: none; text-transform: uppercase; }
  button.send { border: 0; background: var(--accent); color: #001013; }
  button.stop { border-color: var(--danger); color: var(--danger); }
  button:disabled { cursor: not-allowed; opacity: 0.4; }
  .error { margin: 0; border-left: 2px solid var(--danger); padding: 0.65rem 0.9rem; color: var(--danger); font-size: 0.72rem; }
  .files > p { color: var(--text-faint); font-size: 0.68rem; line-height: 1.5; }
  .gate a { display: inline-flex; align-items: center; }
  .gate, .center { display: grid; min-height: 25rem; place-items: center; gap: 1rem; text-align: center; }
  .logout { min-height: 2.75rem; }
  @media (max-width: 760px) { .chat-shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--border); } .turns { min-height: 20rem; } article { max-width: 92%; } }
</style>
