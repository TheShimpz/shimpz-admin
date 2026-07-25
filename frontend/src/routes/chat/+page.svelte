<script>
  import { onMount, tick } from 'svelte';
  import AssistantAccountsDialog from '$lib/AssistantAccountsDialog.svelte';
  import AssistantAccountsDrawer from '$lib/AssistantAccountsDrawer.svelte';
  import AssistantHelpDrawer from '$lib/AssistantHelpDrawer.svelte';
  import ChatContextControls from '$lib/ChatContextControls.svelte';
  import HelpMarkdown from '$lib/HelpMarkdown.svelte';
  import { t } from '$lib/i18n.js';
  import { modelContext } from '$lib/modelContext.js';
  import ProviderSetupGate from '$lib/ProviderSetupGate.svelte';
  import ShimpzBrand from '$lib/ShimpzBrand.svelte';
  import ShimpzThinking from '$lib/ShimpzThinking.svelte';
  import { teamContext } from '$lib/teamContext.js';
  import {
    CHAT_WS_PROTOCOL,
    authorizeAssistantAccount,
    chatSocketUrl,
    createChatFrame,
    createStopFrame,
    createSyncFrame,
    disconnectAssistantAccount,
    listAssistantAccounts,
    parseChatEvent,
    oauthReturnFailure,
    restoreOAuthChatTurns,
    stashOAuthChatTurns,
  } from '$lib/localChat.js';


  let mounted = $state(false);
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
  let accountsOpen = $state(false);
  let accountsButton = $state();
  let accountsDialogOpen = $state(false);
  let accountChallenge = $state();
  let accounts = $state([]);
  let accountsReady = $state(false);
  let accountWorking = $state('');
  let oauthFailedOnReturn = false;
  let composerInput = $state();
  let turnsViewport = $state();
  let scrollRequest = 0;

  let copy = $derived($t('chatPage'));
  let accountsCopy = $derived($t('assistantAccounts'));
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === selectedTeamId) ?? null,
  );
  let chatTeamId = $derived(
    $modelContext.ready && $modelContext.teamId === selectedTeamId ? selectedTeamId : '',
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived($t('chatPage.placeholder', { team: teamName }));
  let thinking = $derived($t('chatPage.sending', { team: teamName }));
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

  async function focusComposer() {
    await tick();
    if (
      !mounted ||
      !chatTeamId ||
      busy ||
      helpOpen ||
      accountsOpen ||
      document.querySelector('dialog[open]')
    ) return;
    composerInput?.focus({ preventScroll: true });
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

  function resetChallengeState({ includeInventory = false } = {}) {
    accountChallenge = undefined;
    accountsDialogOpen = false;
    accountsReady = false;
    accountWorking = '';
    if (includeInventory) {
      accounts = [];
    }
  }

  function closeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    const current = socket;
    socket = null;
    socketReady = false;
    resetChallengeState();
    current?.close(1000, 'Team changed');
  }

  function acceptAccountChallenge(incoming) {
    const selected = new Set($teamContext.selectedAssistantIds);
    if (incoming.requirements.some((requirement) => !selected.has(requirement.assistant_id))) {
      throw new Error('unexpected Assistant account requirement');
    }
    accountChallenge = incoming;
    accountsDialogOpen = true;
    oauthFailedOnReturn = false;
    helpOpen = false;
    accountsOpen = false;
    busy = true;
    stopping = false;
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
      try {
        active.send(JSON.stringify(createSyncFrame(expectedTeamId)));
      } catch {
        socket = null;
        socketReady = false;
        setError(copy.disconnected);
        active.close();
        return;
      }
      if (error === copy.disconnected) clearError();
    };
    active.onmessage = (event) => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      let incoming;
      try {
        if (typeof event.data !== 'string') throw new Error('unexpected frame');
        incoming = parseChatEvent(
          JSON.parse(event.data),
          expectedTeam.id,
          expectedTeam.name,
        );
        if (incoming.type === 'accounts-required') {
          acceptAccountChallenge(incoming);
          return;
        }
        if (!busy && !stopping) throw new Error('unexpected terminal frame');
      } catch {
        socket = null;
        socketReady = false;
        busy = false;
        stopping = false;
        resetChallengeState();
        setError(copy.protocolError);
        active.close(1002, 'Invalid chat event');
        return;
      }

      busy = false;
      stopping = false;
      resetChallengeState();
      if (incoming.type === 'done') {
        turns = [...turns, { role: 'assistant', text: incoming.reply, author: incoming.team_name }];
        void revealLatestTurn();
        clearError();
      } else if (incoming.type === 'stopped') {
        setError(copy.stopped);
      } else {
        setError(
          friendlyChatError(incoming.status),
          `HTTP ${incoming.status} · ${incoming.detail}`,
        );
      }
    };
    active.onclose = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      socket = null;
      socketReady = false;
      stopping = false;
      if (busy) busy = false;
      resetChallengeState();
      setError(copy.disconnected);
      scheduleReconnect(expectedTeamId);
    };
  }

  function activateTeam(nextTeamId) {
    closeSocket();
    socketTeamId = nextTeamId;
    reconnectAttempt = 0;
    stopping = false;
    draft = '';
    turns = nextTeamId ? restoreOAuthChatTurns(sessionStorage, nextTeamId) : [];
    busy = turns.length > 0;
    scrollRequest += 1;
    helpOpen = false;
    accountsOpen = false;
    resetChallengeState({ includeInventory: true });
    clearError();
    if (nextTeamId) connectSocket(nextTeamId);
  }

  function closeHelp() {
    helpOpen = false;
    queueMicrotask(() => helpButton?.focus());
  }

  function closeAccounts() {
    accountsOpen = false;
    queueMicrotask(() => accountsButton?.focus());
  }

  function closeAccountsDialog() {
    accountsDialogOpen = false;
  }

  async function refreshAccounts(teamId) {
    accountsReady = false;
    try {
      const inventory = await listAssistantAccounts(fetch, teamId);
      if (chatTeamId !== teamId) return;
      const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
      if (inventory.accounts.some((account) => !installed.has(account.assistant_id))) {
        throw new Error(accountsCopy.inventoryFailed);
      }
      accounts = inventory.accounts;
      accountsReady = true;
    } catch (reason) {
      if (chatTeamId !== teamId) return;
      accounts = [];
      setError(
        accountsCopy.inventoryFailed,
        reason instanceof Error ? reason.message : accountsCopy.inventoryFailed,
      );
    }
  }

  function toggleAccounts() {
    const next = !accountsOpen;
    helpOpen = false;
    accountsOpen = next;
    if (next && chatTeamId) void refreshAccounts(chatTeamId);
  }

  async function authorizeAccount(challengeId) {
    const teamId = chatTeamId;
    if (
      !teamId ||
      accountWorking ||
      !accountChallenge ||
      accountChallenge.challenge_id !== challengeId
    ) throw new Error(accountsCopy.authorizationFailed);
    accountWorking = 'connect';
    try {
      const authorization = await authorizeAssistantAccount(fetch, teamId, challengeId);
      if (chatTeamId !== teamId || accountChallenge?.challenge_id !== challengeId) {
        throw new Error(accountsCopy.authorizationFailed);
      }
      stashOAuthChatTurns(sessionStorage, teamId, turns);
      location.assign(authorization.authorization_url);
    } catch (reason) {
      if (chatTeamId === teamId) {
        setError(
          accountsCopy.authorizationFailed,
          reason instanceof Error ? reason.message : accountsCopy.authorizationFailed,
        );
      }
      accountWorking = '';
      throw reason;
    }
  }

  async function disconnectAccount(account) {
    const teamId = chatTeamId;
    if (!teamId || accountWorking) return;
    const identity = `${account.assistant_id}\u0000${account.id}`;
    accountWorking = identity;
    try {
      await disconnectAssistantAccount(fetch, teamId, account.assistant_id, account.id);
      if (chatTeamId !== teamId) return;
      await refreshAccounts(teamId);
    } catch (reason) {
      if (chatTeamId === teamId) {
        setError(
          accountsCopy.disconnectFailed,
          reason instanceof Error ? reason.message : accountsCopy.disconnectFailed,
        );
      }
    } finally {
      if (chatTeamId === teamId) accountWorking = '';
    }
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

  $effect(() => {
    if (mounted && chatTeamId && !busy && !helpOpen && !accountsOpen) void focusComposer();
  });

  onMount(() => {
    mounted = true;
    oauthFailedOnReturn = oauthReturnFailure(location.href);
    const initialTeamId = chatTeamId;
    if (initialTeamId !== socketTeamId) activateTeam(initialTeamId);
    if (oauthFailedOnReturn) {
      busy = false;
      history.replaceState(history.state, '', '/chat');
      setError(accountsCopy.authorizationFailed);
    }
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
      <div class="chat-workspace" class:drawer-open={helpOpen || accountsOpen}>
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
            {#if turns.length === 0}
              <div class="empty-chat-brand">
                <ShimpzBrand variant="symbol" product="" href="/chat/" ariaLabel="Shimpz" />
              </div>
            {/if}
            <ChatContextControls disabled={busy || stopping} />
            <div class="composer-input">
              <textarea
                bind:this={composerInput}
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
                bind:this={accountsButton}
                class="accounts"
                type="button"
                onclick={toggleAccounts}
                disabled={$teamContext.installedAssistants.length === 0 && !accountChallenge}
                aria-label={accountsCopy.trigger}
                title={accountsCopy.trigger}
                aria-expanded={accountsOpen}
                aria-controls="assistant-accounts-drawer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.2 14.8 14.8 9.2M7.1 17H5.5a3.5 3.5 0 0 1 0-7h3M16.9 7h1.6a3.5 3.5 0 1 1 0 7h-3"></path>
                </svg>
              </button>
              <button
                bind:this={helpButton}
                class="help"
                type="button"
                onclick={() => {
                  const next = !helpOpen;
                  accountsOpen = false;
                  helpOpen = next;
                }}
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
        <AssistantAccountsDrawer
          open={accountsOpen}
          {accounts}
          synced={accountsReady}
          pending={accountChallenge}
          working={accountWorking}
          onclose={closeAccounts}
          onconnect={authorizeAccount}
          ondisconnect={disconnectAccount}
        />
        <AssistantAccountsDialog
          open={accountsDialogOpen}
          challenge={accountChallenge}
          onclose={closeAccountsDialog}
          onauthorize={authorizeAccount}
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

  .chat-workspace.drawer-open {
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
    min-width: 0;
    box-sizing: border-box;
    padding: 0.3rem 0;
    background: transparent;
  }

  article.user {
    align-self: flex-end;
    width: fit-content;
    max-width: min(80%, 46rem);
    color: var(--accent);
  }

  article.assistant {
    align-self: stretch;
    width: 100%;
    max-width: none;
    color: var(--accent-alt);
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

  .empty-chat-brand {
    display: grid;
    justify-self: center;
    margin-block-end: clamp(0.75rem, 2dvh, 1.5rem);
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

  button.help,
  button.accounts {
    width: 3.2rem;
    padding: 0;
    font-size: 0.9rem;
  }

  button.accounts {
    position: relative;
    display: grid;
    place-items: center;
  }

  button.accounts svg {
    width: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: square;
    stroke-width: 1.6;
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
    article.user { max-width: 92%; }
    .conversation { --chat-rail-gutter: 0.6rem; }
    .composer { gap: 0.45rem; padding: 0.6rem 0; }
    .composer-input { gap: 0.45rem; }
    .composer-actions { gap: 0.3rem; }
    button { padding-inline: 0.65rem; }
  }
</style>
