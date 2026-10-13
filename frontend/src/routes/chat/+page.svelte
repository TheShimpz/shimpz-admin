<script>
  import { flushSync, getContext, onMount, tick } from 'svelte';
  import { readable } from 'svelte/store';
  import { Button, EmptyState, Notice, ScrollArea } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '#lib/AssistantHumanRequestDialog.svelte';
  import { MessageFiles } from '#lib/chat/attachments/upload.svelte.js';
  import AssistantIntegrationsDialog from '#lib/AssistantIntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '#lib/AssistantIntegrationsDrawer.svelte';
  import Composer from '#lib/chat/Composer.svelte';
  import Exchange from '#lib/chat/Exchange.svelte';
  import { snapshotIcon } from '#lib/chat/lifecycle/snapshot.js';
  import { historyHead, listChatHistory } from '#lib/chatHistory.js';
  import {
    expiredTurns,
    friendlyChatError,
    groupExchanges,
    historyTurn,
    installPlanTurns,
    lifecycleTurnIndex,
    lifecycleTurns,
    projectedChatError,
    replyFields,
  } from '#lib/chat/turns.js';
  import { clarifiedRequest, matchClarificationAnswers } from '#lib/clarification.js';
  import { promptHistoryStep } from '#lib/promptHistory.js';
  import ChatDay from '#lib/ChatDay.svelte';
  import { calendarDay, exchangeDays, turnInstants, untilNextDay } from '#lib/chatDays.js';
  import { newerRoutineEntries } from '#lib/routines/protocol.js';
  import { questionWords } from '#lib/routines/words.js';
  import { showTeamRoutines } from '#lib/routineContext.js';
  import { adminSocket, call, commandsReady, openChatChannel, outcomeUnknown } from '#lib/adminSocket.js';
  import {
    createExecutionProjection,
    extendExecutionProjection,
    localizedEventLabel,
  } from '#lib/executionProgress.js';
  import { escapeMarkdownText } from '#lib/markdown.js';
  import { locale, t } from '#lib/i18n.js';
  import { INITIAL_VIEW_READINESS } from '#lib/initialView.js';
  import { CLARIFICATION_LABELS } from '#lib/clarificationLabels.js';
  import { routineQuestionMessages } from '#lib/routineQuestionMessages.js';
  import { configureModelContext, loadModelContext, modelContext } from '#lib/modelContext.js';
  import { sessionContext } from '#lib/sessionContext.js';
  import ShimpzThinking from '#lib/ShimpzThinking.svelte';
  import { MAX_TEAM_ASSISTANTS, refreshTeamInventory, teamContext } from '#lib/teamContext.js';
  import { ASSISTANT_LIMIT_REACHED } from '#lib/api.js';
  import {
    authorizeAssistantIntegration,
    cancelAssistantIntegrationAuthorization,
    clearAssistantStoredInput,
    completeAssistantIntegration,
    oauthReturnFailure,
    teamIntegrations,
  } from '#lib/assistants/integrations.js';
  import {
    capabilityContinuation,
    createChatFrame,
    createHumanResponseFrame,
    createResumeTaskFrame,
    createStopFrame,
    createSyncFrame,
    parseChatEvent,
  } from '#lib/chat/protocol.js';


  const booting = getContext(INITIAL_VIEW_READINESS)?.booting ?? readable(false);
  let mounted = $state(false);
  let socketTeamId = $state('');
  let draft = $state('');
  let draftTeamId = '';
  // The next message's files (ADR-0093), uploaded one at a time to the Team they were selected for.
  const messageFiles = new MessageFiles(attachmentRefusalText);
  let attachmentInput = $state();
  // Every change replaces the list or the turn it changes, never a field in place, so no turn needs a deep proxy.
  let turns = $state.raw([]);
  let nextRenderKey = 0;
  let busy = $state(false);
  // When the turn in flight started, as this page observed it: its thinking view counts from here, also after a human
  // or Integration request hid it for a while.
  let turnStartedAt = $state(0);

  function beginTurn() {
    if (!busy) turnStartedAt = Date.now();
    busy = true;
  }
  // Assistants the current turn's continuing install plan proved running; a just-in-time request may reach the
  // browser, or be redelivered after a same-Team reconnect, before the asynchronous Team inventory refresh reflects
  // them. Cleared at every terminal result, empty sync, protocol error, new message, and Team change.
  let turnInstalled = { teamId: '', ids: new Set() };
  // Advances at every turn boundary so an inventory-dependent admission started in an older turn is discarded.
  let turnEpoch = 0;

  function clearTurnInstalled() {
    turnInstalled = { teamId: '', ids: new Set() };
    turnEpoch += 1;
  }

  // What a connection that ended, closed or refused for a protocol violation, leaves behind: no turn, progress,
  // challenge, or lifecycle card of it stays live. A reconnect may restore another turn; one this page still waits on
  // keeps only what it observes from then on.
  function resetConnection() {
    forgetSegments();
    socket = null;
    socketReady = false;
    busy = false;
    syncing = false;
    stopping = false;
    expireSocketLifecycles();
    resetProgress();
    resetChallengeState();
  }

  function failProtocol(active) {
    resetConnection();
    clearTurnInstalled();
    setError(copy.protocolError);
    active.close(1002, 'Invalid chat event');
  }

  function installedThisTurn(assistantId) {
    return turnInstalled.teamId === chatTeamId && turnInstalled.ids.has(assistantId);
  }
  let syncing = $state(false);
  let lifecycleOutcomePending = $state(null);
  let progressEvents = $state([]);
  let progressProjection = $state(createExecutionProjection());
  let progressSequence = $state(0);
  let stopping = $state(false);
  let lifecycleDecisionPending = $state(false);
  let error = $state('');
  let errorDetail = $state('');
  // The selected Team's chat channel on the Admin session socket (ADR-0114). The shell's socket reconnects on its own
  // and asks Admin whether the session still holds; the channel attaches again when it reopens, and Admin then
  // synchronizes the Team, so this page only reflects whether its channel is open.
  let socket = $state(null);
  let socketReady = $state(false);
  const lifecycleExpiryTimers = new Map();
  const lifecycleIconCaptures = new Map();
  let integrationsOpen = $state(false);
  let integrationsButton = $state();
  let integrationsDialogOpen = $state(false);
  let integrationChallenge = $state();
  let humanChallenge = $state();
  let humanRejection = $state();
  let humanWorking = $state(false);
  let humanExpiredId = $state('');
  // The interface language a reconciling sync asked Team to render the pending request in (ADR-0091).
  let humanRelocalizing = $state('');
  // The shown Team's Integrations and Stored Inputs while the drawer is open, each a synced value (ADR-0114).
  let integrationSources = $state(null);
  let integrationsState = $state(null);
  let storedInputsState = $state(null);
  let integrationWorking = $state('');
  let storedInputWorking = $state('');
  let oauthFailedOnReturn = false;
  let composerInput = $state();
  let chatRoute = $state();
  let inventoryRetry = $state();
  // Whether the focus was last inside this chat (or the chat was just opened); only then may it return to the composer.
  let chatOwnsFocus = true;
  let stopButton = $state();
  let turnsViewport = $state();
  let scrollRequest = 0;
  let capabilityObjective = null;
  let promptHistoryIndex = -1;
  let historyLoading = $state(true);
  let historyWorking = $state(false);
  let historyBefore = $state(null);
  // Earlier history loads when the top of the transcript is in view, only after the opening scroll has settled.
  let olderHistoryArmed = $state(false);
  let olderHistoryFailed = $state(false);
  let historySentinel = $state();
  let historyGeneration = 0;

  let copy = $derived($t('chatPage'));
  // The chat's words for its transcript (chat/turns.js): its copy and the localized Assistant-limit refusal.
  let words = $derived({ ...copy, limit: $t('store.assistantLimitReached', { maximum: String(MAX_TEAM_ASSISTANTS) }) });
  let integrationsCopy = $derived($t('assistantIntegrations'));
  let humanRequestCopy = $derived($t('humanRequest'));
  // A request rendered in another language than the one selected now is never answered; a fresh one is requested.
  let humanStale = $derived(Boolean(humanChallenge) && humanChallenge.locale !== $locale);
  // While a reconciling sync is in flight Team may already have replaced the shown request, even after switching back.
  let humanUnanswerable = $derived(humanStale || Boolean(humanRelocalizing));
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === selectedTeamId) ?? null,
  );
  // The conversation stays mounted while this Team's Brain loads, needs a key, or failed; only a send needs it ready.
  let chatTeamId = $derived(
    $modelContext.phase !== 'idle' && $modelContext.teamId === selectedTeamId ? selectedTeamId : '',
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived($t('chatPage.placeholder', { team: teamName }));
  let thinking = $derived(copy.sending);
  let exchanges = $derived(groupExchanges(turns));
  // Each exchange's calendar day in the viewer's timezone (chatDays.js says which time an item carries); a header
  // opens each day, and "today" moves at the viewer's midnight.
  const instantOf = turnInstants();
  let today = $state(calendarDay(Date.now()));
  let days = $derived(exchangeDays(exchanges, instantOf));
  $effect(() => instantOf.retain(turns));
  let installPlanWorking = $derived(turns.some((turn) => (
    ['planned', 'installing'].includes(turn.installPlan?.state)
  )));
  let lifecycleWorking = $derived(turns.some((turn) => (
    turn.lifecycle?.state === 'working'
  )) || installPlanWorking);
  let historyHydrating = $derived(
    Boolean(chatTeamId) && (historyLoading || socketTeamId !== chatTeamId),
  );
  // A connection that is opening is about to sync, so the composer stays read-only from the history load through the
  // first sync instead of accepting text for a moment and dropping what is typed when the sync starts.
  let socketOpening = $derived(Boolean(socket) && !socketReady);
  let composerBusy = $derived(
    busy || syncing || socketOpening || lifecycleOutcomePending !== null || historyHydrating,
  );
  // The Brain and fast-routing menus stay open while Admin reconnects, so a change they sent can say how it ended; what
  // they would send waits for the connection on its own.
  let menusBusy = $derived(
    busy || syncing || lifecycleOutcomePending !== null || historyHydrating || stopping,
  );
  // A message waits for a pending Brain change to be saved so the turn never runs on the previous selection.
  let brainSaving = $derived($modelContext.phase === 'saving');
  // A message names the Team's running Assistants, so it waits while their inventory is being read again (after an
  // install, for instance); the inventory shown meanwhile is for display only.
  let inventoryReady = $derived($teamContext.inventory === 'ready');
  // A read of it that failed holds sending until the Supervisor reads it again from the chat's notice.
  let inventoryFailed = $derived(Boolean(chatTeamId) && $teamContext.inventory === 'failed');
  // A question answer or a retry sends at once, so it is offered only when a message could be sent now.
  let sendUnavailable = $derived(
    composerBusy || brainSaving || !$modelContext.ready || !socketReady || !inventoryReady,
  );
  let brainProvider = $derived(
    $modelContext.providers.find((entry) => entry.id === $modelContext.provider) ?? null,
  );
  let brainModel = $derived(brainProvider?.models.find((entry) => entry.id === $modelContext.model) ?? null);
  // A selection whose provider has no key asks for it in place of the message, keeping the conversation.
  let keyRequired = $derived(
    Boolean(chatTeamId) && !$modelContext.ready && Boolean(brainModel) && !brainProvider.configured,
  );
  let brainUnavailable = $derived(
    Boolean(chatTeamId) && !$modelContext.ready && !keyRequired && $modelContext.phase === 'error',
  );
  let keySelection = $derived(`${chatTeamId}\u0000${$modelContext.provider}`);
  let providerKey = $state('');
  let currentProgress = $derived(progressEvents.at(-1));
  let assistantNames = $derived(new Map($teamContext.catalog.map((assistant) => [assistant.id, assistant.name])));
  let liveStatus = $derived(
    lifecycleWorking
      ? installPlanWorking
        ? copy.install.working
        : copy.uninstall.working
      : currentProgress
      ? `${thinking} ${localizedEventLabel(currentProgress, copy.progress, { teamName, assistantNames })}`
      : busy ? thinking : '',
  );
  let contextFailed = $derived($teamContext.phase === 'error');
  let teamsKnownEmpty = $derived($teamContext.phase === 'ready' && $teamContext.teams.length === 0 && !historyHydrating);
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
      lifecycleDecisionPending ||
      !inventoryReady ||
      !socketReady ||
      !socket ||
      chatTeamId !== selectedTeamId,
  );
  let visibleError = $derived(error || (contextFailed ? copy.loadFailed : ''));
  let visibleErrorDetail = $derived(error ? errorDetail : contextErrorDetail);

  // Every interface language's labels, so an answer sent in one language still closes its question in another.
  const CLARIFY_LABELS = Object.values(CLARIFICATION_LABELS);

  // The user message each live answer projected, mapped to the assistant turn of the card it answered.
  let liveAnswers = $state(new Map());

  function answerClarification(exchange, { composed }) {
    const userKey = nextRenderKey;
    if (submitMessage(composed) && turns.at(-1)?.renderKey === userKey) {
      liveAnswers = new Map(liveAnswers).set(userKey, exchange.assistant.renderKey);
    }
  }

  // A Routine question is answered as a clarification is, worded by Admin in the interface language: an answer sent in
  // any language closes it, so its question is matched in each.
  function asClarification(exchange) {
    const asked = exchange.assistant?.routineQuestion;
    if (!asked) return exchange;
    const question = questionWords(asked, $t('routine').proposal.questions).question;
    const questions = Object.values(routineQuestionMessages).map((words) => questionWords(asked, words).question);
    return { ...exchange, assistant: { ...exchange.assistant, clarification: { question, questions } } };
  }
  let answerable = $derived(exchanges.map(asClarification));

  // Each question is answered by at most one later message that is exactly its composed request; see the module.
  let clarificationAnswers = $derived(matchClarificationAnswers(answerable, liveAnswers, CLARIFY_LABELS));

  // While the latest reply asks a question nobody answered, the composer waits for that answer; the card sends it.
  let questionOpen = $derived.by(() => {
    const last = answerable.length - 1;
    return last >= 0 && clarifiedRequest(answerable[last]) !== null && !clarificationAnswers.given.has(last);
  });
  // Files join only a message that can be written now, for the Team whose Brain is ready to receive it.
  let attachmentsUnavailable = $derived(
    composerBusy || questionOpen || brainSaving || keyRequired || !chatTeamId,
  );

  // Team's progress of the earlier segments of the turn in flight, kept across each human or Integration pause so the
  // turn's receipt lists every step it observed; each event carries its segment, as every segment restarts its seq.
  let earlierSegments = [];
  let segmentNumber = 0;

  function retainSegment() {
    for (const event of progressEvents) {
      if (event.origin === 'team') earlierSegments.push({ ...event, segment: segmentNumber });
    }
    segmentNumber += 1;
  }

  function forgetSegments() {
    earlierSegments = [];
    segmentNumber = 0;
  }

  function turnReceipt() {
    const receipt = [...earlierSegments, ...progressEvents.map((event) => ({ ...event, segment: segmentNumber }))];
    forgetSegments();
    return receipt;
  }

  function resetProgress() {
    progressEvents = [];
    progressProjection = createExecutionProjection();
    progressSequence = 0;
  }

  // The Team's newest history, as its head first reads it, opens the conversation. A history that could not be read says
  // why and the chat connects without it; once the head reads it after all, the conversation opens from it.
  async function hydrateHistory(teamId, generation, value, connect) {
    try {
      const team = $teamContext.teams.find((entry) => entry.id === teamId);
      if (!team) throw new Error(copy.loadFailed);
      turns = value.entries.map((entry) => historyTurn(entry, team.name, nextRenderKey++, words));
      historyBefore = value.before;
      historyLoading = false;
      if (error === copy.loadFailed) clearError();
      connect();
      if (turns.length > 0) await revealLatestExchange({ instant: true });
      if (generation === historyGeneration && chatTeamId === teamId) olderHistoryArmed = true;
    } catch (reason) {
      failHydration(teamId, generation, reason, connect);
    }
  }

  function failHydration(teamId, generation, reason, connect) {
    if (generation !== historyGeneration || chatTeamId !== teamId) return;
    historyLoading = false;
    setError(
      copy.loadFailed,
      reason instanceof Error ? reason.message : copy.loadFailed,
    );
    connect();
  }

  async function loadOlderHistory() {
    const teamId = chatTeamId;
    const before = historyBefore;
    if (!teamId || !before || historyWorking) return;
    historyWorking = true;
    const generation = historyGeneration;
    try {
      const page = await listChatHistory(call, teamId, before);
      if (generation !== historyGeneration || chatTeamId !== teamId) return;
      // An older page must move the cursor, or automatic loading would request the same page forever.
      if (page.before === before || (page.entries.length === 0 && page.before !== null)) {
        throw new Error(copy.loadFailed);
      }
      const known = new Set(turns.map((turn) => turn.historyId).filter(Boolean));
      if (page.entries.some((entry) => known.has(entry.id))) throw new Error(copy.loadFailed);
      const team = $teamContext.teams.find((entry) => entry.id === teamId);
      if (!team) throw new Error(copy.loadFailed);
      // Measure where the reader is now, not when the request started, so prepending never moves their view.
      const viewport = turnsViewport;
      const previousHeight = viewport?.scrollHeight ?? 0;
      const previousTop = viewport?.scrollTop ?? 0;
      turns = [
        ...page.entries.map((entry) => historyTurn(entry, team.name, nextRenderKey++, words)),
        ...turns,
      ];
      historyBefore = page.before;
      // The loading status leaves in the same update, so the correction measures the layout the reader will see.
      historyWorking = false;
      await tick();
      if (viewport && viewport === turnsViewport) {
        viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
      }
      // Only an earlier page's own failure ends with it; any other error on screen stays.
      if (error === copy.loadFailed) clearError();
    } catch (reason) {
      if (generation === historyGeneration && chatTeamId === teamId) {
        olderHistoryFailed = true;
        setError(
          copy.loadFailed,
          reason instanceof Error ? reason.message : copy.loadFailed,
        );
      }
    } finally {
      if (generation === historyGeneration && chatTeamId === teamId) historyWorking = false;
    }
  }

  function retryOlderHistory() {
    olderHistoryFailed = false;
    void loadOlderHistory();
  }

  // Admin delivers Routine notices on its own schedule (ADR-0086) and says so on the session socket (ADR-0114): while a
  // Local Team's conversation is open, its history head (`historyHead`) reads the history written since it last read,
  // and the Team's Routines follow their own topic. The chat's view of the history holds, of the Routine notices, only
  // each Routine's creation; its runs are its own history, which its panel reads. Only Routine rows merge into the
  // transcript, by identity and version: a new row, or a newer version of a shown one, moves to the end as a reload
  // would show it. The rest of the conversation, the draft, and the reader's place stay as they are; a reader already at
  // the end follows the new row. When more was written than one refresh reads, the transcript starts again from what it
  // read, as a reload shows it, and earlier history continues from where the refresh stopped. What the head reads while
  // a turn or history is in motion waits, in order, until the conversation is idle again.
  const FOLLOW_SLACK = 48;
  let headQueue = [];
  let headWaiting = $state(0);
  let headApplying = false;

  // A row is never added under a message still waiting for its reply, or while history or a turn is in motion.
  function routineMergeIdle() {
    return !composerBusy && !historyWorking && turns.at(-1)?.role !== 'user';
  }

  async function applyHead(teamId, value) {
    const team = $teamContext.teams.find((entry) => entry.id === teamId);
    if (!team) return;
    if (value.restart) {
      turns = value.entries.map((entry) => historyTurn(entry, team.name, nextRenderKey++, words));
      historyBefore = value.before;
      await revealLatestExchange({ instant: true });
      return;
    }
    const shown = new Map(
      turns.filter((turn) => turn.routineRun).map((turn) => [turn.historyId, turn.routineRun.version]),
    );
    const arrived = newerRoutineEntries(shown, value.entries);
    if (arrived.length === 0) return;
    const viewport = turnsViewport;
    const following = Boolean(viewport) &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_SLACK;
    const moved = new Set(arrived.map((entry) => entry.id));
    turns = [
      ...turns.filter((turn) => !moved.has(turn.historyId)),
      ...arrived.map((entry) => historyTurn(entry, team.name, nextRenderKey++, words)),
    ];
    if (following) await revealLatestExchange();
  }

  async function drainHead(teamId) {
    if (headApplying) return;
    headApplying = true;
    try {
      while (headQueue.length && chatTeamId === teamId && !historyHydrating && routineMergeIdle()) {
        const value = headQueue.shift();
        headWaiting = headQueue.length;
        await applyHead(teamId, value);
      }
    } finally {
      headApplying = false;
    }
  }

  // The Team's history head and Routines are followed as the Team opens: the history is first read once its
  // subscription is in place, so a Routine notice written meanwhile is never missed (ADR-0114).
  let stopTeamTopics = () => {};

  function watchTeam(teamId, generation) {
    stopTeamTopics();
    stopTeamTopics = () => {};
    headQueue = [];
    headWaiting = 0;
    if (!teamId) return;
    // The chat connects once, after the history opened the conversation or failed to.
    let connected = false;
    const connect = () => {
      if (connected || generation !== historyGeneration) return;
      connected = true;
      connectSocket(teamId);
    };
    let hydrated = false;
    let failed = false;
    const head = historyHead(teamId, {
      failed: (reason) => {
        if (hydrated || failed) return;
        failed = true;
        failHydration(teamId, generation, reason, connect);
      },
    });
    let applied = null;
    const stopHead = head.subscribe((state) => {
      if (generation !== historyGeneration) return;
      if (state.status !== 'ready' || state.value === applied) return;
      applied = state.value;
      if (!hydrated) {
        hydrated = true;
        void hydrateHistory(teamId, generation, state.value, connect);
        return;
      }
      headQueue.push(state.value);
      headWaiting = headQueue.length;
    });
    const stopRoutines = showTeamRoutines(teamId);
    stopTeamTopics = () => {
      stopHead();
      stopRoutines();
    };
  }

  // What the head read while the conversation was in motion is applied, in order, once it is idle again.
  $effect(() => {
    if (headWaiting && chatTeamId && !historyHydrating && routineMergeIdle()) void drainHead(chatTeamId);
  });

  $effect(() => {
    void today;
    const timer = setTimeout(() => (today = calendarDay(Date.now())), untilNextDay(Date.now()) + 1_000);
    return () => clearTimeout(timer);
  });

  // A plan's frame adds or updates its turn; a new turn takes the next render identity.
  function applyInstallPlanEvent(incoming, receipt) {
    const next = installPlanTurns(turns, incoming, receipt, nextRenderKey, words);
    if (next.length > turns.length) nextRenderKey += 1;
    turns = next;
  }

  function captureUninstallIcon(proposalId, assistantId, teamId) {
    const existing = lifecycleIconCaptures.get(proposalId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let captured = false;
    const promise = snapshotIcon(teamId, assistantId, controller.signal).then((snapshot) => {
      if (!snapshot) return;
      captured = true;
      turns = turns.map((turn) => (
        turn.lifecycle?.proposal_id === proposalId &&
        turn.lifecycle.assistant.id === assistantId
          ? { ...turn, lifecycle: { ...turn.lifecycle, iconSnapshot: snapshot } }
          : turn
      ));
    }).catch(() => undefined).finally(() => {
      clearTimeout(timer);
      if (!captured && lifecycleIconCaptures.get(proposalId)?.promise === promise) {
        lifecycleIconCaptures.delete(proposalId);
      }
    });
    lifecycleIconCaptures.set(proposalId, { controller, promise });
    return promise;
  }

  function clearLifecycleIconCaptures() {
    for (const capture of lifecycleIconCaptures.values()) capture.controller.abort();
    lifecycleIconCaptures.clear();
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
    turns = expiredTurns(turns);
  }

  // A proposal adds its card, with its expiry and icon snapshot; a later frame moves it on. True when the uninstall ended.
  function applyLifecycleEvent(incoming, receipt) {
    const next = lifecycleTurns(turns, incoming, receipt, nextRenderKey, words);
    if (next.turns.length > turns.length) nextRenderKey += 1;
    turns = next.turns;
    if (incoming.state !== 'proposed') {
      clearLifecycleExpiry(incoming.proposal_id);
      return next.terminal;
    }
    scheduleLifecycleExpiry(incoming.proposal_id, incoming.expires_in);
    void captureUninstallIcon(
      incoming.proposal_id,
      incoming.assistant.id,
      incoming.team_id,
    );
    return next.terminal;
  }

  async function appendUninstallOutcome(incoming) {
    const { installedAssistants } = await refreshTeamInventory();
    if (
      lifecycleOutcomePending?.teamId !== incoming.team_id ||
      lifecycleOutcomePending?.proposalId !== incoming.proposal_id ||
      lifecycleOutcomePending?.assistantId !== incoming.assistant_id ||
      chatTeamId !== incoming.team_id
    ) return;
    const index = lifecycleTurnIndex(turns, incoming.proposal_id);
    if (index < 0) return;
    const uninstall = turns[index].lifecycle;
    if (
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
      $teamContext.activeAssistantIds.includes(incoming.assistant_id)
    ) throw new Error('uninstalled Assistant inventory mismatch');
    turns = turns.map((turn, turnIndex) => (
      turnIndex === index
        ? { ...turn, lifecycle: { ...turn.lifecycle, completionAnnounced: true } }
        : turn
    ));
    void revealLatestExchange();
  }

  // An uninstall's outcome is announced once Team's inventory confirms the Assistant is gone. A read that fails keeps
  // the outcome deferred, with its error, until the chat's Retry reads the inventory again.
  let deferredUninstall = null;

  function confirmUninstall(incoming) {
    deferredUninstall = null;
    lifecycleOutcomePending = {
      teamId: incoming.team_id,
      proposalId: incoming.proposal_id,
      assistantId: incoming.assistant_id,
    };
    const lifecycleMessages = copy.uninstall;
    const current = () => (
      lifecycleOutcomePending?.teamId === incoming.team_id &&
      lifecycleOutcomePending?.proposalId === incoming.proposal_id
    );
    return appendUninstallOutcome(incoming)
      .then(() => {
        if (current() && error === lifecycleMessages.refreshFailed) clearError();
      })
      .catch(() => {
        if (!current()) return;
        deferredUninstall = incoming;
        setError(lifecycleMessages.refreshFailed);
      })
      .finally(() => {
        if (current()) lifecycleOutcomePending = null;
      });
  }

  function clearError() {
    error = '';
    errorDetail = '';
  }

  function setError(message, detail = '') {
    error = message;
    errorDetail = detail;
  }

  // The composer takes the focus back only when the chat owned it and the control holding it went away (a Stop that
  // became Send, a composer that turned read-only while reconnecting): focus in another region, or on a control the
  // Supervisor chose, stays where it is.
  async function focusComposer() {
    await tick();
    const focused = document.activeElement;
    if (
      !mounted ||
      !chatTeamId ||
      keyRequired ||
      composerBusy ||
      integrationsOpen ||
      inventoryRetrying ||
      !chatOwnsFocus ||
      (focused && focused !== document.body) ||
      document.querySelector('dialog[open], :popover-open')
    ) return;
    composerInput?.focus({ preventScroll: true });
  }

  function trackFocus(event) {
    chatOwnsFocus = Boolean(chatRoute?.contains(event.target));
  }

  async function saveProviderKey(event) {
    event.preventDefault();
    const teamId = chatTeamId;
    const selection = keySelection;
    const apiKey = providerKey;
    // While Admin reconnects the key stays in its field, unsent, until it can be saved.
    if (!teamId || !keyRequired || brainSaving || !$commandsReady || apiKey.trim().length < 16) return;
    providerKey = '';
    try {
      await configureModelContext(teamId, apiKey);
    } catch {
      // The model context carries the public error shown above the composer.
      return;
    }
    if (keySelection === selection) void focusComposer();
  }

  // The Retry leaves while the inventory is read, so the focus it held comes back: to the Retry when the read fails
  // again, to the composer once it succeeds.
  // While it runs, the Retry alone decides where the focus goes: the composer turning usable in between (an uninstall
  // outcome no longer pending) must not take it first.
  let inventoryRetrying = false;

  async function retryInventory() {
    inventoryRetrying = true;
    try {
      if (deferredUninstall?.team_id === chatTeamId) await confirmUninstall(deferredUninstall);
      else await refreshTeamInventory().catch(() => {});
      await tick();
    } finally {
      inventoryRetrying = false;
    }
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    if ($teamContext.inventory === 'ready') void focusComposer();
    else inventoryRetry?.focus();
  }

  function retryBrain() {
    const teamId = chatTeamId;
    if (!teamId || brainSaving || !$commandsReady) return;
    // A configured selection only needs its save repeated; an unreadable catalog or selection is reloaded.
    const retry = brainProvider?.configured && brainModel
      ? configureModelContext(teamId, '')
      : loadModelContext(teamId);
    retry.catch(() => {});
  }

  async function focusStop(fromElement) {
    await tick();
    if (fromElement && document.activeElement !== fromElement) return;
    if (
      mounted && busy && !syncing && (!lifecycleWorking || installPlanWorking) &&
      !integrationChallenge && !humanChallenge
    ) {
      stopButton?.focus({ preventScroll: true });
    }
  }

  async function focusLifecycleTask(proposalId) {
    await tick();
    if (!mounted || !busy || !lifecycleWorking) return;
    document.getElementById(`assistant-lifecycle-${proposalId}`)?.focus({ preventScroll: true });
  }

  async function revealLatestExchange({ instant = false } = {}) {
    const request = ++scrollRequest;
    await tick();
    if (request !== scrollRequest || !turnsViewport) return;
    const latest = turnsViewport.querySelector('.exchange:last-of-type');
    if (!latest) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    latest.scrollIntoView({
      block: 'start',
      behavior: instant || reducedMotion ? 'auto' : 'smooth',
    });
  }

  function resetChallengeState() {
    integrationChallenge = undefined;
    humanChallenge = undefined;
    humanRejection = undefined;
    humanWorking = false;
    humanExpiredId = '';
    humanRelocalizing = '';
    integrationsDialogOpen = false;
    integrationWorking = '';
    storedInputWorking = '';
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    socketReady = false;
    syncing = false;
    expireSocketLifecycles();
    resetProgress();
    resetChallengeState();
    current?.close(1000, 'Team changed');
  }

  function integrationAssistantIds(incoming) {
    return incoming.requirements.map((requirement) => requirement.assistant_id);
  }

  // Only a settled inventory admits an Assistant's request at once; one being read again is checked when it arrives.
  function knownIntegrationAssistants(incoming) {
    const selected = new Set(inventoryReady ? $teamContext.activeAssistantIds : []);
    return integrationAssistantIds(incoming).every((id) => selected.has(id) || installedThisTurn(id));
  }

  function knownHumanAssistant(incoming) {
    const installed = new Set(
      inventoryReady ? $teamContext.installedAssistants.map((assistant) => assistant.assistant) : [],
    );
    return installed.has(incoming.assistant.id) || installedThisTurn(incoming.assistant.id);
  }

  // The cached Team inventory may be one being read again (after an install, for instance), so an Assistant it does
  // not admit is checked against the fresh authenticated Team inventory before the request is refused as a protocol
  // error.
  async function admitWithFreshInventory(active, expectedTeamId, assistantIds, accept) {
    const epoch = turnEpoch;
    let installed = new Set();
    try {
      const { installedAssistants } = await refreshTeamInventory();
      installed = new Set(installedAssistants.map((assistant) => assistant.assistant));
    } catch {
      installed = new Set();
    }
    if (socket !== active || chatTeamId !== expectedTeamId || epoch !== turnEpoch) return;
    if (assistantIds.every((id) => installed.has(id) || installedThisTurn(id))) accept();
    else failProtocol(active);
  }

  function acceptIntegrationChallenge(incoming) {
    expireSocketLifecycles();
    integrationChallenge = incoming;
    humanChallenge = undefined;
    humanRejection = undefined;
    humanWorking = false;
    humanExpiredId = '';
    integrationsDialogOpen = true;
    oauthFailedOnReturn = false;
    integrationsOpen = false;
    beginTurn();
    syncing = false;
    stopping = false;
    retainSegment();
    resetProgress();
  }

  function acceptHumanChallenge(incoming) {
    expireSocketLifecycles();
    const reconciledExpiry = humanExpiredId === incoming.challenge_id;
    humanExpiredId = '';
    if (reconciledExpiry) clearError();
    humanChallenge = incoming;
    humanRejection = undefined;
    humanWorking = false;
    integrationsOpen = false;
    beginTurn();
    syncing = false;
    stopping = false;
    retainSegment();
    resetProgress();
  }

  function connectSocket(expectedTeamId) {
    closeSocket();
    if (!mounted || !expectedTeamId || chatTeamId !== expectedTeamId) return;

    const expectedTeam = $teamContext.teams.find((entry) => entry.id === expectedTeamId);
    if (!expectedTeam) return;

    let active;
    try {
      active = openChatChannel(expectedTeamId, $locale);
    } catch {
      setError(copy.protocolError);
      return;
    }
    socket = active;

    // Attaching synchronizes the Team: Admin restores a pending request or answers that nothing is pending.
    active.onopen = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      socketReady = true;
      syncing = true;
      resetProgress();
      if (error === copy.disconnected || error === copy.connectionFailed) clearError();
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
          const challenge = incoming;
          if (knownIntegrationAssistants(challenge)) acceptIntegrationChallenge(challenge);
          else {
            void admitWithFreshInventory(active, expectedTeamId, integrationAssistantIds(challenge), () => (
              acceptIntegrationChallenge(challenge)
            ));
          }
          return;
        }
        if (incoming.type === 'human-required') {
          const challenge = incoming;
          if (humanRelocalizing) {
            // Admin opened the pending request in exactly the language the reconciling sync named.
            if (challenge.locale !== humanRelocalizing) throw new Error('unexpected human request language');
            humanRelocalizing = '';
          }
          if (knownHumanAssistant(challenge)) acceptHumanChallenge(challenge);
          else {
            void admitWithFreshInventory(active, expectedTeamId, [challenge.assistant.id], () => (
              acceptHumanChallenge(challenge)
            ));
          }
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
          if (syncing) beginTurn();
          progressSequence = incoming.seq;
          progressEvents.push(incoming);
          extendExecutionProjection(progressProjection, incoming);
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
          forgetSegments();
          resetProgress();
          clearTurnInstalled();
          if (humanRelocalizing) {
            // The request ended before it could be opened in the selected language.
            busy = false;
            stopping = false;
            resetChallengeState();
            setError(humanRequestCopy.expired);
            return;
          }
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
        if (incoming.type === 'assistant-install-plan') {
          if (!busy || syncing) throw new Error('unexpected Assistant install plan event');
          const receipt = turnReceipt();
          applyInstallPlanEvent(incoming, receipt);
          const restoreStoppedFocus = stopping && document.activeElement === document.body;
          stopping = false;
          resetProgress();
          if (restoreStoppedFocus) void focusStop();
          if (incoming.state === 'planned' || incoming.state === 'installing') {
            return;
          }
          if (incoming.state === 'installed') {
            if (incoming.continuation === 'dispatch') {
              const ids = turnInstalled.teamId === chatTeamId ? turnInstalled.ids : new Set();
              for (const assistant of incoming.assistants) ids.add(assistant.id);
              turnInstalled = { teamId: chatTeamId, ids };
            }
            void refreshTeamInventory().catch(() => undefined);
            if (incoming.continuation === 'none') {
              capabilityObjective = null;
              busy = false;
              clearError();
            }
            return;
          }
          busy = false;
          if (incoming.state === 'failed') {
            setError(
              incoming.code === ASSISTANT_LIMIT_REACHED ? words.limit : friendlyChatError(incoming.status, words),
              `HTTP ${incoming.status}`,
            );
          } else {
            clearError();
          }
          return;
        }
        if (incoming.type === 'assistant-guidance') {
          if (!busy || syncing) throw new Error('unexpected Assistant guidance event');
          capabilityObjective = null;
          turns = [...turns, {
            renderKey: nextRenderKey++,
            role: 'assistant',
            text: escapeMarkdownText(incoming.reply),
            author: incoming.team_name,
            receipt: turnReceipt(),
          }];
          busy = false;
          stopping = false;
          resetProgress();
          clearError();
          void revealLatestExchange();
          return;
        }
        if (incoming.type === 'assistant-uninstall') {
          if (!busy || syncing) throw new Error('unexpected Assistant lifecycle event');
          capabilityObjective = null;
          const receipt = turnReceipt();
          // A Stop may cross a proposal or the uninstall it approved; Admin answers that Stop with nothing, so the
          // lifecycle event is applied as it is and ends the stop.
          const terminal = applyLifecycleEvent(incoming, receipt);
          stopping = false;
          resetProgress();
          if (!terminal) {
            void focusLifecycleTask(incoming.proposal_id);
            return;
          }
          busy = false;
          clearError();
          if (incoming.state === 'uninstalled') void confirmUninstall(incoming);
          return;
        }
        if (!busy && !stopping && !syncing) throw new Error('unexpected terminal frame');
      } catch {
        failProtocol(active);
        return;
      }

      const receipt = turnReceipt();
      expireSocketLifecycles();
      busy = false;
      syncing = false;
      stopping = false;
      resetChallengeState();
      clearTurnInstalled();
      if (incoming.type === 'done') {
        turns = [...turns, {
          renderKey: nextRenderKey++,
          role: 'assistant',
          text: incoming.reply,
          author: incoming.team_name,
          receipt,
          ...replyFields(incoming),
        }];
        clearError();
      } else if (incoming.type === 'stopped') {
        clearError();
      } else {
        const projectedError = projectedChatError(incoming.status, incoming.detail, words);
        setError(projectedError.message, projectedError.detail);
      }
      resetProgress();
    };
    // The session socket dropped: nothing of the turn stays live, and the channel attaches again when it reopens. The
    // shell alone says that Admin reconnects; only an attach Admin refused while the socket stays open is the chat's own.
    active.onclose = (event) => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      resetConnection();
      socket = active;
      if (event?.code === 1011 && $adminSocket.phase === 'open') setError(copy.connectionFailed);
    };
  }

  function activateTeam(nextTeamId) {
    chatOwnsFocus = true;
    forgetSegments();
    if (messageFiles.teamId !== nextTeamId) messageFiles.clear();
    closeSocket();
    clearTurnInstalled();
    clearLifecycleIconCaptures();
    capabilityObjective = null;
    liveAnswers = new Map();
    socketTeamId = nextTeamId;
    stopping = false;
    lifecycleOutcomePending = null;
    deferredUninstall = null;
    if (nextTeamId && draftTeamId && draftTeamId !== nextTeamId) draft = '';
    if (nextTeamId) draftTeamId = nextTeamId;
    promptHistoryIndex = -1;
    turns = [];
    busy = false;
    historyBefore = null;
    historyWorking = false;
    olderHistoryArmed = false;
    olderHistoryFailed = false;
    historyLoading = Boolean(nextTeamId);
    const generation = ++historyGeneration;
    resetProgress();
    scrollRequest += 1;
    integrationsOpen = false;
    resetChallengeState();
    clearError();
    watchTeam(nextTeamId, generation);
  }

  function closeIntegrations() {
    integrationsOpen = false;
    queueMicrotask(() => integrationsButton?.focus());
  }

  function closeIntegrationsDialog() {
    integrationsDialogOpen = false;
  }

  // While the drawer is open it follows the shown Team's Integrations and Stored Inputs; closing it forgets them.
  $effect(() => {
    const teamId = integrationsOpen ? chatTeamId : '';
    if (!teamId) {
      integrationSources = null;
      integrationsState = null;
      storedInputsState = null;
      return undefined;
    }
    const sources = teamIntegrations(teamId);
    integrationSources = sources;
    const stops = [
      sources.integrations.subscribe((state) => { integrationsState = { teamId, ...state }; }),
      sources.storedInputs.subscribe((state) => { storedInputsState = { teamId, ...state }; }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  });

  // What the drawer shows: both read for the shown Team, and every Assistant they name in the Team's inventory. One that
  // names an Assistant the inventory does not list yet waits for the inventory's next read.
  let integrationView = $derived.by(() => {
    const teamId = chatTeamId;
    const listed = integrationsState?.teamId === teamId ? integrationsState.value : null;
    const stored = storedInputsState?.teamId === teamId ? storedInputsState.value : null;
    if (!listed || !stored) return { ready: false, integrations: [], storedInputs: [], unknown: false };
    const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
    const unknown = listed.some((integration) => !installed.has(integration.assistant_id)) ||
      stored.some((item) => !installed.has(item.assistant_id));
    return unknown
      ? { ready: false, integrations: [], storedInputs: [], unknown: true }
      : { ready: true, integrations: listed, storedInputs: stored, unknown: false };
  });
  let integrations = $derived(integrationView.integrations);
  let storedInputs = $derived(integrationView.storedInputs);
  let integrationsReady = $derived(integrationView.ready);

  // An Assistant the Integrations name but the inventory does not: the inventory is read again, and an inventory read
  // that still does not list it says the drawer cannot be shown.
  let inventoryChecked = '';
  $effect(() => {
    if (!integrationView.unknown) {
      inventoryChecked = '';
      return;
    }
    const teamId = chatTeamId;
    if (inventoryChecked === teamId) return;
    inventoryChecked = teamId;
    void refreshTeamInventory().catch(() => {}).then(() => {
      if (chatTeamId === teamId && integrationView.unknown) setError(integrationsCopy.inventoryFailed);
    });
  });

  // A refused read of either is said once; an outage is retried on its own and is the shell's to say.
  $effect(() => {
    const refused = [integrationsState, storedInputsState].find((state) => state?.status === 'error');
    if (refused && refused.teamId === chatTeamId) {
      setError(integrationsCopy.inventoryFailed, refused.error?.message ?? integrationsCopy.inventoryFailed);
    }
  });

  async function clearStoredInput(item) {
    const teamId = chatTeamId;
    const key = `${item?.assistant_id}/${item?.stored_input_id}`;
    if (
      !teamId ||
      storedInputWorking ||
      !storedInputs.some((candidate) => (
        candidate.assistant_id === item?.assistant_id &&
        candidate.stored_input_id === item?.stored_input_id &&
        candidate.status === 'stored'
      ))
    ) throw new Error(integrationsCopy.storedInputClearFailed);
    storedInputWorking = key;
    const sources = integrationSources;
    try {
      await clearAssistantStoredInput(teamId, item.assistant_id, item.stored_input_id);
      // What the drawer shows next is the Stored Inputs read after Admin announces the change, never this answer.
      if (sources?.teamId === teamId) await sources.storedInputs.refresh();
    } catch (reason) {
      if (chatTeamId !== teamId) return;
      setError(
        integrationsCopy.storedInputClearFailed,
        failureDetail(reason, integrationsCopy.storedInputClearFailed),
      );
      throw reason;
    } finally {
      if (chatTeamId === teamId) storedInputWorking = '';
    }
  }

  // A failure's detail: a change Admin never confirmed before it disconnected may or may not have happened.
  function failureDetail(reason, fallback) {
    if (outcomeUnknown(reason)) return $t('shell.outcomeUnknown');
    return reason instanceof Error ? reason.message : fallback;
  }

  function toggleIntegrations() {
    integrationsOpen = !integrationsOpen;
  }

  async function authorizeIntegration(challengeId, requirement) {
    const teamId = chatTeamId;
    if (
      !teamId ||
      integrationWorking ||
      !integrationChallenge ||
      integrationChallenge.challenge_id !== challengeId ||
      !integrationChallenge.requirements.some((candidate) => (
        candidate.assistant_id === requirement?.assistant_id &&
        candidate.integration_id === requirement?.integration_id
      ))
    ) throw new Error(integrationsCopy.authorizationFailed);
    const requirementKey = `${requirement.assistant_id}/${requirement.integration_id}`;
    integrationWorking = requirementKey;
    flushSync();
    const expectedCompletionMode = $sessionContext.oauthCompletionMode;
    // Code completion needs a separate tab opened while this click still owns browser activation.
    const authorizationWindow = expectedCompletionMode === 'code'
      ? window.open('about:blank', '_blank')
      : null;
    if (authorizationWindow) authorizationWindow.opener = null;
    let authorizationStarted = false;
    try {
      const authorization = await authorizeAssistantIntegration(
        teamId,
        challengeId,
        requirement.assistant_id,
        requirement.integration_id,
      );
      authorizationStarted = true;
      if (chatTeamId !== teamId || integrationChallenge?.challenge_id !== challengeId) {
        throw new Error(integrationsCopy.authorizationFailed);
      }
      if (authorization.completion_mode !== expectedCompletionMode) {
        throw new Error(integrationsCopy.authorizationFailed);
      }
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
          await cancelAssistantIntegrationAuthorization(teamId, challengeId);
        } catch {
          // Bounded server-side expiry remains the fail-closed fallback.
        }
      }
      if (chatTeamId === teamId) {
        setError(
          integrationsCopy.authorizationFailed,
          failureDetail(reason, integrationsCopy.authorizationFailed),
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
      await completeAssistantIntegration(teamId, challengeId, completionCode);
      if (chatTeamId !== teamId || integrationChallenge?.challenge_id !== challengeId) {
        throw new Error(integrationsCopy.completionFailed);
      }
      location.assign('/chat');
    } catch (reason) {
      if (chatTeamId === teamId) {
        integrationWorking = '';
        setError(
          integrationsCopy.completionFailed,
          failureDetail(reason, integrationsCopy.completionFailed),
        );
      }
      throw reason;
    }
  }

  async function cancelIntegrationAuthorization(challengeId) {
    const teamId = chatTeamId;
    if (!teamId || integrationChallenge?.challenge_id !== challengeId) return;
    try {
      await cancelAssistantIntegrationAuthorization(teamId, challengeId);
    } catch {
      // Expiry remains bounded and a new authorization uses a fresh binding.
    } finally {
      if (chatTeamId === teamId) integrationWorking = '';
    }
  }

  function attachmentRefusalText(reason, name) {
    return $t(`attachments.errors.${reason}`, { name });
  }

  function removeAttachment(key) {
    messageFiles.remove(key);
    composerInput?.focus();
  }

  function cancelAttachmentUploads() {
    messageFiles.cancelUploads();
    composerInput?.focus();
  }

  function addAttachments(files) {
    const teamId = chatTeamId;
    if (!teamId || attachmentsUnavailable) return;
    void messageFiles.add(files, teamId);
  }

  function chooseAttachments() {
    attachmentInput?.click();
  }

  function attachmentsChosen(event) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (files.length) addAttachments(files);
  }

  // Pasted files join the message; pasted text still lands in the draft as usual.
  function pasteAttachments(event) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    addAttachments(files);
  }

  function carriesFiles(event) {
    return [...(event.dataTransfer?.types ?? [])].includes('Files');
  }

  function dragAttachments(event) {
    if (!carriesFiles(event) || attachmentsUnavailable) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    messageFiles.dragging = true;
  }

  function leaveAttachments(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) messageFiles.dragging = false;
  }

  // A file drag the composer did not take (dropped elsewhere, or while files cannot join a message) is refused here;
  // left to the browser, it would open the file in place of Admin.
  function refuseFileDrop(event) {
    if (!carriesFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  }

  function dropAttachments(event) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    messageFiles.dragging = false;
    if (attachmentsUnavailable) return;
    const files = [...(event.dataTransfer.files ?? [])];
    if (files.length) addAttachments(files);
  }

  function submitMessage(message, {
    focusActiveTurn = true,
    projectUserTurn = true,
    useCapabilityObjective = true,
    attached = [],
  } = {}) {
    const teamId = $teamContext.selectedTeamId;
    const normalized = message.trim();
    if (
      composerBusy ||
      brainSaving ||
      !$modelContext.ready ||
      !inventoryReady ||
      !teamId ||
      chatTeamId !== teamId ||
      !normalized ||
      !socketReady ||
      !socket
    ) return false;
    let frame;
    let resumedObjective = '';
    clearTurnInstalled();
    const assistantIds = [...$teamContext.activeAssistantIds];
    const files = attached.map((item) => item.id);
    // A message with attachments never resumes an objective nor becomes one: installs need an attachment-free request.
    const continuation = useCapabilityObjective && files.length === 0 && capabilityContinuation(normalized);
    const sameAssistantIds = continuation && capabilityObjective
      ? assistantIds.length === capabilityObjective.assistant_ids.length &&
        assistantIds.every((assistantId, index) => (
          assistantId === capabilityObjective.assistant_ids[index]
        ))
      : false;
    const resumable = continuation && sameAssistantIds ? capabilityObjective : null;
    if (continuation && capabilityObjective && !sameAssistantIds) capabilityObjective = null;
    try {
      const currentTurn = {
        message: normalized,
        files,
        assistant_ids: assistantIds,
      };
      if (resumable) {
        frame = createResumeTaskFrame(teamId, currentTurn, resumable, $locale);
        resumedObjective = resumable.message;
        capabilityObjective = null;
      } else {
        frame = createChatFrame(teamId, currentTurn, $locale);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      return false;
    }
    beginTurn();
    forgetSegments();
    resetProgress();
    clearError();
    if (projectUserTurn) {
      turns = [...turns, {
        renderKey: nextRenderKey++,
        role: 'user',
        text: normalized,
        ...(resumedObjective ? { resumedObjective } : {}),
        ...(files.length
          ? { files: attached.map(({ key, name, size, kind, note }) => ({ key, name, size, kind, note })) }
          : {}),
      }];
      void revealLatestExchange();
    }
    try {
      socket.send(JSON.stringify(frame));
      if (files.length) {
        capabilityObjective = null;
      } else if (useCapabilityObjective && !continuation) {
        capabilityObjective = {
          message: normalized,
          files: [],
          assistant_ids: assistantIds,
        };
      }
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

  function proposedLifecycle(proposalId) {
    return turns.some((turn) => turn.lifecycle?.proposal_id === proposalId && turn.lifecycle.state === 'proposed');
  }

  async function submitLifecycleDecision(decision) {
    if (lifecycleDecisionPending) return false;
    lifecycleDecisionPending = true;
    try {
      const pendingUninstall = turns.findLast((turn) => (
        turn.lifecycle?.state === 'proposed'
      ))?.lifecycle;
      if (decision === 'yes' && pendingUninstall && chatTeamId) {
        const teamId = chatTeamId;
        const active = socket;
        await captureUninstallIcon(
          pendingUninstall.proposal_id,
          pendingUninstall.assistant.id,
          teamId,
        );
        // The approval answers only the proposal it was given for, on the connection that proposed it: a Team change,
        // a reconnect, or an expiry while the icon was captured leaves nothing to approve.
        if (
          chatTeamId !== teamId ||
          socket !== active ||
          !proposedLifecycle(pendingUninstall.proposal_id)
        ) return false;
      }
      return submitMessage(decision, {
        focusActiveTurn: false,
        projectUserTurn: false,
        useCapabilityObjective: false,
      });
    } finally {
      lifecycleDecisionPending = false;
    }
  }

  function send(event) {
    event.preventDefault();
    if (messageFiles.pending) return;
    const attached = messageFiles.attached(chatTeamId);
    if (!questionOpen && submitMessage(draft, { attached })) {
      draft = '';
      promptHistoryIndex = -1;
      messageFiles.sent();
    }
  }

  function sentPrompts() {
    return turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
  }

  function navigatePromptHistory(event) {
    const step = promptHistoryStep(event, { prompts: sentPrompts(), index: promptHistoryIndex, draft });
    promptHistoryIndex = step.index;
    if (!step.handled) return false;
    draft = step.draft;
    event.preventDefault();
    return true;
  }

  function handleComposerKeydown(event) {
    if (navigatePromptHistory(event)) return;
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) promptHistoryIndex = -1;
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
    if (!teamId || !challenge || humanUnanswerable || humanWorking || !socketReady || !socket) return;
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
      socket.send(JSON.stringify(createSyncFrame(chatTeamId, $locale)));
    } catch {
      syncing = false;
      socket.close();
    }
  }

  // A pending or restored request in another language than the one selected is replaced by a fresh challenge in the
  // selected language before it can be answered. A reply that arrives after yet another switch is reconciled again.
  function relocalizeHumanRequest(selected) {
    humanRelocalizing = selected;
    syncing = true;
    try {
      socket.send(JSON.stringify(createSyncFrame(chatTeamId, selected)));
    } catch {
      humanRelocalizing = '';
      syncing = false;
      socket.close();
    }
  }

  $effect(() => {
    const selected = $locale;
    if (!humanStale || humanWorking || humanRelocalizing || syncing || !socketReady || !socket) return;
    if (humanChallenge.challenge_id === humanExpiredId) return;
    relocalizeHumanRequest(selected);
  });

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
    if (mounted && chatTeamId && $modelContext.ready && !composerBusy && !integrationsOpen) void focusComposer();
  });

  // A fresh observer after every load reports whether the top is still in view, so a short page keeps filling.
  $effect(() => {
    const sentinel = historySentinel;
    const root = turnsViewport;
    if (!olderHistoryArmed || olderHistoryFailed || historyWorking || !sentinel || !root) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadOlderHistory();
    }, { root, rootMargin: '240px 0px 0px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  // An unsent key belongs to one Team and provider; any change discards it and focuses the new field.
  $effect(() => {
    void keySelection;
    providerKey = '';
  });

  // The conversation is inert while its history hydrates, and the whole view while the boot screen covers it, so the key
  // field takes focus once it is usable.
  $effect(() => {
    void keySelection;
    if (!mounted || $booting || !keyRequired || historyHydrating || integrationsOpen) return;
    void tick().then(() => {
      if (document.querySelector('dialog[open], :popover-open')) return;
      document.getElementById('chat-provider-key')?.focus({ preventScroll: true });
    });
  });

  onMount(() => {
    mounted = true;
    document.addEventListener('focusin', trackFocus);
    oauthFailedOnReturn = oauthReturnFailure(location.href);
    const initialTeamId = chatTeamId;
    if (initialTeamId !== socketTeamId) activateTeam(initialTeamId);
    else historyLoading = false;
    if (oauthFailedOnReturn) {
      busy = false;
      resetProgress();
      history.replaceState(history.state, '', '/chat');
      setError(integrationsCopy.authorizationFailed);
    }
    return () => {
      document.removeEventListener('focusin', trackFocus);
      mounted = false;
      historyGeneration += 1;
      stopTeamTopics();
      closeSocket();
      clearLifecycleIconCaptures();
      // Files belong to the message being written here; leaving the chat stops their uploads.
      messageFiles.clear();
    };
  });
</script>

<svelte:head><title>{teamName} — Shimpz Admin</title></svelte:head>
<svelte:window ondragover={refuseFileDrop} ondrop={refuseFileDrop} />

<div class="chat-route" bind:this={chatRoute}>
  <h1 class="sr-only">{copy.title}</h1>
  {#if activeTeam}
    {#if chatTeamId}
      <div class="chat-workspace">
        <section
          class="conversation"
          class:empty-conversation={turns.length === 0}
          aria-label={teamName}
          aria-busy={composerBusy && !integrationChallenge && !humanChallenge}
          inert={historyHydrating}
        >
        <p class="live-status sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
        {#if historyBefore && !olderHistoryFailed}
          <p id="chat-history-hint" class="sr-only">{copy.olderHint}</p>
        {/if}
        <ScrollArea
          class="turns"
          bind:element={turnsViewport}
          aria-describedby={historyBefore && !olderHistoryFailed ? 'chat-history-hint' : undefined}
        >
          {#if historyBefore}
            <div class="history-older" bind:this={historySentinel}>
              {#if olderHistoryFailed}
                <Button
                  variant="ghost"
                  size="compact"
                  type="button"
                  onclick={retryOlderHistory}
                  disabled={historyWorking}
                >
                  {copy.olderMessages}
                </Button>
              {:else if historyWorking}
                <p class="history-older-status" role="status">{copy.olderLoading}</p>
              {/if}
            </div>
          {/if}
          <!-- The turn in flight's live progress, shown after its exchange. -->
          {#snippet liveThinking()}
            <ShimpzThinking
              label={thinking}
              steps={progressProjection.steps}
              currentIndex={progressProjection.currentIndex}
              elapsedText={copy.elapsed}
              stagesText={copy.progressStages}
              progressLabels={copy.progress}
              {teamName}
              {assistantNames}
              startedAt={turnStartedAt}
            />
          {/snippet}
          {#each exchanges as exchange, index (exchange.key)}
            {@const opensDay = days[index] !== days[index - 1]}
            {#if opensDay}
              <ChatDay day={days[index]} {today} locale={$locale} />
            {/if}
            <!-- The last exchange shows the turn in flight, also after an install that continues the requested task. -->
            <Exchange
              {exchange}
              {words}
              {instantOf}
              teamId={chatTeamId}
              {selectedTeamId}
              {assistantNames}
              sentAnswer={clarificationAnswers.sent.get(index) ?? null}
              givenAnswer={clarificationAnswers.given.get(index) ?? null}
              answerDisabled={sendUnavailable}
              joinAbove={!opensDay && !exchange.user && Boolean(exchanges[index - 1]?.assistant?.routineRun)}
              joinBelow={days[index + 1] === days[index] && !exchanges[index + 1]?.user &&
                Boolean(exchanges[index + 1]?.assistant?.routineRun)}
              lifecycleDisabled={lifecycleDecisionDisabled}
              onanswer={(answer) => answerClarification(exchange, answer)}
              ondecide={submitLifecycleDecision}
              thinking={index === exchanges.length - 1 && busy && !integrationChallenge && !humanChallenge &&
                (exchange.assistant ? exchange.assistant.installPlan?.state === 'installed' : !lifecycleWorking)
                ? liveThinking
                : undefined}
            />
          {/each}
        </ScrollArea>

        {#if visibleError}
          <Notice class="chat-error" variant="error">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
            {#if inventoryFailed}
              <Button
                bind:element={inventoryRetry}
                variant="secondary"
                size="compact"
                type="button"
                onclick={retryInventory}
                disabled={$teamContext.phase === 'loading'}
              >
                {$t('teamSidebar.retry')}
              </Button>
            {/if}
          </Notice>
        {/if}

          <Composer
            files={messageFiles}
            bind:draft
            bind:providerKey
            bind:composerInput
            bind:attachmentInput
            bind:integrationsButton
            bind:stopButton
            {keyRequired}
            {brainUnavailable}
            {brainSaving}
            {brainProvider}
            {brainModel}
            {placeholder}
            {questionOpen}
            {composerBusy}
            {attachmentsUnavailable}
            {menusBusy}
            {integrationsOpen}
            integrationsDisabled={$teamContext.installedAssistants.length === 0 && !integrationChallenge}
            stopShown={busy && !syncing && (!lifecycleWorking || installPlanWorking)}
            {stopping}
            {sendUnavailable}
            {socketReady}
            onsubmit={keyRequired ? saveProviderKey : send}
            ondrag={dragAttachments}
            ondragleave={leaveAttachments}
            ondrop={dropAttachments}
            onretrybrain={retryBrain}
            onkeydown={handleComposerKeydown}
            onpaste={pasteAttachments}
            oncancelfiles={cancelAttachmentUploads}
            onremovefile={removeAttachment}
            onchoose={chooseAttachments}
            onfileschosen={attachmentsChosen}
            ontoggleintegrations={toggleIntegrations}
            onstop={stop}
          />
        </section>
        <AssistantIntegrationsDrawer
          open={integrationsOpen}
          teamId={chatTeamId}
          {integrations}
          {storedInputs}
          {assistantNames}
          synced={integrationsReady}
          pending={integrationChallenge}
          working={integrationWorking || storedInputWorking}
          onclose={closeIntegrations}
          onconnect={authorizeIntegration}
          onclearstoredinput={clearStoredInput}
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
          working={humanWorking || humanUnanswerable}
          onrespond={respondToHuman}
          onretry={retryHumanAuthentication}
          onexpire={expireHumanRequest}
        />
        {#if historyHydrating}
          <section class="history-loading" aria-live="polite">
            <EmptyState title={copy.loading} />
          </section>
        {/if}
      </div>
    {:else}
      <section class="empty-state" aria-live="polite">
        <EmptyState title={copy.loading} />
      </section>
    {/if}
  {:else}
    <section class="empty-state" aria-live="polite">
      <!-- "No Team yet" only once the Team list is known to be empty; until then it is loading, or why it failed. -->
      <EmptyState
        title={teamsKnownEmpty ? copy.emptyTeams : contextFailed ? copy.loadFailed : copy.loading}
      >
        {#if visibleError && (visibleError !== copy.loadFailed || visibleErrorDetail)}
          <Notice class="chat-empty-error" variant="error">
            {#if visibleError !== copy.loadFailed}<strong>{visibleError}</strong>{/if}
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
          </Notice>
        {/if}
      </EmptyState>
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

  .history-loading {
    position: absolute;
    z-index: 4;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--surface-1);
  }

  .conversation {
    --chat-rail-gutter: var(--gap-group);
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

  :global(.turns) {
    position: relative;
    display: block;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* A day header sticks flush with the top edge, over this padding; an exchange scrolled to the top stays below it. */
    --chat-day-inset: calc(-1 * var(--gap-group));
    /* Not rhythm: clears the sticky day header's own height. */
    scroll-padding-block-start: 2rem;
    padding-block: var(--gap-group);
    padding-inline: max(
      var(--chat-rail-gutter),
      calc((100% - var(--chat-rail-width)) / 2)
    );
  }

  .history-older {
    display: flex;
    min-height: 1px;
    justify-content: center;
  }

  .history-older-status {
    margin: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .empty-conversation :global(.turns) {
    display: none;
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

  /* The time sits right after its author's name instead of across the message. */
  :global(.turns [data-slot="message-header"]) {
    justify-content: flex-start;
    gap: 1ch; /* one word space, the same as between "às" and the time */
  }
  :global(.assistant-lifecycle-task) {
    margin-block-start: var(--gap-group);
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-detail-copy) {
    display: block;
  }

  /* The Assistant install and uninstall cards run their details on from the description, without a divider. */
  :global(.shimpz-chat-task.assistant-lifecycle-task [data-slot="chat-task-details"]) {
    border-top: 0;
    padding-top: 0;
  }
  /* The chat's own notices only: other components' `.error` text keeps its own layout. */
  .conversation :global(.chat-error),
  .empty-state :global(.chat-empty-error) {
    display: grid;
    gap: var(--gap-item);
    font-size: 0.72rem;
  }

  .conversation :global(.chat-error) {
    grid-row: 2;
    justify-items: start;
    width: min(
      calc(100% - (2 * var(--chat-rail-gutter))),
      var(--chat-rail-width)
    );
    max-height: min(8rem, 24dvh);
    margin: 0;
    justify-self: center;
    overflow-y: auto;
  }

  .conversation :global(.chat-error strong),
  .empty-state :global(.chat-empty-error strong) {
    font-weight: 600;
  }

  .conversation :global(.chat-error code),
  .empty-state :global(.chat-empty-error code) {
    color: var(--text-faint);
    font-size: 0.6rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: normal;
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

  @media (max-width: 640px) {
    :global(.turns .shimpz-message--user) { max-width: 92%; }
  }
</style>
