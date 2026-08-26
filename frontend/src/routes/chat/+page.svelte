<script>
  import { flushSync, onMount, tick } from 'svelte';
  import { AssistantIcon, Button, ChatTask, EmptyState, Message, Notice, ScrollArea, TextAreaField, Toolbar } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import AssistantIntegrationsDialog from '$lib/AssistantIntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '$lib/AssistantIntegrationsDrawer.svelte';
  import ChatContextControls from '$lib/ChatContextControls.svelte';
  import ExecutionReceipt from '$lib/ExecutionReceipt.svelte';
  import { localizedEventLabel } from '$lib/executionProgress.js';
  import Markdown from '$lib/Markdown.svelte';
  import { escapeMarkdownText } from '$lib/markdown.js';
  import { t } from '$lib/i18n.js';
  import { modelContext } from '$lib/modelContext.js';
  import ProviderSetupGate from '$lib/ProviderSetupGate.svelte';
  import { sessionContext } from '$lib/sessionContext.js';
  import ShimpzThinking from '$lib/ShimpzThinking.svelte';
  import { refreshTeamInventory, teamContext } from '$lib/teamContext.js';
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
  let lifecycleOutcomePending = $state(null);
  let progressEvents = $state([]);
  let progressSequence = $state(0);
  let stopping = $state(false);
  let error = $state('');
  let errorDetail = $state('');
  let socket = $state(null);
  let socketReady = $state(false);
  let reconnectTimer;
  const lifecycleExpiryTimers = new Map();
  let reconnectAttempt = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  let integrationsOpen = $state(false);
  let integrationsButton = $state();
  let integrationsDialogOpen = $state(false);
  let integrationChallenge = $state();
  let humanChallenge = $state();
  let humanRejection = $state();
  let humanWorking = $state(false);
  let humanExpiredId = $state('');
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
  let humanRequestCopy = $derived($t('humanRequest'));
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
  let lifecycleWorking = $derived(turns.some((turn) => turn.lifecycle?.state === 'working'));
  let composerBusy = $derived(busy || syncing || lifecycleOutcomePending !== null);
  let currentProgress = $derived(progressEvents.at(-1));
  let assistantNames = $derived(new Map($teamContext.catalog.map((assistant) => [assistant.id, assistant.name])));
  let liveStatus = $derived(
    lifecycleWorking
      ? lifecycleCopy(turns.findLast((turn) => turn.lifecycle?.state === 'working')?.lifecycle).working
      : currentProgress
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
  let lifecycleDecisionDisabled = $derived(
    composerBusy ||
      stopping ||
      !socketReady ||
      !socket ||
      chatTeamId !== selectedTeamId,
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
    return turns.map((turn) => (
      turn.role === 'user'
        ? { role: 'user', text: turn.text }
        : { role: 'assistant', text: turn.text, author: turn.author }
    ));
  }

  function lifecycleCopy(lifecycle) {
    return lifecycle?.operation === 'uninstall' ? copy.uninstall : copy.install;
  }

  function lifecycleVisualState(state) {
    if (state === 'proposed') return 'pending';
    if (state === 'working') return 'working';
    if (state === 'installed' || state === 'uninstalled') return 'complete';
    if (state === 'cancelled' || state === 'expired') return 'cancelled';
    return 'failed';
  }

  function lifecycleStatus(lifecycle) {
    const lifecycleMessages = lifecycleCopy(lifecycle);
    if (lifecycle.state === 'proposed') return lifecycleMessages.pending;
    if (lifecycle.state === 'working') return lifecycleMessages.working;
    if (lifecycle.state === 'installed') {
      return lifecycle.installed ? lifecycleMessages.complete : lifecycleMessages.available;
    }
    if (lifecycle.state === 'uninstalled') {
      return lifecycle.uninstalled ? lifecycleMessages.complete : lifecycleMessages.absent;
    }
    if (lifecycle.state === 'cancelled') return lifecycleMessages.cancelled;
    if (lifecycle.state === 'expired') return lifecycleMessages.expired;
    if (lifecycle.state === 'unknown') return lifecycleMessages.unknown ?? copy.disconnected;
    return lifecycleMessages.failed;
  }

  function lifecycleIconSource(lifecycle) {
    const assistantId = encodeURIComponent(lifecycle.assistant.id);
    if (lifecycle.operation === 'uninstall') {
      if (!chatTeamId || lifecycle.state === 'uninstalled') return undefined;
      return `/api/teams/${encodeURIComponent(chatTeamId)}/assistants/${assistantId}/icon`;
    }
    if (lifecycle.state === 'installed' && chatTeamId) {
      return `/api/teams/${encodeURIComponent(chatTeamId)}/assistants/${assistantId}/icon`;
    }
    return `/api/assistants/${assistantId}/catalog-icon`;
  }

  function clearLifecycleExpiry(proposalId) {
    const timer = lifecycleExpiryTimers.get(proposalId);
    if (timer) clearTimeout(timer);
    lifecycleExpiryTimers.delete(proposalId);
  }

  function scheduleLifecycleExpiry(proposalId, expiresIn) {
    clearLifecycleExpiry(proposalId);
    lifecycleExpiryTimers.set(proposalId, setTimeout(() => {
      lifecycleExpiryTimers.delete(proposalId);
      turns = turns.map((turn) => (
        turn.lifecycle?.proposal_id === proposalId && turn.lifecycle.state === 'proposed'
          ? { ...turn, lifecycle: { ...turn.lifecycle, state: 'expired' } }
          : turn
      ));
    }, expiresIn * 1000));
  }

  function expireSocketLifecycles() {
    for (const timer of lifecycleExpiryTimers.values()) clearTimeout(timer);
    lifecycleExpiryTimers.clear();
    turns = turns.map((turn) => {
      if (turn.lifecycle?.state === 'proposed') {
        return { ...turn, lifecycle: { ...turn.lifecycle, state: 'expired' } };
      }
      if (turn.lifecycle?.state === 'working') {
        return { ...turn, lifecycle: { ...turn.lifecycle, state: 'unknown' } };
      }
      return turn;
    });
  }

  function lifecycleTurnIndex(proposalId) {
    return turns.findLastIndex((turn) => turn.lifecycle?.proposal_id === proposalId);
  }

  function applyLifecycleEvent(incoming, receipt) {
    const operation = incoming.type === 'assistant-uninstall' ? 'uninstall' : 'install';
    if (incoming.state === 'proposed') {
      if (lifecycleTurnIndex(incoming.proposal_id) !== -1) throw new Error('duplicate lifecycle proposal');
      turns = [...turns, {
        role: 'assistant',
        text: incoming.reply,
        author: incoming.team_name,
        receipt,
        lifecycle: {
          operation,
          proposal_id: incoming.proposal_id,
          assistant: incoming.assistant,
          state: 'proposed',
        },
      }];
      scheduleLifecycleExpiry(incoming.proposal_id, incoming.expires_in);
      return true;
    }
    const index = lifecycleTurnIndex(incoming.proposal_id);
    if (index < 0) throw new Error('unknown lifecycle proposal');
    const current = turns[index].lifecycle;
    if (current.operation !== operation || current.assistant.id !== incoming.assistant_id) {
      throw new Error('mismatched lifecycle proposal');
    }
    clearLifecycleExpiry(incoming.proposal_id);
    const workingState = operation === 'uninstall' ? 'uninstalling' : 'installing';
    const completeState = operation === 'uninstall' ? 'uninstalled' : 'installed';
    const allowed = current.state === 'proposed'
      ? [workingState, 'cancelled', 'expired']
      : current.state === 'working' ? [completeState, 'failed']
        : current.state === 'expired' ? ['expired'] : [];
    if (!allowed.includes(incoming.state)) throw new Error('invalid lifecycle transition');
    const state = incoming.state === workingState ? 'working' : incoming.state;
    const updated = {
      ...current,
      state,
      ...(incoming.state === 'installed'
        ? {
            installed: incoming.installed,
            ...(incoming.actions
              ? {
                  assistant_version: incoming.assistant_version,
                  actions: incoming.actions,
                }
              : {}),
          }
        : {}),
      ...(incoming.state === 'uninstalled' ? { uninstalled: incoming.uninstalled } : {}),
      ...(incoming.state === 'failed' ? { status: incoming.status } : {}),
    };
    turns = turns.map((turn, turnIndex) => (
      turnIndex === index ? { ...turn, lifecycle: updated } : turn
    ));
    return incoming.state !== workingState;
  }

  async function appendInstallOutcome(incoming) {
    const { installedAssistants } = await refreshTeamInventory(fetch);
    if (
      lifecycleOutcomePending?.teamId !== incoming.team_id ||
      lifecycleOutcomePending?.proposalId !== incoming.proposal_id ||
      lifecycleOutcomePending?.assistantId !== incoming.assistant_id ||
      chatTeamId !== incoming.team_id
    ) return;
    const index = lifecycleTurnIndex(incoming.proposal_id);
    if (index < 0) return;
    const install = turns[index].lifecycle;
    if (
      install.operation !== 'install' ||
      install.state !== 'installed' ||
      install.assistant.id !== incoming.assistant_id ||
      install.completionAnnounced
    ) return;
    const installedAssistant = installedAssistants.find(
      (entry) => entry.assistant === incoming.assistant_id,
    );
    const team = $teamContext.teams.find((entry) => entry.id === incoming.team_id);
    const projectedAssistant = $teamContext.installedAssistants.find(
      (entry) => entry.assistant === incoming.assistant_id,
    );
    if (
      !installedAssistant ||
      installedAssistant.status !== 'running' ||
      !team ||
      $teamContext.phase !== 'ready' ||
      $teamContext.selectedTeamId !== incoming.team_id ||
      projectedAssistant?.assistant_version !== installedAssistant.assistant_version ||
      projectedAssistant?.status !== 'running' ||
      !$teamContext.selectedAssistantIds.includes(incoming.assistant_id)
    ) throw new Error('installed Assistant inventory mismatch');
    if (
      incoming.actions &&
      incoming.assistant_version !== installedAssistant.assistant_version
    ) throw new Error('installed Assistant label version mismatch');
    const outcomeKey = install.installed ? 'installedReply' : 'availableReply';
    const outcome = $t(`chatPage.install.${outcomeKey}`, {
      assistant: escapeMarkdownText(install.assistant.name),
      version: escapeMarkdownText(installedAssistant.assistant_version),
      team: escapeMarkdownText(team.name),
    });
    const actionList = incoming.actions
      ? `\n\n${copy.install.actions}\n${incoming.actions.map((action) => (
          `- ${escapeMarkdownText(action.label)} — \`${action.id}\``
        )).join('\n')}`
      : '';
    const nextTurns = turns.map((turn, turnIndex) => (
      turnIndex === index
        ? { ...turn, lifecycle: { ...turn.lifecycle, completionAnnounced: true } }
        : turn
    ));
    nextTurns.splice(index + 1, 0, {
      role: 'assistant',
      text: `${outcome}${actionList}\n\n${copy.install.resend}`,
      author: team.name,
    });
    turns = nextTurns;
    void revealLatestExchange();
  }

  async function appendUninstallOutcome(incoming) {
    const { installedAssistants } = await refreshTeamInventory(fetch);
    if (
      lifecycleOutcomePending?.teamId !== incoming.team_id ||
      lifecycleOutcomePending?.proposalId !== incoming.proposal_id ||
      lifecycleOutcomePending?.assistantId !== incoming.assistant_id ||
      chatTeamId !== incoming.team_id
    ) return;
    const index = lifecycleTurnIndex(incoming.proposal_id);
    if (index < 0) return;
    const uninstall = turns[index].lifecycle;
    if (
      uninstall.operation !== 'uninstall' ||
      uninstall.state !== 'uninstalled' ||
      uninstall.assistant.id !== incoming.assistant_id ||
      uninstall.completionAnnounced
    ) return;
    const team = $teamContext.teams.find((entry) => entry.id === incoming.team_id);
    const stillInstalled = installedAssistants.some(
      (entry) => entry.assistant === incoming.assistant_id,
    );
    const stillProjected = $teamContext.installedAssistants.some(
      (entry) => entry.assistant === incoming.assistant_id,
    );
    if (
      stillInstalled ||
      stillProjected ||
      !team ||
      $teamContext.phase !== 'ready' ||
      $teamContext.selectedTeamId !== incoming.team_id ||
      $teamContext.selectedAssistantIds.includes(incoming.assistant_id)
    ) throw new Error('uninstalled Assistant inventory mismatch');
    const outcomeKey = uninstall.uninstalled ? 'uninstalledReply' : 'absentReply';
    const outcome = $t(`chatPage.uninstall.${outcomeKey}`, {
      assistant: escapeMarkdownText(uninstall.assistant.name),
      version: escapeMarkdownText(uninstall.assistant.version),
      team: escapeMarkdownText(team.name),
    });
    const nextTurns = turns.map((turn, turnIndex) => (
      turnIndex === index
        ? { ...turn, lifecycle: { ...turn.lifecycle, completionAnnounced: true } }
        : turn
    ));
    nextTurns.splice(index + 1, 0, {
      role: 'assistant',
      text: `${outcome}\n\n${copy.uninstall.reinstall}`,
      author: team.name,
    });
    turns = nextTurns;
    void revealLatestExchange();
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
      composerBusy ||
      integrationsOpen ||
      document.querySelector('dialog[open]')
    ) return;
    composerInput?.focus({ preventScroll: true });
  }

  async function focusStop() {
    await tick();
    if (mounted && busy && !syncing && !lifecycleWorking && !integrationChallenge && !humanChallenge) {
      stopButton?.focus({ preventScroll: true });
    }
  }

  async function focusLifecycleTask(proposalId) {
    await tick();
    if (!mounted || !busy || !lifecycleWorking) return;
    document.getElementById(`assistant-lifecycle-${proposalId}`)?.focus({ preventScroll: true });
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

  function projectedChatError(status, detail) {
    if (status === 403 && detail === 'authentication was not confirmed') {
      return { message: copy.authenticationDenied, detail: '' };
    }
    if (status === 503 && detail === 'authentication is unavailable') {
      return { message: copy.authenticationUnavailable, detail: '' };
    }
    return {
      message: friendlyChatError(status),
      detail: `HTTP ${status} · ${detail}`,
    };
  }

  function resetChallengeState({ includeInventory = false } = {}) {
    integrationChallenge = undefined;
    humanChallenge = undefined;
    humanRejection = undefined;
    humanWorking = false;
    humanExpiredId = '';
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
    expireSocketLifecycles();
    resetProgress();
    resetChallengeState();
    current?.close(1000, 'Team changed');
  }

  function acceptIntegrationChallenge(incoming) {
    const selected = new Set($teamContext.selectedAssistantIds);
    if (incoming.requirements.some((requirement) => !selected.has(requirement.assistant_id))) {
      throw new Error('unexpected Assistant integration requirement');
    }
    expireSocketLifecycles();
    integrationChallenge = incoming;
    humanChallenge = undefined;
    humanRejection = undefined;
    humanWorking = false;
    humanExpiredId = '';
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
    expireSocketLifecycles();
    const reconciledExpiry = humanExpiredId === incoming.challenge_id;
    humanExpiredId = '';
    if (reconciledExpiry) clearError();
    humanChallenge = incoming;
    humanRejection = undefined;
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
        if (incoming.type === 'human-response-rejected') {
          if (
            !humanWorking ||
            humanChallenge?.challenge_id !== incoming.challenge_id ||
            humanChallenge?.request?.kind !== 'auth:password'
          ) throw new Error('unexpected human response rejection');
          humanWorking = false;
          if (humanExpiredId === incoming.challenge_id) {
            reconcileExpiredHuman(incoming.challenge_id);
            return;
          }
          humanRejection = incoming;
          return;
        }
        if (incoming.type === 'progress') {
          if (!busy && !syncing) throw new Error('unexpected progress frame');
          if (incoming.seq !== progressSequence + 1) throw new Error('out-of-order progress frame');
          progressSequence = incoming.seq;
          progressEvents = [...progressEvents, incoming];
          const completedHumanTransition = humanWorking;
          if (completedHumanTransition) {
            humanChallenge = undefined;
            humanWorking = false;
            humanExpiredId = '';
          }
          humanRejection = undefined;
          if (completedHumanTransition) void focusStop();
          return;
        }
        if (incoming.type === 'sync-empty') {
          syncing = false;
          resetProgress();
          if (humanExpiredId) {
            busy = false;
            stopping = false;
            resetChallengeState();
            return;
          }
          if (busy && turns.length > 0) {
            busy = false;
            stopping = false;
            resetChallengeState();
            setError(copy.turnFailed);
          }
          return;
        }
        if (incoming.type === 'assistant-install' || incoming.type === 'assistant-uninstall') {
          if (!busy || stopping || syncing) throw new Error('unexpected Assistant lifecycle event');
          const receipt = progressEvents.map((item) => ({ ...item }));
          const terminal = applyLifecycleEvent(incoming, receipt);
          stopping = false;
          resetProgress();
          if (!terminal) {
            void focusLifecycleTask(incoming.proposal_id);
            return;
          }
          busy = false;
          clearError();
          if (incoming.state === 'installed' || incoming.state === 'uninstalled') {
            lifecycleOutcomePending = {
              teamId: incoming.team_id,
              proposalId: incoming.proposal_id,
              assistantId: incoming.assistant_id,
            };
            const appendOutcome = incoming.state === 'uninstalled'
              ? appendUninstallOutcome
              : appendInstallOutcome;
            const lifecycleMessages = incoming.state === 'uninstalled'
              ? copy.uninstall
              : copy.install;
            void appendOutcome(incoming)
              .catch(() => {
                if (
                  lifecycleOutcomePending?.teamId === incoming.team_id &&
                  lifecycleOutcomePending?.proposalId === incoming.proposal_id
                ) setError(lifecycleMessages.refreshFailed);
              })
              .finally(() => {
                if (
                  lifecycleOutcomePending?.teamId === incoming.team_id &&
                  lifecycleOutcomePending?.proposalId === incoming.proposal_id
                ) lifecycleOutcomePending = null;
              });
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
      expireSocketLifecycles();
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
        clearError();
      } else {
        const projectedError = projectedChatError(incoming.status, incoming.detail);
        setError(projectedError.message, projectedError.detail);
      }
      resetProgress();
    };
    active.onclose = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      socket = null;
      socketReady = false;
      syncing = false;
      stopping = false;
      expireSocketLifecycles();
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
    lifecycleOutcomePending = null;
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
    integrationWorking = 'connect';
    flushSync();
    const expectedCompletionMode = $sessionContext.oauthCompletionMode;
    // Code completion needs a separate tab opened while this click still owns browser activation.
    const authorizationWindow = expectedCompletionMode === 'code'
      ? window.open('about:blank', '_blank')
      : null;
    if (authorizationWindow) authorizationWindow.opener = null;
    let authorizationStarted = false;
    try {
      const authorization = await authorizeAssistantIntegration(fetch, teamId, challengeId);
      authorizationStarted = true;
      if (chatTeamId !== teamId || integrationChallenge?.challenge_id !== challengeId) {
        throw new Error(integrationsCopy.authorizationFailed);
      }
      if (authorization.completion_mode !== expectedCompletionMode) {
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

  function submitMessage(message, {
    focusActiveTurn = true,
    projectUserTurn = true,
  } = {}) {
    const teamId = $teamContext.selectedTeamId;
    const normalized = message.trim();
    if (
      composerBusy ||
      !teamId ||
      chatTeamId !== teamId ||
      !normalized ||
      !socketReady ||
      !socket
    ) return false;
    let frame;
    try {
      frame = createChatFrame(teamId, {
        message: normalized,
        files: [],
        assistant_ids: $teamContext.selectedAssistantIds,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      return false;
    }
    busy = true;
    resetProgress();
    clearError();
    if (projectUserTurn) {
      turns = [...turns, { role: 'user', text: normalized }];
      void revealLatestExchange();
    }
    try {
      socket.send(JSON.stringify(frame));
      if (focusActiveTurn) void focusStop();
      return true;
    } catch (reason) {
      busy = false;
      resetProgress();
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      socket.close();
      return false;
    }
  }

  function submitLifecycleDecision(decision) {
    return submitMessage(decision, { focusActiveTurn: false, projectUserTurn: false });
  }

  function send(event) {
    event.preventDefault();
    if (submitMessage(draft)) draft = '';
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
      const waitForAuthentication = response.decision === 'submit' && challenge.request.kind === 'auth:password';
      if (waitForAuthentication) {
        humanWorking = true;
      } else {
        humanChallenge = undefined;
        humanWorking = false;
      }
      humanRejection = undefined;
      clearError();
      if (!waitForAuthentication) void focusStop();
    } catch (reason) {
      humanWorking = false;
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      socket.close();
    }
  }

  function retryHumanAuthentication() {
    if (humanChallenge?.request?.kind === 'auth:password') humanRejection = undefined;
  }

  function reconcileExpiredHuman(challengeId) {
    if (humanChallenge?.challenge_id !== challengeId || humanWorking) return;
    humanExpiredId = challengeId;
    busy = false;
    stopping = false;
    humanChallenge = undefined;
    humanRejection = undefined;
    setError(humanRequestCopy.expired);
    if (!socketReady || !socket || syncing) return;
    syncing = true;
    resetProgress();
    try {
      socket.send(JSON.stringify(createSyncFrame(chatTeamId)));
    } catch {
      syncing = false;
      socket.close();
    }
  }

  function expireHumanRequest(challengeId) {
    if (humanChallenge?.challenge_id !== challengeId || humanExpiredId === challengeId) return;
    humanExpiredId = challengeId;
    if (!humanWorking) reconcileExpiredHuman(challengeId);
  }

  $effect(() => {
    const nextTeamId = chatTeamId;
    if (!mounted || nextTeamId === socketTeamId) return;
    activateTeam(nextTeamId);
  });

  $effect(() => {
    if (mounted && chatTeamId && !composerBusy && !integrationsOpen) void focusComposer();
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
          aria-busy={composerBusy && !integrationChallenge && !humanChallenge}
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
                  {#if exchange.assistant.lifecycle}
                    {@const lifecycle = exchange.assistant.lifecycle}
                    {@const lifecycleMessages = lifecycleCopy(lifecycle)}
                    {#snippet lifecycleMedia()}
                      <AssistantIcon
                        assistant={lifecycle.assistant.id}
                        src={lifecycleIconSource(lifecycle)}
                        size={44}
                      />
                    {/snippet}
                    {#snippet lifecycleDetails()}
                      <div class="assistant-lifecycle-details">
                        {#if lifecycle.state === 'proposed'}
                          <span class="assistant-lifecycle-detail-copy assistant-lifecycle-confirm-copy">
                            {lifecycleMessages.confirm}
                          </span>
                          <div class="assistant-lifecycle-actions">
                            <Button
                              variant="secondary"
                              size="compact"
                              type="button"
                              onclick={() => submitLifecycleDecision('no')}
                              disabled={lifecycleDecisionDisabled}
                              aria-label={$t(`chatPage.${lifecycle.operation}.cancelActionLabel`, {
                                assistant: lifecycle.assistant.name,
                              })}
                            >
                              {lifecycleMessages.cancelAction}
                            </Button>
                            <Button
                              variant={lifecycle.operation === 'uninstall' ? 'danger' : 'primary'}
                              size="compact"
                              type="button"
                              onclick={() => submitLifecycleDecision('yes')}
                              disabled={lifecycleDecisionDisabled}
                              aria-label={$t(`chatPage.${lifecycle.operation}.${lifecycle.operation}ActionLabel`, {
                                assistant: lifecycle.assistant.name,
                              })}
                            >
                              {lifecycleMessages[`${lifecycle.operation}Action`]}
                            </Button>
                          </div>
                        {/if}
                        {#if lifecycle.status}
                          <span class="assistant-lifecycle-detail-copy">HTTP {lifecycle.status}</span>
                        {/if}
                      </div>
                    {/snippet}
                    <ChatTask
                      class="assistant-lifecycle-task"
                      id={`assistant-lifecycle-${lifecycle.proposal_id}`}
                      label={lifecycleMessages.label}
                      title={lifecycle.assistant.name}
                      description={lifecycle.operation === 'uninstall'
                        ? lifecycleMessages.consequences
                        : lifecycle.assistant.summary}
                      state={lifecycleVisualState(lifecycle.state)}
                      status={lifecycleStatus(lifecycle)}
                      media={lifecycleMedia}
                      details={lifecycle.state === 'proposed' || lifecycle.status
                        ? lifecycleDetails
                        : undefined}
                      tabindex={lifecycle.state === 'working' ? -1 : undefined}
                    />
                  {/if}
                  <ExecutionReceipt
                    events={exchange.assistant.receipt ?? []}
                    label={copy.progressStagesExecuted}
                    progressLabels={copy.progress}
                    teamName={exchange.assistant.author}
                    {assistantNames}
                  />
                </Message>
              {:else if index === exchanges.length - 1 && busy && !lifecycleWorking && !integrationChallenge && !humanChallenge}
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
            <ChatContextControls disabled={composerBusy || stopping} />
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
                disabled={composerBusy}
                onkeydown={handleComposerKeydown}
              />
              <Toolbar class="composer-actions">
              {#if busy && !syncing && !lifecycleWorking}
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
                disabled={composerBusy || !socketReady || !draft.trim()}
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
        />
        <AssistantIntegrationsDialog
          open={integrationsDialogOpen}
          challenge={integrationChallenge}
          installedAssistants={$teamContext.installedAssistants}
          onclose={closeIntegrationsDialog}
          onauthorize={authorizeIntegration}
          oncomplete={completeIntegration}
          oncancel={cancelIntegrationAuthorization}
        />
        <AssistantHumanRequestDialog
          open={Boolean(humanChallenge) && humanChallenge?.challenge_id !== humanExpiredId}
          challenge={humanChallenge}
          rejection={humanRejection}
          working={humanWorking}
          onrespond={respondToHuman}
          onretry={retryHumanAuthentication}
          onexpire={expireHumanRequest}
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

  :global(.assistant-lifecycle-task) {
    margin-top: 0.8rem;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-detail-copy) {
    display: block;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-confirm-copy) {
    text-align: right;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-details) {
    display: grid;
    gap: 0.55rem;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-actions) {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.55rem;
    margin-top: 0.7rem;
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

  @media (max-width: 820px) {
    .empty-conversation .composer { align-self: end; }
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
