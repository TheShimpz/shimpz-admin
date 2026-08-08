<script>
  import { onMount, tick } from 'svelte';
  import { Button, EmptyState, Message, Notice, ScrollArea, TextAreaField, Toolbar } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import AssistantIntegrationsDialog from '$lib/AssistantIntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '$lib/AssistantIntegrationsDrawer.svelte';
  import ChatContextControls from '$lib/ChatContextControls.svelte';
  import ExecutionReceipt from '$lib/ExecutionReceipt.svelte';
  import { localizedEventLabel } from '$lib/executionProgress.js';
  import Markdown from '$lib/Markdown.svelte';
  import { t } from '$lib/i18n.js';
  import { modelContext } from '$lib/modelContext.js';
  import ProviderSetupGate from '$lib/ProviderSetupGate.svelte';
  import ShimpzThinking from '$lib/ShimpzThinking.svelte';
  import { teamContext } from '$lib/teamContext.js';
  import {
    CHAT_WS_PROTOCOL,
    authorizeAssistantIntegration,
    cancelAssistantIntegrationAuthorization,
    chatSocketUrl,
    completeAssistantIntegration,
    createChatFrame,
    createHumanResponseFrame,
    createStopFrame,
    createSyncFrame,
    disconnectAssistantIntegration,
    listAssistantIntegrations,
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
  let syncing = $state(false);
  let progressEvents = $state([]);
  let progressSequence = $state(0);
  let stopping = $state(false);
  let error = $state('');
  let errorDetail = $state('');
  let socket = $state(null);
  let socketReady = $state(false);
  let reconnectTimer;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  let integrationsOpen = $state(false);
  let integrationsButton = $state();
  let integrationsDialogOpen = $state(false);
  let integrationChallenge = $state();
  let humanChallenge = $state();
  let humanWorking = $state(false);
  let integrations = $state([]);
  let integrationsReady = $state(false);
  let integrationWorking = $state('');
  let oauthFailedOnReturn = false;
  let composerInput = $state();
  let stopButton = $state();
  let turnsViewport = $state();
  let scrollRequest = 0;

  let copy = $derived($t('chatPage'));
  let integrationsCopy = $derived($t('assistantIntegrations'));
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === selectedTeamId) ?? null,
  );
  let chatTeamId = $derived(
    $modelContext.ready && $modelContext.teamId === selectedTeamId ? selectedTeamId : '',
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived($t('chatPage.placeholder', { team: teamName }));
  let thinking = $derived(copy.sending);
  let exchanges = $derived(groupExchanges(turns));
  let currentProgress = $derived(progressEvents.at(-1));
  let assistantNames = $derived(new Map($teamContext.catalog.map((assistant) => [assistant.id, assistant.name])));
  let liveStatus = $derived(
    currentProgress
      ? `${thinking} ${localizedEventLabel(currentProgress, copy.progress, { teamName, assistantNames })}`
      : busy ? thinking : '',
  );
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

  function groupExchanges(values) {
    const grouped = [];
    for (const turn of values) {
      if (turn.role === 'user') {
        grouped.push({ user: turn, assistant: null });
      } else if (grouped.length > 0 && grouped.at(-1).assistant === null) {
        grouped.at(-1).assistant = turn;
      } else {
        grouped.push({ user: null, assistant: turn });
      }
    }
    return grouped;
  }

  function resetProgress() {
    progressEvents = [];
    progressSequence = 0;
  }

  function oauthTurns() {
    return turns.map(({ receipt: _receipt, ...turn }) => turn);
  }

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
      syncing ||
      integrationsOpen ||
      document.querySelector('dialog[open]')
    ) return;
    composerInput?.focus({ preventScroll: true });
  }

  async function focusStop() {
    await tick();
    if (mounted && busy && !syncing && !integrationChallenge && !humanChallenge) {
      stopButton?.focus({ preventScroll: true });
    }
  }

  async function revealLatestExchange() {
    const request = ++scrollRequest;
    await tick();
    if (request !== scrollRequest || !turnsViewport) return;
    const latest = turnsViewport.querySelector('.exchange:last-of-type');
    if (!latest) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    latest.scrollIntoView({
      block: 'start',
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
    integrationChallenge = undefined;
    humanChallenge = undefined;
    humanWorking = false;
    integrationsDialogOpen = false;
    integrationsReady = false;
    integrationWorking = '';
    if (includeInventory) {
      integrations = [];
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
    syncing = false;
    resetProgress();
    resetChallengeState();
    current?.close(1000, 'Team changed');
  }

  function acceptIntegrationChallenge(incoming) {
    const selected = new Set($teamContext.selectedAssistantIds);
    if (incoming.requirements.some((requirement) => !selected.has(requirement.assistant_id))) {
      throw new Error('unexpected Assistant integration requirement');
    }
    integrationChallenge = incoming;
    integrationsDialogOpen = true;
    oauthFailedOnReturn = false;
    integrationsOpen = false;
    busy = true;
    syncing = false;
    stopping = false;
    resetProgress();
  }

  function acceptHumanChallenge(incoming) {
    const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
    if (!installed.has(incoming.assistant.id)) {
      throw new Error('unexpected Assistant human request');
    }
    humanChallenge = incoming;
    humanWorking = false;
    integrationsOpen = false;
    busy = true;
    syncing = false;
    stopping = false;
    resetProgress();
  }

  function scheduleReconnect(expectedTeamId) {
    if (reconnectTimer || !mounted || chatTeamId !== expectedTeamId) return;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      setError(copy.connectionFailed);
      return;
    }
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
      syncing = true;
      resetProgress();
      try {
        active.send(JSON.stringify(createSyncFrame(expectedTeamId)));
      } catch {
        socket = null;
        socketReady = false;
        syncing = false;
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
        if (incoming.type === 'integrations-required') {
          acceptIntegrationChallenge(incoming);
          return;
        }
        if (incoming.type === 'human-required') {
          acceptHumanChallenge(incoming);
          return;
        }
        if (incoming.type === 'progress') {
          if (!busy && !syncing) throw new Error('unexpected progress frame');
          if (incoming.seq !== progressSequence + 1) throw new Error('out-of-order progress frame');
          progressSequence = incoming.seq;
          progressEvents = [...progressEvents, incoming];
          return;
        }
        if (incoming.type === 'sync-empty') {
          syncing = false;
          resetProgress();
          if (busy && turns.length > 0) {
            busy = false;
            stopping = false;
            resetChallengeState();
            setError(copy.turnFailed);
          }
          return;
        }
        if (!busy && !stopping && !syncing) throw new Error('unexpected terminal frame');
      } catch {
        socket = null;
        socketReady = false;
        busy = false;
        syncing = false;
        stopping = false;
        resetProgress();
        resetChallengeState();
        setError(copy.protocolError);
        active.close(1002, 'Invalid chat event');
        return;
      }

      const receipt = progressEvents.map((item) => ({ ...item }));
      busy = false;
      syncing = false;
      stopping = false;
      resetChallengeState();
      if (incoming.type === 'done') {
        turns = [...turns, {
          role: 'assistant',
          text: incoming.reply,
          author: incoming.team_name,
          receipt,
        }];
        clearError();
      } else if (incoming.type === 'stopped') {
        setError(copy.stopped);
      } else {
        setError(
          friendlyChatError(incoming.status),
          `HTTP ${incoming.status} · ${incoming.detail}`,
        );
      }
      resetProgress();
    };
    active.onclose = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      socket = null;
      socketReady = false;
      syncing = false;
      stopping = false;
      resetProgress();
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
    resetProgress();
    scrollRequest += 1;
    integrationsOpen = false;
    resetChallengeState({ includeInventory: true });
    clearError();
    if (nextTeamId) connectSocket(nextTeamId);
  }

  function closeIntegrations() {
    integrationsOpen = false;
    queueMicrotask(() => integrationsButton?.focus());
  }

  function closeIntegrationsDialog() {
    integrationsDialogOpen = false;
  }

  async function refreshIntegrations(teamId) {
    integrationsReady = false;
    try {
      const inventory = await listAssistantIntegrations(fetch, teamId);
      if (chatTeamId !== teamId) return;
      const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
      if (inventory.integrations.some((integration) => !installed.has(integration.assistant_id))) {
        throw new Error(integrationsCopy.inventoryFailed);
      }
      integrations = inventory.integrations;
      integrationsReady = true;
    } catch (reason) {
      if (chatTeamId !== teamId) return;
      integrations = [];
      setError(
        integrationsCopy.inventoryFailed,
        reason instanceof Error ? reason.message : integrationsCopy.inventoryFailed,
      );
    }
  }

  function toggleIntegrations() {
    const next = !integrationsOpen;
    integrationsOpen = next;
    if (next && chatTeamId) void refreshIntegrations(chatTeamId);
  }

  async function authorizeIntegration(challengeId) {
    const teamId = chatTeamId;
    if (
      !teamId ||
      integrationWorking ||
      !integrationChallenge ||
      integrationChallenge.challenge_id !== challengeId
    ) throw new Error(integrationsCopy.authorizationFailed);
    // Open synchronously while this click still owns transient browser activation.
    const authorizationWindow = window.open('about:blank', '_blank');
    if (authorizationWindow) authorizationWindow.opener = null;
    integrationWorking = 'connect';
    let authorizationStarted = false;
    try {
      const authorization = await authorizeAssistantIntegration(fetch, teamId, challengeId);
      authorizationStarted = true;
      if (chatTeamId !== teamId || integrationChallenge?.challenge_id !== challengeId) {
        throw new Error(integrationsCopy.authorizationFailed);
      }
      stashOAuthChatTurns(sessionStorage, teamId, oauthTurns());
      if (authorization.completion_mode === 'code') {
        if (!authorizationWindow || authorizationWindow.closed) {
          throw new Error(integrationsCopy.authorizationFailed);
        }
        authorizationWindow.location.replace(authorization.authorization_url);
        integrationWorking = '';
        return authorization;
      }
      authorizationWindow?.close();
      location.assign(authorization.authorization_url);
      return authorization;
    } catch (reason) {
      authorizationWindow?.close();
      if (authorizationStarted) {
        try {
          await cancelAssistantIntegrationAuthorization(fetch, teamId, challengeId);
        } catch {
          // Bounded server-side expiry remains the fail-closed fallback.
        }
      }
      if (chatTeamId === teamId) {
        setError(
          integrationsCopy.authorizationFailed,
          reason instanceof Error ? reason.message : integrationsCopy.authorizationFailed,
        );
      }
      integrationWorking = '';
      throw reason;
    }
  }

  async function completeIntegration(challengeId, completionCode) {
    const teamId = chatTeamId;
    if (
      !teamId ||
      integrationWorking ||
      integrationChallenge?.challenge_id !== challengeId
    ) throw new Error(integrationsCopy.completionFailed);
    integrationWorking = 'complete';
    try {
      await completeAssistantIntegration(fetch, teamId, challengeId, completionCode);
      if (chatTeamId !== teamId || integrationChallenge?.challenge_id !== challengeId) {
        throw new Error(integrationsCopy.completionFailed);
      }
      stashOAuthChatTurns(sessionStorage, teamId, oauthTurns());
      location.assign('/chat');
    } catch (reason) {
      if (chatTeamId === teamId) {
        integrationWorking = '';
        setError(
          integrationsCopy.completionFailed,
          reason instanceof Error ? reason.message : integrationsCopy.completionFailed,
        );
      }
      throw reason;
    }
  }

  async function cancelIntegrationAuthorization(challengeId) {
    const teamId = chatTeamId;
    if (!teamId || integrationChallenge?.challenge_id !== challengeId) return;
    try {
      await cancelAssistantIntegrationAuthorization(fetch, teamId, challengeId);
    } catch {
      // Expiry remains bounded and a new authorization uses a fresh binding.
    } finally {
      if (chatTeamId === teamId) integrationWorking = '';
    }
  }

  async function disconnectIntegration(integration) {
    const teamId = chatTeamId;
    if (!teamId || integrationWorking) return;
    const identity = `${integration.assistant_id}\u0000${integration.id}`;
    integrationWorking = identity;
    try {
      await disconnectAssistantIntegration(fetch, teamId, integration.assistant_id, integration.id);
      if (chatTeamId !== teamId) return;
      await refreshIntegrations(teamId);
    } catch (reason) {
      if (chatTeamId === teamId) {
        setError(
          integrationsCopy.disconnectFailed,
          reason instanceof Error ? reason.message : integrationsCopy.disconnectFailed,
        );
      }
    } finally {
      if (chatTeamId === teamId) integrationWorking = '';
    }
  }

  function send(event) {
    event.preventDefault();
    const teamId = $teamContext.selectedTeamId;
    if (
      busy ||
      syncing ||
      !teamId ||
      chatTeamId !== teamId ||
      !draft.trim() ||
      !socketReady ||
      !socket
    ) return;
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
    resetProgress();
    clearError();
    turns = [...turns, { role: 'user', text: message }];
    void revealLatestExchange();
    draft = '';
    try {
      socket.send(JSON.stringify(frame));
      void focusStop();
    } catch (reason) {
      busy = false;
      resetProgress();
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
    if (!busy || syncing || stopping || !teamId || !socketReady || !socket) return;
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

  function respondToHuman(response) {
    const teamId = chatTeamId;
    const challenge = humanChallenge;
    if (!teamId || !challenge || humanWorking || !socketReady || !socket) return;
    let frame;
    try {
      frame = createHumanResponseFrame(
        teamId,
        challenge.challenge_id,
        response.decision,
        response.value,
      );
      socket.send(JSON.stringify(frame));
      humanWorking = true;
      clearError();
    } catch (reason) {
      humanWorking = false;
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
    if (mounted && chatTeamId && !busy && !syncing && !integrationsOpen) void focusComposer();
  });

  onMount(() => {
    mounted = true;
    oauthFailedOnReturn = oauthReturnFailure(location.href);
    const initialTeamId = chatTeamId;
    if (initialTeamId !== socketTeamId) activateTeam(initialTeamId);
    if (oauthFailedOnReturn) {
      busy = false;
      resetProgress();
      history.replaceState(history.state, '', '/chat');
      setError(integrationsCopy.authorizationFailed);
    }
    return () => {
      mounted = false;
      closeSocket();
    };
  });
</script>

<svelte:head><title>{teamName} — Shimpz Admin</title></svelte:head>

<div class="chat-route">
  <h1 class="sr-only">{copy.title}</h1>
  {#if activeTeam}
    {#if chatTeamId}
      <div class="chat-workspace">
        <section
          class="conversation"
          class:empty-conversation={turns.length === 0}
          aria-label={teamName}
          aria-busy={(busy || syncing) && !integrationChallenge && !humanChallenge}
        >
        <p class="live-status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
        <ScrollArea class="turns" bind:element={turnsViewport}>
          {#each exchanges as exchange, index}
            <section class="exchange" class:active={index === exchanges.length - 1 && busy}>
              {#if exchange.user}
                <Message variant="user" author={copy.you}>
                  <p>{exchange.user.text}</p>
                </Message>
              {/if}
              {#if exchange.assistant}
                <Message variant="assistant" author={exchange.assistant.author}>
                  <Markdown markdown={exchange.assistant.text} variant="chat" />
                  <ExecutionReceipt
                    events={exchange.assistant.receipt ?? []}
                    label={copy.progressStagesExecuted}
                    progressLabels={copy.progress}
                    teamName={exchange.assistant.author}
                    {assistantNames}
                  />
                </Message>
              {:else if index === exchanges.length - 1 && busy && !integrationChallenge && !humanChallenge}
                <ShimpzThinking
                  label={thinking}
                  events={progressEvents}
                  elapsedText={copy.elapsed}
                  stagesText={copy.progressStages}
                  progressLabels={copy.progress}
                  {teamName}
                  {assistantNames}
                />
              {/if}
            </section>
          {/each}
        </ScrollArea>

        {#if visibleError}
          <Notice class="error" variant="error">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
          </Notice>
        {/if}

          <form class="composer" onsubmit={send}>
            <ChatContextControls disabled={busy || syncing || stopping} />
            <div class="composer-input">
              <TextAreaField
                id="chat-composer"
                label={copy.send}
                visuallyHiddenLabel
                class="composer-field"
                bind:element={composerInput}
                bind:value={draft}
                maxlength="16000"
                rows="2"
                placeholder={placeholder}
                disabled={busy || syncing}
                onkeydown={handleComposerKeydown}
              />
              <Toolbar class="composer-actions">
              {#if busy && !syncing}
                <Button bind:element={stopButton} variant="danger" size="compact" type="button" onclick={stop} disabled={stopping}>
                  {copy.stop}
                </Button>
              {/if}
              <Button
                bind:element={integrationsButton}
                variant="ghost"
                size="icon"
                type="button"
                onclick={toggleIntegrations}
                disabled={$teamContext.installedAssistants.length === 0 && !integrationChallenge}
                aria-label={integrationsCopy.trigger}
                title={integrationsCopy.trigger}
                aria-expanded={integrationsOpen}
                aria-controls="assistant-integrations-drawer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.2 14.8 14.8 9.2M7.1 17H5.5a3.5 3.5 0 0 1 0-7h3M16.9 7h1.6a3.5 3.5 0 1 1 0 7h-3"></path>
                </svg>
              </Button>
              <Button
                type="submit"
                disabled={busy || syncing || !socketReady || !draft.trim()}
              >
                {socketReady ? copy.send : copy.connecting}
              </Button>
              </Toolbar>
            </div>
          </form>
        </section>
        <AssistantIntegrationsDrawer
          open={integrationsOpen}
          {integrations}
          synced={integrationsReady}
          pending={integrationChallenge}
          working={integrationWorking}
          onclose={closeIntegrations}
          onconnect={authorizeIntegration}
          ondisconnect={disconnectIntegration}
        />
        <AssistantIntegrationsDialog
          open={integrationsDialogOpen}
          challenge={integrationChallenge}
          onclose={closeIntegrationsDialog}
          onauthorize={authorizeIntegration}
          oncomplete={completeIntegration}
          oncancel={cancelIntegrationAuthorization}
        />
        <AssistantHumanRequestDialog
          open={Boolean(humanChallenge)}
          challenge={humanChallenge}
          working={humanWorking}
          onrespond={respondToHuman}
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
      <EmptyState
        title={contextLoading ? copy.loading : copy.emptyTeams}
      >
        {#if visibleError}
          <Notice class="empty-error" variant="error">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
          </Notice>
        {/if}
      </EmptyState>
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

  .conversation {
    --chat-rail-gutter: 0.8rem;
    --chat-rail-width: 48rem;
    position: relative;
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

  :global(.turns) {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    gap: 1.1rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-block: 1rem;
    padding-inline: max(
      var(--chat-rail-gutter),
      calc((100% - var(--chat-rail-width)) / 2)
    );
  }

  .empty-conversation :global(.turns) {
    display: none;
  }

  .live-status {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    overflow: hidden;
    white-space: nowrap;
  }

  .exchange {
    display: grid;
    min-width: 0;
    align-content: start;
    gap: 0.65rem;
  }

  .exchange:last-child {
    min-block-size: 100%;
  }

  :global(.turns .shimpz-message--assistant) { align-self: stretch; color: var(--accent-alt); }
  :global(.turns .shimpz-message--user) { max-width: min(80%, 46rem); color: var(--accent); }
  :global(.turns [data-slot="message-content"] p) {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  :global(.error),
  :global(.empty-error) {
    display: grid;
    gap: 0.35rem;
    font-size: 0.72rem;
  }

  :global(.error) {
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

  :global(.error strong),
  :global(.empty-error strong) {
    font-weight: 600;
  }

  :global(.error code),
  :global(.empty-error code) {
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
    padding: 0.6rem 0;
    background: var(--surface-1);
  }

  .empty-conversation .composer {
    grid-row: 1;
    align-self: center;
  }

  :global(.composer-field textarea) {
    width: 100%;
    height: 2.75rem;
    min-height: 0;
    resize: none;
    border: 1px solid var(--border-strong);
    padding: 0.55rem 0.7rem;
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

  .composer :global(.shimpz-button) {
    height: 2.75rem;
    min-height: 0;
  }

  :global(.composer-actions .shimpz-button svg) {
    width: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: square;
    stroke-width: 1.6;
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

  .context-dock {
    width: min(calc(100% - 1.6rem), 48rem);
    justify-self: center;
    padding: 0.6rem 0;
  }

  @media (max-width: 640px) {
    :global(.turns .shimpz-message--user) { max-width: 92%; }
    .conversation { --chat-rail-gutter: 0.6rem; }
    .composer { gap: 0.45rem; padding: 0.6rem 0; }
    .composer-input { gap: 0.45rem; }
    :global(.composer-actions) { gap: 0.3rem; }
    .composer :global(.shimpz-button) { padding-inline: 0.65rem; }
  }
</style>
