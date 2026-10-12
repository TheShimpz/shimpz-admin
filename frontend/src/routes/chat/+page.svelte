<script>
  import { flushSync, onMount, tick } from 'svelte';
  import { AssistantIcon, Button, ChatTask, EmptyState, FileInput, Message, Notice, ScrollArea, TextAreaField, TextField, Toolbar } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '#lib/AssistantHumanRequestDialog.svelte';
  import AttachmentChip from '#lib/AttachmentChip.svelte';
  import {
    AttachmentUploadError,
    attachmentKind,
    attachmentReadability,
    attachmentRefusal,
    MAX_ATTACHMENTS,
    uploadTeamFile,
  } from '#lib/attachments.js';
  import ComposerAttachments from '#lib/ComposerAttachments.svelte';
  import RestrictedActionsNote from '#lib/RestrictedActionsNote.svelte';
  import DialogAction from '#lib/DialogAction.svelte';
  import AssistantIntegrationsDialog from '#lib/AssistantIntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '#lib/AssistantIntegrationsDrawer.svelte';
  import { historyBoundary, historySince, listChatHistory } from '#lib/chatHistory.js';
  import BrainMenu from '#lib/BrainMenu.svelte';
  import FastRoutingMenu from '#lib/FastRoutingMenu.svelte';
  import ClarificationCard from '#lib/ClarificationCard.svelte';
  import { clarifiedRequest, matchClarificationAnswers } from '#lib/clarification.js';
  import { promptHistoryStep } from '#lib/promptHistory.js';
  import { formatTaskUsage, formatTaskUsageDetail, taskUsageSummary } from '#lib/taskUsage.js';
  import RoutineProposal from '#lib/RoutineProposal.svelte';
  import RoutineQuestion from '#lib/RoutineQuestion.svelte';
  import RoutineRunEntry from '#lib/RoutineRunEntry.svelte';
  import ChatDay from '#lib/ChatDay.svelte';
  import { calendarDay, clockTime, exchangeDays, instantValue, turnInstants, untilNextDay } from '#lib/chatDays.js';
  import { newerRoutineEntries, questionWords, refusalWords } from '#lib/routine.js';
  import { loadTeamRoutines } from '#lib/routineContext.js';
  import { adminSocket, call, commandsReady, openChatChannel, outcomeUnknown, watchTopic } from '#lib/adminSocket.js';
  import ExecutionReceipt from '#lib/ExecutionReceipt.svelte';
  import {
    createExecutionProjection,
    extendExecutionProjection,
    localizedEventLabel,
    receiptSteps,
  } from '#lib/executionProgress.js';
  import Markdown from '#lib/Markdown.svelte';
  import { escapeMarkdownText } from '#lib/markdown.js';
  import { locale, t } from '#lib/i18n.js';
  import { CLARIFICATION_LABELS } from '#lib/clarificationLabels.js';
  import { routineQuestionMessages } from '#lib/routineQuestionMessages.js';
  import { configureModelContext, loadModelContext, modelContext } from '#lib/modelContext.js';
  import { sessionContext } from '#lib/sessionContext.js';
  import ShimpzThinking from '#lib/ShimpzThinking.svelte';
  import { MAX_TEAM_ASSISTANTS, refreshTeamInventory, teamContext } from '#lib/teamContext.js';
  import { ASSISTANT_LIMIT_REACHED } from '#lib/validate.js';
  import {
    authorizeAssistantIntegration,
    capabilityContinuation,
    cancelAssistantIntegrationAuthorization,
    clearAssistantStoredInput,
    completeAssistantIntegration,
    createChatFrame,
    createHumanResponseFrame,
    createResumeTaskFrame,
    createStopFrame,
    createSyncFrame,
    listAssistantIntegrations,
    listAssistantStoredInputs,
    parseChatEvent,
    oauthReturnFailure,
  } from '#lib/localChat.js';


  let mounted = $state(false);
  let socketTeamId = $state('');
  let draft = $state('');
  let draftTeamId = '';
  // The next message's files (ADR-0093), uploaded one at a time to the Team they were selected for. A Team change
  // discards them, and an upload that answers for an earlier Team is ignored.
  let attachments = $state([]);
  let attachmentTeamId = '';
  let attachmentError = $state('');
  let attachmentInput = $state();
  let attachmentDragging = $state(false);
  let attachmentFinished = $state(0);
  let attachmentUpload = null;
  let attachmentPumping = false;
  let nextAttachmentKey = 0;
  // Selections whose files are still being read; each blocks sending until its files join the message or are refused.
  let attachmentInspections = $state([]);
  let nextAttachmentInspection = 0;
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
  let integrations = $state([]);
  let storedInputs = $state([]);
  let integrationsReady = $state(false);
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
  // The mark of every newest history row this conversation has read, so a refresh reads only the rows written since.
  let historySeen = new Set();

  let copy = $derived($t('chatPage'));
  let storeCopy = $derived($t('store'));
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
  let attachCopy = $derived($t('attachments'));
  let attachmentsPending = $derived(
    attachmentInspections.length > 0 || attachments.some((item) => item.state !== 'ready'),
  );
  let attachmentProgress = $derived.by(() => {
    const pending = attachments.filter((item) => item.state !== 'ready').length;
    return pending ? { current: attachmentFinished + 1, total: attachmentFinished + pending } : null;
  });
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
  let keyCopy = $derived($t('providerSetup'));
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

  function groupExchanges(values) {
    const grouped = [];
    for (const turn of values) {
      if (turn.role === 'user') {
        grouped.push({ key: turn.renderKey, user: turn, assistant: null });
      } else if (grouped.length > 0 && grouped.at(-1).assistant === null) {
        grouped.at(-1).assistant = turn;
      } else {
        grouped.push({ key: turn.renderKey, user: null, assistant: turn });
      }
    }
    return grouped;
  }

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

  // A reply's usage as its receipt shows it (ADR-0082): with a receipt, the duration shown is what its rows add up to,
  // which is Team's duration unless steps measured on another clock overrun it.
  function shownUsage(turn) {
    const steps = receiptSteps(turn.receipt ?? [], turn.usage?.durationMs);
    if (!turn.usage || steps.length === 0) return { usage: turn.usage, receipt: false };
    const total = steps.reduce((sum, step) => sum + (Number.isSafeInteger(step.elapsed_ms) ? step.elapsed_ms : 0), 0);
    return { usage: { ...turn.usage, seconds: Math.max(total, turn.usage.durationMs) / 1000 }, receipt: true };
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

  function lifecycleProposalReply(assistant) {
    return $t('chatPage.uninstall.proposalReply', {
      assistant: escapeMarkdownText(assistant.name),
    });
  }

  function lifecycleVisualState(state) {
    if (state === 'proposed') return 'pending';
    if (state === 'working') return 'working';
    if (state === 'uninstalled') return 'complete';
    if (state === 'cancelled' || state === 'expired') return 'cancelled';
    return 'failed';
  }

  function lifecycleStatus(lifecycle) {
    const lifecycleMessages = copy.uninstall;
    if (lifecycle.state === 'proposed') return lifecycleMessages.pending;
    if (lifecycle.state === 'working') return lifecycleMessages.working;
    if (lifecycle.state === 'uninstalled') {
      return lifecycle.uninstalled ? lifecycleMessages.complete : lifecycleMessages.absent;
    }
    if (lifecycle.state === 'cancelled') return lifecycleMessages.cancelled;
    if (lifecycle.state === 'expired') return lifecycleMessages.expired;
    if (lifecycle.state === 'unknown') return lifecycleMessages.unknown ?? copy.disconnected;
    return lifecycleMessages.failed;
  }

  function lifecycleOutcome(lifecycle, team) {
    if (lifecycle.state !== 'uninstalled') return '';
    const outcomeKey = lifecycle.uninstalled ? 'uninstalledReply' : 'absentReply';
    const outcome = $t(`chatPage.uninstall.${outcomeKey}`, {
      assistant: escapeMarkdownText(lifecycle.assistant.name),
      version: escapeMarkdownText(lifecycle.assistant.version),
      team: escapeMarkdownText(team),
    });
    return `${outcome}\n\n${copy.uninstall.reinstall}`;
  }

  function lifecycleIconSource(lifecycle) {
    const assistantId = encodeURIComponent(lifecycle.assistant.id);
    if (lifecycle.state === 'uninstalled') return lifecycle.iconSnapshot;
    if (!chatTeamId) return undefined;
    return `/api/teams/${encodeURIComponent(chatTeamId)}/assistants/${assistantId}/icon`;
  }

  function installPlanVisualState(status) {
    if (status === 'pending') return 'pending';
    if (status === 'installing') return 'working';
    if (status === 'installed') return 'complete';
    return 'failed';
  }

  function installPlanStatus(status, outcome) {
    if (status === 'pending') return copy.install.pending;
    if (status === 'installing') return copy.install.working;
    if (status === 'installed') {
      return outcome === 'already-installed' ? copy.install.already : copy.install.complete;
    }
    if (status === 'unknown') return copy.disconnected;
    return copy.install.failed;
  }

  function installPlanIconSource(assistant) {
    const assistantId = encodeURIComponent(assistant.id);
    if (assistant.status === 'installed' && chatTeamId) {
      return `/api/teams/${encodeURIComponent(chatTeamId)}/assistants/${assistantId}/icon`;
    }
    if (assistant.provenance === 'local') return undefined;
    return `/api/assistants/${assistantId}/catalog-icon`;
  }

  // A Local snapshot has no catalog icon; its icon appears only once installed, so a settled plan without one failed.
  function installPlanIconStatus(assistant) {
    return assistant.status === 'pending' || assistant.status === 'installing' ? 'loading' : 'failed';
  }

  function installPlanTurnIndex(planId) {
    return turns.findLastIndex((turn) => turn.installPlan?.plan_id === planId);
  }

  function historyTurn(entry, author) {
    // Every stored row keeps the time Admin wrote it, which dates its day in the transcript.
    const stored = { renderKey: nextRenderKey++, historyId: entry.id, createdAt: entry.createdAt };
    if (entry.kind === 'message') {
      return {
        ...stored,
        role: entry.role,
        text: entry.text,
        ...(entry.role === 'assistant' ? { author: entry.author } : {}),
        ...(entry.clarification ? { clarification: entry.clarification } : {}),
        ...(entry.usage ? { usage: taskUsageSummary(entry.usage) } : {}),
        ...(entry.restricted_actions ? { restricted: entry.restricted_actions } : {}),
        ...(entry.routine_proposal ? { routineProposal: entry.routine_proposal } : {}),
        ...(entry.routine_refusal ? { routineRefusal: entry.routine_refusal } : {}),
        ...(entry.routine_question ? { routineQuestion: entry.routine_question } : {}),
        // A reloaded message shows the files it carried as it did when sent, from their saved references.
        ...(entry.files
          ? {
            files: entry.files.map((file) => ({
              key: file.id,
              name: file.name,
              size: file.size,
              kind: attachmentKind(file.media_type),
              note: '',
            })),
          }
          : {}),
      };
    }
    if (entry.kind === 'guidance') {
      return {
        ...stored,
        role: 'assistant',
        text: escapeMarkdownText(entry.reply),
        author,
      };
    }
    if (entry.kind === 'assistant-install') {
      return {
        ...stored,
        role: 'assistant',
        text: entry.state === 'installed'
          ? (entry.outcome === 'already-installed' ? copy.install.already : copy.install.complete)
          : entry.state === 'failed'
            ? installFailureText(entry.code)
            : copy.disconnected,
        author,
        installPlan: {
          plan_id: `history-${entry.id}`,
          state: entry.state,
          assistants: entry.assistants,
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
          ...(entry.status ? { status: entry.status } : {}),
          ...(entry.code ? { code: entry.code } : {}),
        },
      };
    }
    if (entry.kind === 'routine-run') {
      return { ...stored, role: 'assistant', text: '', author, routineRun: entry };
    }
    return {
      ...stored,
      role: 'assistant',
      text: '',
      author,
      lifecycle: {
        proposal_id: `history-${entry.id}`,
        assistant: entry.assistant,
        state: entry.state,
        completionAnnounced: true,
        ...(entry.state === 'uninstalled' ? { uninstalled: entry.uninstalled } : {}),
        ...(entry.status ? { status: entry.status } : {}),
      },
    };
  }

  async function hydrateHistory(teamId, generation) {
    try {
      const page = await listChatHistory(call, teamId);
      if (generation !== historyGeneration || chatTeamId !== teamId) return;
      const team = $teamContext.teams.find((entry) => entry.id === teamId);
      if (!team) throw new Error(copy.loadFailed);
      turns = page.entries.map((entry) => historyTurn(entry, team.name));
      historyBefore = page.before;
      historySeen = historyBoundary(new Set(), page.entries);
      historyLoading = false;
      connectSocket(teamId);
      if (turns.length > 0) await revealLatestExchange({ instant: true });
      if (generation === historyGeneration && chatTeamId === teamId) olderHistoryArmed = true;
    } catch (reason) {
      if (generation !== historyGeneration || chatTeamId !== teamId) return;
      historyLoading = false;
      setError(
        copy.loadFailed,
        reason instanceof Error ? reason.message : copy.loadFailed,
      );
      connectSocket(teamId);
    }
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
        ...page.entries.map((entry) => historyTurn(entry, team.name)),
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
  // Local Team's conversation is open, a change of that Team's Routines reads its Routine list again, and a change of its
  // history reads the history written since it was last read: pages newest first, back to the newest row already read.
  // The chat's view of the history holds, of the Routine notices, only each Routine's creation; its runs are its own
  // history, which its panel reads. Only Routine rows merge into the transcript, by identity and version: a new row,
  // or a newer version of a shown one, moves to the end as a reload would show it. The rest of the conversation, the
  // draft, and the reader's place stay as they are; a reader already at the end follows the new row. When more was
  // written than one refresh reads, the transcript starts again from what it read, as a reload shows it, and earlier
  // history continues from where the refresh stopped, through every row written in between. A change that arrives
  // while a turn or history is in motion is read once the conversation is idle again.
  const FOLLOW_SLACK = 48;
  let routineRefreshing = false;
  let historyChanged = $state(false);

  // A row is never added under a message still waiting for its reply, or while history or a turn is in motion.
  function routineMergeIdle() {
    return !composerBusy && !historyWorking && turns.at(-1)?.role !== 'user';
  }

  async function refreshRoutineNotices(teamId) {
    if (chatTeamId !== teamId) return;
    if (routineRefreshing || !routineMergeIdle()) {
      historyChanged = true;
      return;
    }
    historyChanged = false;
    routineRefreshing = true;
    const generation = historyGeneration;
    try {
      const since = await historySince(call, teamId, historySeen);
      if (generation !== historyGeneration || chatTeamId !== teamId) return;
      if (!routineMergeIdle()) {
        historyChanged = true;
        return;
      }
      const team = $teamContext.teams.find((entry) => entry.id === teamId);
      if (!team) return;
      if (since.before !== null) {
        turns = since.entries.map((entry) => historyTurn(entry, team.name));
        historyBefore = since.before;
        historySeen = historyBoundary(new Set(), since.entries);
        await revealLatestExchange({ instant: true });
        return;
      }
      historySeen = historyBoundary(historySeen, since.entries);
      const shown = new Map(
        turns.filter((turn) => turn.routineRun).map((turn) => [turn.historyId, turn.routineRun.version]),
      );
      const arrived = newerRoutineEntries(shown, since.entries);
      if (arrived.length === 0) return;
      const viewport = turnsViewport;
      const following = Boolean(viewport) &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_SLACK;
      const moved = new Set(arrived.map((entry) => entry.id));
      turns = [
        ...turns.filter((turn) => !moved.has(turn.historyId)),
        ...arrived.map((entry) => historyTurn(entry, team.name)),
      ];
      if (following) await revealLatestExchange();
    } catch {
      // The next change or reconnect reads again; the open conversation stays as it is.
    } finally {
      routineRefreshing = false;
    }
  }

  // The Team's history and Routines are subscribed as the Team opens, and the history is first read once its
  // subscription is in place, so a Routine notice written meanwhile is never missed; the Routines are read again then
  // too, since the Team list read them before (ADR-0114).
  let stopTeamTopics = () => {};

  function watchTeam(teamId, generation) {
    stopTeamTopics();
    stopTeamTopics = () => {};
    historyChanged = false;
    if (!teamId) return;
    let hydrated = false;
    const stopHistory = watchTopic(`team/${teamId}/history`, () => {
      if (generation !== historyGeneration) return;
      if (hydrated) {
        void refreshRoutineNotices(teamId);
        return;
      }
      hydrated = true;
      void hydrateHistory(teamId, generation);
    });
    const stopRoutines = watchTopic(`team/${teamId}/routines`, () => {
      loadTeamRoutines(call, teamId).catch(() => {});
    });
    stopTeamTopics = () => {
      stopHistory();
      stopRoutines();
    };
  }

  // A history change held back while the conversation was in motion is read once it is idle again.
  $effect(() => {
    if (historyChanged && chatTeamId && !historyHydrating && routineMergeIdle()) void refreshRoutineNotices(chatTeamId);
  });

  $effect(() => {
    void today;
    const timer = setTimeout(() => (today = calendarDay(Date.now())), untilNextDay(Date.now()) + 1_000);
    return () => clearTimeout(timer);
  });

  function applyInstallPlanEvent(incoming, receipt) {
    if (incoming.outcome === 'already-installed') {
      if (installPlanTurnIndex(incoming.plan_id) !== -1) throw new Error('duplicate install result');
      turns = [...turns, {
        renderKey: nextRenderKey++,
        role: 'assistant',
        text: copy.install.already,
        author: incoming.team_name,
        receipt,
        installPlan: {
          plan_id: incoming.plan_id,
          state: incoming.state,
          outcome: incoming.outcome,
          assistants: incoming.assistants,
        },
      }];
      return;
    }
    if (incoming.state === 'planned') {
      if (installPlanTurnIndex(incoming.plan_id) !== -1) throw new Error('duplicate install plan');
      turns = [...turns, {
        renderKey: nextRenderKey++,
        role: 'assistant',
        text: copy.install.working,
        author: incoming.team_name,
        receipt,
        installPlan: {
          plan_id: incoming.plan_id,
          state: incoming.state,
          assistants: incoming.assistants,
        },
      }];
      return;
    }
    const index = installPlanTurnIndex(incoming.plan_id);
    if (index < 0) throw new Error('unknown install plan');
    const current = turns[index].installPlan;
    if (
      current.assistants.length !== incoming.assistants.length ||
      current.assistants.some((assistant, position) => {
        const next = incoming.assistants[position];
        return assistant.id !== next.id ||
          assistant.name !== next.name ||
          assistant.summary !== next.summary ||
          assistant.provenance !== next.provenance ||
          assistant.providers.join('\0') !== next.providers.join('\0');
      })
    ) throw new Error('mismatched install plan');
    const itemTransitions = {
      pending: ['pending', 'installing', 'failed'],
      installing: ['installing', 'installed', 'failed'],
      installed: ['installed'],
    };
    if (current.assistants.some((assistant, position) => (
      !itemTransitions[assistant.status]?.includes(incoming.assistants[position].status)
    ))) throw new Error('invalid install plan item transition');
    const transitions = {
      planned: ['installing', 'failed', 'stopped'],
      installing: ['installing', 'installed', 'failed', 'stopped'],
    };
    if (!transitions[current.state]?.includes(incoming.state)) {
      throw new Error('invalid install plan transition');
    }
    turns = turns.map((turn, position) => position === index
      ? {
          ...turn,
          text: incoming.state === 'installed'
            ? copy.install.complete
            : incoming.state === 'failed'
              ? installFailureText(incoming.code)
              : incoming.state === 'stopped'
                ? copy.disconnected
                : turn.text,
          installPlan: {
            ...current,
            state: incoming.state,
            assistants: incoming.assistants,
            ...(incoming.status ? { status: incoming.status } : {}),
            ...(incoming.code ? { code: incoming.code } : {}),
          },
        }
      : turn);
  }

  function imageDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Assistant icon snapshot failed'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  function captureUninstallIcon(proposalId, assistantId, teamId) {
    const existing = lifecycleIconCaptures.get(proposalId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let captured = false;
    const source = `/api/teams/${encodeURIComponent(teamId)}/assistants/${encodeURIComponent(assistantId)}/icon`;
    const promise = fetch(source, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'image/png') return;
      const blob = await response.blob();
      if (!blob.size || blob.size > 1024 * 1024 || blob.type !== 'image/png') return;
      const snapshot = await imageDataUrl(blob);
      if (typeof snapshot !== 'string' || !snapshot.startsWith('data:image/png;base64,')) return;
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
    turns = turns.map((turn) => {
      if (turn.lifecycle?.state === 'proposed') {
        return { ...turn, lifecycle: { ...turn.lifecycle, state: 'expired' } };
      }
      if (turn.lifecycle?.state === 'working') {
        return { ...turn, lifecycle: { ...turn.lifecycle, state: 'unknown' } };
      }
      if (['planned', 'installing'].includes(turn.installPlan?.state)) {
        return {
          ...turn,
          installPlan: {
            ...turn.installPlan,
            state: 'stopped',
            assistants: turn.installPlan.assistants.map((assistant) => (
              assistant.status === 'installing' ? { ...assistant, status: 'unknown' } : assistant
            )),
          },
        };
      }
      return turn;
    });
  }

  function lifecycleTurnIndex(proposalId) {
    return turns.findLastIndex((turn) => turn.lifecycle?.proposal_id === proposalId);
  }

  function applyLifecycleEvent(incoming, receipt) {
    if (incoming.state === 'proposed') {
      if (lifecycleTurnIndex(incoming.proposal_id) !== -1) throw new Error('duplicate lifecycle proposal');
      turns = [...turns, {
        renderKey: nextRenderKey++,
        role: 'assistant',
        text: lifecycleProposalReply(incoming.assistant),
        author: incoming.team_name,
        receipt,
        lifecycle: {
          proposal_id: incoming.proposal_id,
          assistant: incoming.assistant,
          state: 'proposed',
        },
      }];
      scheduleLifecycleExpiry(incoming.proposal_id, incoming.expires_in);
      void captureUninstallIcon(
        incoming.proposal_id,
        incoming.assistant.id,
        incoming.team_id,
      );
      return true;
    }
    const index = lifecycleTurnIndex(incoming.proposal_id);
    if (index < 0) throw new Error('unknown lifecycle proposal');
    const current = turns[index].lifecycle;
    if (current.assistant.id !== incoming.assistant_id) {
      throw new Error('mismatched lifecycle proposal');
    }
    clearLifecycleExpiry(incoming.proposal_id);
    const workingState = 'uninstalling';
    const completeState = 'uninstalled';
    const allowed = current.state === 'proposed'
      ? [workingState, 'cancelled', 'expired']
      : current.state === 'working' ? [completeState, 'failed']
        : current.state === 'expired' ? ['expired'] : [];
    if (!allowed.includes(incoming.state)) throw new Error('invalid lifecycle transition');
    const state = incoming.state === workingState ? 'working' : incoming.state;
    const updated = {
      ...current,
      state,
      ...(incoming.state === 'uninstalled'
        ? {
            uninstalled: incoming.uninstalled,
          }
        : {}),
      ...(incoming.state === 'failed' ? { status: incoming.status } : {}),
    };
    turns = turns.map((turn, turnIndex) => (
      turnIndex === index ? { ...turn, lifecycle: updated } : turn
    ));
    return incoming.state !== workingState;
  }

  async function appendUninstallOutcome(incoming) {
    const { installedAssistants } = await refreshTeamInventory();
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

  function friendlyChatError(status) {
    if (status === 409) return copy.turnFailed;
    if (status === 429) return copy.capacityFailed;
    if (status === 503) return copy.runtimeFailed;
    return copy.requestFailed;
  }

  function assistantLimitText() {
    return $t('store.assistantLimitReached', { maximum: String(MAX_TEAM_ASSISTANTS) });
  }

  function installFailureText(code) {
    return code === ASSISTANT_LIMIT_REACHED ? assistantLimitText() : copy.install.failed;
  }

  function projectedChatError(status, detail) {
    if (status === 409 && detail === ASSISTANT_LIMIT_REACHED) return { message: assistantLimitText(), detail: '' };
    if (status === 403 && detail === 'authentication was not confirmed') {
      return { message: copy.authenticationDenied, detail: '' };
    }
    if (status === 503 && detail === 'authentication is unavailable') {
      return { message: copy.authenticationUnavailable, detail: '' };
    }
    const resetting = status === 409 && typeof detail === 'string' && detail.startsWith('space-resetting:');
    return {
      message: resetting ? copy.spaceResetting : friendlyChatError(status),
      detail: `HTTP ${status} · ${detail}`,
    };
  }

  function resetChallengeState({ includeInventory = false } = {}) {
    integrationChallenge = undefined;
    humanChallenge = undefined;
    humanRejection = undefined;
    humanWorking = false;
    humanExpiredId = '';
    humanRelocalizing = '';
    integrationsDialogOpen = false;
    integrationsReady = false;
    integrationWorking = '';
    storedInputWorking = '';
    if (includeInventory) {
      integrations = [];
      storedInputs = [];
    }
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
      // An open Integrations drawer shows the Team's Integrations as they are once Admin is back, read after the Team's
      // inventory that admits them, which may have gained an Assistant meanwhile.
      if (integrationsOpen) void recoverIntegrations(expectedTeamId);
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
              incoming.code === ASSISTANT_LIMIT_REACHED ? assistantLimitText() : friendlyChatError(incoming.status),
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
          ...(incoming.clarification ? { clarification: incoming.clarification } : {}),
          ...(incoming.usage ? { usage: taskUsageSummary(incoming.usage) } : {}),
          ...(incoming.restricted_actions ? { restricted: incoming.restricted_actions } : {}),
          ...(incoming.routine_proposal ? { routineProposal: incoming.routine_proposal } : {}),
          ...(incoming.routine_refusal ? { routineRefusal: incoming.routine_refusal } : {}),
          ...(incoming.routine_question ? { routineQuestion: incoming.routine_question } : {}),
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
    if (attachmentTeamId !== nextTeamId) clearAttachments();
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
    historySeen = new Set();
    historyWorking = false;
    olderHistoryArmed = false;
    olderHistoryFailed = false;
    historyLoading = Boolean(nextTeamId);
    const generation = ++historyGeneration;
    resetProgress();
    scrollRequest += 1;
    integrationsOpen = false;
    resetChallengeState({ includeInventory: true });
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

  async function recoverIntegrations(teamId) {
    await refreshTeamInventory().catch(() => {});
    if (integrationsOpen && chatTeamId === teamId) await refreshIntegrations(teamId);
  }

  async function refreshIntegrations(teamId) {
    integrationsReady = false;
    try {
      const [integrationInventory, storedInputInventory] = await Promise.all([
        listAssistantIntegrations(teamId),
        listAssistantStoredInputs(teamId),
      ]);
      if (chatTeamId !== teamId) return;
      const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
      if (
        integrationInventory.integrations.some((integration) => !installed.has(integration.assistant_id)) ||
        storedInputInventory.stored_inputs.some((item) => !installed.has(item.assistant_id))
      ) {
        throw new Error(integrationsCopy.inventoryFailed);
      }
      integrations = integrationInventory.integrations;
      storedInputs = storedInputInventory.stored_inputs;
      integrationsReady = true;
    } catch (reason) {
      if (chatTeamId !== teamId) return;
      integrations = [];
      storedInputs = [];
      setError(
        integrationsCopy.inventoryFailed,
        reason instanceof Error ? reason.message : integrationsCopy.inventoryFailed,
      );
    }
  }

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
    try {
      await clearAssistantStoredInput(teamId, item.assistant_id, item.stored_input_id);
      if (chatTeamId !== teamId) return;
      storedInputs = storedInputs.map((candidate) => (
        candidate.assistant_id === item.assistant_id &&
        candidate.stored_input_id === item.stored_input_id
          ? { ...candidate, status: 'missing' }
          : candidate
      ));
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
    const next = !integrationsOpen;
    integrationsOpen = next;
    if (next && chatTeamId) void refreshIntegrations(chatTeamId);
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

  function clearAttachments() {
    attachmentUpload?.controller.abort();
    attachmentUpload = null;
    attachments = [];
    attachmentInspections = [];
    attachmentTeamId = '';
    attachmentError = '';
    attachmentDragging = false;
  }

  function removeAttachment(key) {
    if (attachmentUpload?.key === key) attachmentUpload.controller.abort();
    attachments = attachments.filter((item) => item.key !== key);
    attachmentError = '';
    composerInput?.focus();
  }

  function cancelAttachmentUploads() {
    attachmentUpload?.controller.abort();
    attachments = attachments.filter((item) => item.state === 'ready');
    attachmentInspections = [];
    composerInput?.focus();
  }

  async function addAttachments(files) {
    const teamId = chatTeamId;
    if (!teamId || attachmentsUnavailable) return;
    if (attachmentTeamId !== teamId) clearAttachments();
    attachmentTeamId = teamId;
    attachmentError = '';
    // The selection blocks sending before its first read, so a message never leaves without a file still being read.
    const inspection = nextAttachmentInspection++;
    attachmentInspections = [...attachmentInspections, inspection];
    const current = () => attachmentTeamId === teamId && attachmentInspections.includes(inspection);
    try {
      for (const file of files) {
        // A Team change or a cancel ends the selection: no further file of it is read, even after a failed read.
        if (!current()) return;
        let readability = { kind: 'file', note: 'unreadable' };
        if (file.size > 0) {
          try {
            readability = await attachmentReadability(file);
          } catch {
            if (current()) attachmentError = attachmentRefusalText('unavailable', file.name);
            continue;
          }
        }
        // A selection that finishes reading after a Team change or a cancel belongs to no message.
        if (!current()) return;
        const refusal = attachmentRefusal(attachments, { size: file.size, ...readability });
        if (refusal) {
          attachmentError = attachmentRefusalText(refusal, file.name);
          if (refusal === 'too-many') break;
          continue;
        }
        attachments = [...attachments, {
          key: nextAttachmentKey++,
          file,
          name: file.name,
          size: file.size,
          ...readability,
          state: 'queued',
        }];
      }
    } finally {
      attachmentInspections = attachmentInspections.filter((entry) => entry !== inspection);
    }
    void uploadAttachments();
  }

  function updateAttachment(key, patch) {
    attachments = attachments.map((item) => (item.key === key ? { ...item, ...patch } : item));
  }

  async function uploadAttachments() {
    if (attachmentPumping) return;
    attachmentPumping = true;
    try {
      for (let item = attachments.find((entry) => entry.state === 'queued'); item;
        item = attachments.find((entry) => entry.state === 'queued')) {
        const teamId = attachmentTeamId;
        const controller = new AbortController();
        attachmentUpload = { key: item.key, controller };
        updateAttachment(item.key, { state: 'uploading' });
        try {
          const stored = await uploadTeamFile(fetch, teamId, item.file, controller.signal);
          if (controller.signal.aborted || attachmentTeamId !== teamId) continue;
          // Team keeps one copy of an identical file: one already in this message is not attached twice.
          if (attachments.some((entry) => entry.key !== item.key && entry.id === stored.id)) {
            attachments = attachments.filter((entry) => entry.key !== item.key);
          } else {
            updateAttachment(item.key, { state: 'ready', id: stored.id, name: stored.name, size: stored.size });
          }
          attachmentFinished += 1;
        } catch (reason) {
          if (controller.signal.aborted || attachmentTeamId !== teamId) continue;
          attachments = attachments.filter((entry) => entry.key !== item.key);
          attachmentFinished += 1;
          attachmentError = attachmentRefusalText(
            reason instanceof AttachmentUploadError ? reason.reason : 'failed',
            item.name,
          );
        } finally {
          if (attachmentUpload?.controller === controller) attachmentUpload = null;
        }
      }
    } finally {
      attachmentPumping = false;
      attachmentFinished = 0;
    }
  }

  function chooseAttachments() {
    attachmentInput?.click();
  }

  function attachmentsChosen(event) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (files.length) void addAttachments(files);
  }

  // Pasted files join the message; pasted text still lands in the draft as usual.
  function pasteAttachments(event) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    void addAttachments(files);
  }

  function carriesFiles(event) {
    return [...(event.dataTransfer?.types ?? [])].includes('Files');
  }

  function dragAttachments(event) {
    if (!carriesFiles(event) || attachmentsUnavailable) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    attachmentDragging = true;
  }

  function leaveAttachments(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) attachmentDragging = false;
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
    attachmentDragging = false;
    if (attachmentsUnavailable) return;
    const files = [...(event.dataTransfer.files ?? [])];
    if (files.length) void addAttachments(files);
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
    if (attachmentsPending) return;
    const attached = attachmentTeamId === chatTeamId ? attachments : [];
    if (!questionOpen && submitMessage(draft, { attached })) {
      draft = '';
      promptHistoryIndex = -1;
      attachments = [];
      attachmentTeamId = '';
      attachmentError = '';
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

  // The conversation is inert while its history hydrates, so the key field takes focus once it is usable.
  $effect(() => {
    void keySelection;
    if (!mounted || !keyRequired || historyHydrating || integrationsOpen) return;
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
      clearAttachments();
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
        <p class="live-status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
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
          <!-- When a message was sent or a reply completed, to the second, in the viewer's timezone. -->
          {#snippet turnTime(turn)}
            {@const instant = instantOf(turn)}
            <span class="turn-at">{copy.timeAt}</span>
            <time class="turn-time" datetime={instantValue(instant)}>{clockTime(instant, $locale)}</time>
          {/snippet}
          {#each exchanges as exchange, index (exchange.key)}
            {@const userTurn = exchange.user}
            {@const assistantTurn = exchange.assistant}
            {@const opensDay = days[index] !== days[index - 1]}
            {#if opensDay}
              <ChatDay day={days[index]} {today} locale={$locale} />
            {/if}
            <!-- A Routine notice keeps its time on its own rail; every other reply shows when it was completed. -->
            {#snippet replyTime()}{@render turnTime(assistantTurn)}{/snippet}
            <section class="exchange">
              {#if userTurn}
                <Message variant="user" author={copy.you}>
                  {#snippet meta()}{@render turnTime(userTurn)}{/snippet}
                  {@const answer = clarificationAnswers.sent.get(index) ?? null}
                  {#if userTurn.resumedObjective}
                    <div class="resumed-task">
                      <strong>{copy.install.resuming}</strong>
                      <span>{userTurn.resumedObjective}</span>
                    </div>
                  {/if}
                  {#if answer !== null}
                    <!-- The question stays above its answer, so the person always sees what they replied to. -->
                    <div class="clarification-reply">
                      <p class="clarification-question">
                        <span class="reply-label">{$t('clarify').questionLabel}</span>{answer.question}
                      </p>
                      <p><span class="reply-label">{$t('clarify').answered}</span>{answer.answer}</p>
                    </div>
                  {:else}
                    <p>{userTurn.text}</p>
                  {/if}
                  {#if userTurn.files}
                    <ul class="message-attachments" aria-label={attachCopy.list}>
                      {#each userTurn.files as file (file.key)}
                        <AttachmentChip name={file.name} size={file.size} kind={file.kind} note={file.note} sent />
                      {/each}
                    </ul>
                  {/if}
                </Message>
              {/if}
              {#if assistantTurn}
                <!-- A Routine notice names its Routine in its own words; the chat already is the Team's. -->
                <Message
                  variant="assistant"
                  author={assistantTurn.routineRun ? undefined : assistantTurn.author}
                  meta={assistantTurn.routineRun ? undefined : replyTime}
                >
                  {@const clarifiedOriginal = clarifiedRequest(exchange)}
                  {#if clarifiedOriginal !== null}
                    <ClarificationCard
                      clarification={assistantTurn.clarification}
                      original={clarifiedOriginal}
                      copy={$t('clarify')}
                      answered={clarificationAnswers.given.get(index) ?? null}
                      disabled={sendUnavailable}
                      onanswer={(answer) => answerClarification(exchange, answer)}
                    />
                  {:else if assistantTurn.routineRun}
                    <RoutineRunEntry
                      entry={assistantTurn.routineRun}
                      copy={$t('routine')}
                      joinAbove={!opensDay && !userTurn && Boolean(exchanges[index - 1]?.assistant?.routineRun)}
                      joinBelow={days[index + 1] === days[index] && !exchanges[index + 1]?.user &&
                        Boolean(exchanges[index + 1]?.assistant?.routineRun)}
                    />
                  {:else if !assistantTurn.installPlan && (
                    !assistantTurn.lifecycle || assistantTurn.lifecycle.state === 'proposed'
                  )}
                    <Markdown markdown={assistantTurn.text} variant="chat" />
                  {/if}
                  {#if assistantTurn.installPlan}
                    <div
                      class="assistant-install-plan"
                      role="group"
                      aria-label={copy.install.label}
                    >
                      {#each assistantTurn.installPlan.assistants as assistant (assistant.id)}
                        {#snippet planMedia()}
                          <AssistantIcon
                            assistant={assistant.id}
                            src={installPlanIconSource(assistant)}
                            status={installPlanIconStatus(assistant)}
                            size={44}
                          />
                        {/snippet}
                        {#snippet planDetails()}
                          {#if assistant.provenance === 'local'}
                            <span class="assistant-lifecycle-provenance">{storeCopy.localBadge}</span>
                          {/if}
                          {#if assistant.status === 'failed' && assistantTurn.installPlan.status}
                            <span class="assistant-lifecycle-detail-copy">
                              HTTP {assistantTurn.installPlan.status}
                            </span>
                          {/if}
                        {/snippet}
                        <ChatTask
                          class="assistant-lifecycle-task"
                          label={copy.install.label}
                          title={assistant.name}
                          description={assistant.summary}
                          state={installPlanVisualState(assistant.status)}
                          status={installPlanStatus(
                            assistant.status,
                            assistantTurn.installPlan.outcome,
                          )}
                          media={planMedia}
                          details={assistant.provenance === 'local' || assistant.status === 'failed'
                            ? planDetails
                            : undefined}
                        />
                      {/each}
                    </div>
                  {/if}
                  {#if assistantTurn.lifecycle}
                    {@const lifecycle = assistantTurn.lifecycle}
                    {@const lifecycleMessages = copy.uninstall}
                    {#snippet lifecycleMedia()}
                      <AssistantIcon
                        assistant={lifecycle.assistant.id}
                        src={lifecycleIconSource(lifecycle)}
                        status={lifecycle.state === 'uninstalled' ? 'failed' : 'loading'}
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
                            <DialogAction
                              kind="cancel"
                              size="compact"
                              type="button"
                              onclick={() => submitLifecycleDecision('no')}
                              disabled={lifecycleDecisionDisabled}
                              aria-label={$t('chatPage.uninstall.cancelActionLabel', {
                                assistant: lifecycle.assistant.name,
                              })}
                            >
                              {lifecycleMessages.cancelAction}
                            </DialogAction>
                            <DialogAction
                              kind="danger"
                              size="compact"
                              type="button"
                              onclick={() => submitLifecycleDecision('yes')}
                              disabled={lifecycleDecisionDisabled}
                              aria-label={$t('chatPage.uninstall.uninstallActionLabel', {
                                assistant: lifecycle.assistant.name,
                              })}
                            >
                              {lifecycleMessages.uninstallAction}
                            </DialogAction>
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
                      description={lifecycleMessages.consequences}
                      state={lifecycleVisualState(lifecycle.state)}
                      status={lifecycleStatus(lifecycle)}
                      media={lifecycleMedia}
                      details={lifecycle.state === 'proposed' || lifecycle.status
                        ? lifecycleDetails
                        : undefined}
                      tabindex={lifecycle.state === 'working' ? -1 : undefined}
                    />
                    {#if lifecycle.state === 'uninstalled' && lifecycle.completionAnnounced}
                      <div class="assistant-lifecycle-outcome">
                        <Markdown
                          markdown={lifecycleOutcome(lifecycle, assistantTurn.author)}
                          variant="chat"
                        />
                      </div>
                    {/if}
                  {/if}
                  <!-- With recorded steps, the usage line itself opens them: one line, its triangle beside it. -->
                  {#snippet usageLine()}
                    {@const shown = shownUsage(assistantTurn).usage}
                    <span class="task-usage" title={formatTaskUsageDetail(shown, $locale, copy.usage)}>
                      {formatTaskUsage(shown, $locale, copy.usage)}
                    </span>
                  {/snippet}
                  {#if assistantTurn.usage && !shownUsage(assistantTurn).receipt}
                    <p class="task-usage" title={formatTaskUsageDetail(assistantTurn.usage, $locale, copy.usage)}>
                      {formatTaskUsage(assistantTurn.usage, $locale, copy.usage)}
                    </p>
                  {/if}
                  <ExecutionReceipt
                    line={assistantTurn.usage ? usageLine : undefined}
                    durationMs={assistantTurn.usage?.durationMs}
                    events={assistantTurn.receipt ?? []}
                    label={copy.progressStagesExecuted}
                    progressLabels={copy.progress}
                    teamName={assistantTurn.author}
                    {assistantNames}
                  />
                  {#if assistantTurn.restricted}
                    <RestrictedActionsNote restricted={assistantTurn.restricted} {assistantNames} />
                  {/if}
                  <!-- A recording turn's Routine card, what Team asks first, or why it made none; a reload shows it again. -->
                  {#if assistantTurn.routineQuestion && exchange.user}
                    <RoutineQuestion
                      question={assistantTurn.routineQuestion}
                      original={exchange.user.text}
                      copy={$t('routine').proposal}
                      clarifyCopy={$t('clarify')}
                      answered={clarificationAnswers.given.get(index) ?? null}
                      disabled={sendUnavailable}
                      onanswer={(answer) => answerClarification(exchange, answer)}
                    />
                  {:else if assistantTurn.routineProposal}
                    <RoutineProposal teamId={selectedTeamId} proposal={assistantTurn.routineProposal}
                      copy={$t('routine')} locale={$locale} />
                  {:else if assistantTurn.routineRefusal}
                    <p class="routine-refusal" role="note">{refusalWords(assistantTurn.routineRefusal, $t('routine').proposal)}</p>
                  {/if}
                </Message>
                {#if index === exchanges.length - 1 && busy && assistantTurn.installPlan?.state === 'installed' && !integrationChallenge && !humanChallenge}
                  <!-- An install that continues the requested task keeps showing that task's execution stages. -->
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
                {/if}
              {:else if index === exchanges.length - 1 && busy && !lifecycleWorking && !integrationChallenge && !humanChallenge}
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
              {/if}
            </section>
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

          <form
            class="composer"
            class:composer-dropping={attachmentDragging}
            onsubmit={keyRequired ? saveProviderKey : send}
            ondragenter={dragAttachments}
            ondragover={dragAttachments}
            ondragleave={leaveAttachments}
            ondrop={dropAttachments}
          >
            {#if (keyRequired || brainUnavailable) && $modelContext.error}
              <!-- The Brain's own failure sits on the composer it blocks, independent of any chat error. -->
              <Notice class="chat-brain-error" variant="error">
                <strong>{$modelContext.errorCode === 'outcome-unknown' ? $t('shell.outcomeUnknown') : $modelContext.error}</strong>
                {#if brainUnavailable}
                  <Button variant="secondary" size="compact" type="button" onclick={retryBrain} disabled={brainSaving || !$commandsReady}>
                    {keyCopy.retry}
                  </Button>
                {/if}
              </Notice>
            {/if}
            <div class="composer-input">
              {#if keyRequired}
                <TextField
                  id="chat-provider-key"
                  label={keyCopy.key}
                  visuallyHiddenLabel
                  class="composer-field"
                  type="password"
                  bind:value={providerKey}
                  placeholder={$t('providerSetup.keyPlaceholder', {
                    provider: brainProvider.title,
                    model: brainModel.title,
                  })}
                  minlength="16"
                  maxlength="8192"
                  autocomplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore="true"
                  spellcheck="false"
                  required
                  disabled={brainSaving}
                  aria-describedby="chat-provider-key-note"
                />
                <p id="chat-provider-key-note" class="sr-only">{keyCopy.keyNote}</p>
              {:else}
                <ComposerAttachments
                  items={attachments}
                  progress={attachmentProgress}
                  reading={attachmentInspections.length > 0}
                  error={attachmentError}
                  oncancel={cancelAttachmentUploads}
                  onremove={removeAttachment}
                />
                {#if attachmentDragging}
                  <p class="composer-drop" aria-hidden="true">{attachCopy.drop}</p>
                {/if}
                <TextAreaField
                  id="chat-composer"
                  label={copy.send}
                  visuallyHiddenLabel
                  class="composer-field"
                  bind:element={composerInput}
                  bind:value={draft}
                  rows="2"
                  placeholder={questionOpen ? $t('clarify').answerFirst : placeholder}
                  disabled={composerBusy || questionOpen}
                  onkeydown={handleComposerKeydown}
                  onpaste={pasteAttachments}
                />
              {/if}
              <Toolbar class="composer-actions">
              {#if !keyRequired}
                <!-- Attaching comes first among the composer's tools; the picker accepts any file Team may keep. -->
                <Button
                  class="composer-attach"
                  variant="ghost"
                  size="icon"
                  type="button"
                  onclick={chooseAttachments}
                  disabled={attachmentsUnavailable || attachments.length >= MAX_ATTACHMENTS}
                  aria-label={attachCopy.attach}
                  title={attachCopy.attach}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M15.5 7.5l-6.8 6.8a1.9 1.9 0 0 0 2.7 2.7l7.1-7.1a3.8 3.8 0 0 0-5.4-5.4l-7.3 7.3a5.7 5.7 0 0 0 8.1 8.1l5.6-5.6"></path>
                  </svg>
                </Button>
                <FileInput
                  bind:element={attachmentInput}
                  id="chat-attachment-picker"
                  multiple
                  hidden
                  onchange={attachmentsChosen}
                />
              {/if}
              <BrainMenu disabled={menusBusy} />
              <FastRoutingMenu disabled={menusBusy} />
              <Button
                bind:element={integrationsButton}
                class="composer-integrations"
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
                  <path d="M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v2.2a2.8 2.8 0 0 1-2.8 2.8H8"></path>
                </svg>
              </Button>
              {#if busy && !syncing && (!lifecycleWorking || installPlanWorking)}
                <!-- While a turn runs, Send becomes Stop in place; once the turn ends it is Send again. -->
                <Button
                  bind:element={stopButton}
                  class="composer-send composer-stop"
                  type="button"
                  variant="ghost"
                  onclick={stop}
                  disabled={stopping}
                  title={copy.stop}
                >
                  <span class="sr-only">{copy.stop}</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path></svg>
                </Button>
              {:else if keyRequired}
                <Button type="submit" disabled={brainSaving || !$commandsReady || providerKey.trim().length < 16}>
                  {brainSaving ? keyCopy.validating : keyCopy.saveKey}
                </Button>
              {:else}
                <Button
                  class="composer-send"
                  type="submit"
                  variant="ghost"
                  disabled={sendUnavailable || questionOpen || !draft.trim() || attachmentsPending}
                  title={socketReady ? copy.send : copy.connecting}
                >
                  <span class="sr-only">{socketReady ? copy.send : copy.connecting}</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5V4.5M5.5 11 12 4.5l6.5 6.5"></path></svg>
                </Button>
              {/if}
              </Toolbar>
            </div>
          </form>
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
    /* A Routine notice's timeline rail reaches back across this gap to the notice before it. */
    --routine-rail-gap: var(--gap-group);
    display: grid;
    min-width: 0;
    align-content: start;
    gap: var(--gap-item);
    margin-block-start: var(--routine-rail-gap);
  }

  .exchange:first-child,
  :global(.chat-day + .exchange) {
    margin-block-start: 0;
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

  /* Inside the receipt's uppercase summary the usage keeps its own case and spacing. */
  span.task-usage { margin: 0; text-transform: none; }
  .task-usage {
    margin: var(--gap-inside) 0 0;
    color: var(--shimpz-color-text-dim);
    font: 500 0.68rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .routine-refusal {
    margin: var(--gap-item) 0 0;
    color: var(--shimpz-color-text-muted);
    font-size: 0.85rem;
  }
  /* The time sits right after its author's name instead of across the message. */
  :global(.turns [data-slot="message-header"]) {
    justify-content: flex-start;
    gap: 1ch; /* one word space, the same as between "às" and the time */
  }
  /* "às" reads as a word in the sentence "NEO às 10:30:00", not as part of the uppercase label. */
  .turn-at {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  /* Beside the author, as quiet as the day headers and the Routine rail's times: small dim digits that never shift. */
  .turn-time {
    font: 400 0.66rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .clarification-reply { display: grid; gap: var(--gap-item); margin: 0; }
  .clarification-reply p { display: grid; gap: var(--gap-inside); margin: 0; }
  .clarification-question { color: var(--shimpz-color-text-muted); }
  .reply-label {
    color: var(--shimpz-color-text-muted);
    font-family: var(--shimpz-font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .resumed-task {
    display: grid;
    gap: var(--gap-inside);
    margin-bottom: var(--gap-item);
    padding-left: var(--gap-group);
    border-left: 2px solid currentColor;
    color: var(--text-faint);
    line-height: 1.45;
  }

  .resumed-task strong {
    color: currentColor;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  :global(.assistant-lifecycle-task) {
    margin-block-start: var(--gap-group);
  }
  .assistant-install-plan { display: grid; gap: var(--gap-item); margin-block-start: var(--gap-group); }
  .assistant-lifecycle-outcome { padding-block-start: var(--gap-group); }

  :global(.assistant-lifecycle-task .assistant-lifecycle-detail-copy) {
    display: block;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-provenance) {
    display: inline-block;
    padding: var(--gap-inside) var(--gap-item);
    color: var(--shimpz-color-yellow);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border: 1px solid color-mix(in srgb, var(--shimpz-color-yellow) 72%, transparent);
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-confirm-copy) {
    text-align: right;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-details) {
    display: grid;
    gap: var(--gap-item);
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-actions) {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--gap-group);
    margin-block-start: var(--gap-group);
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

  .composer :global(.chat-brain-error) {
    display: grid;
    justify-items: start;
    gap: var(--gap-item);
    font-size: 0.72rem;
  }

  .conversation :global(.chat-error strong),
  .composer :global(.chat-brain-error strong),
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
    gap: var(--gap-item);
    padding: var(--gap-item) 0;
    background: var(--surface-1);
  }

  .empty-conversation .composer {
    grid-row: 1;
    align-self: center;
  }

  /* The composer is one quiet chamfered surface: the message, then a hairline-free row of bare tool icons and a
     compact send key. Focus lights the frame and a cyan corner tick; nothing else competes with the text. */
  .composer-input {
    position: relative;
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
    border: 1px solid color-mix(in srgb, var(--shimpz-color-text) 10%, transparent);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 2%, var(--shimpz-color-bg));
    clip-path: var(--shimpz-control-shape);
    transition: border-color var(--shimpz-duration-fast) var(--shimpz-ease), background var(--shimpz-duration-fast) var(--shimpz-ease);
  }

  .composer-input::before {
    position: absolute;
    inset-block-start: -1px;
    inset-inline-start: -1px;
    width: 1.1rem;
    height: 1px;
    background: var(--shimpz-color-cyan);
    opacity: 0.45;
    content: "";
    transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease), width var(--shimpz-duration-fast) var(--shimpz-ease);
  }

  .composer-input:focus-within {
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 4%, var(--shimpz-color-bg));
  }

  .composer-input:focus-within::before { width: 2.5rem; opacity: 1; }

  /* Files dragged over the composer light its frame and name what dropping does. */
  .composer-dropping .composer-input {
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    border-style: dashed;
  }

  .composer-drop {
    margin: 0;
    padding: var(--gap-item) var(--gap-group) 0;
    color: var(--shimpz-color-text-muted);
    font: 400 0.75rem/1.4 var(--shimpz-font-mono);
  }

  .message-attachments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: var(--gap-item);
    margin: var(--gap-item) 0 0;
    padding: 0;
    list-style: none;
  }

  .composer-input :global(.composer-field) { gap: 0; }

  .composer-input :global(.composer-field textarea),
  .composer-input :global(.composer-field input) {
    width: 100%;
    height: auto;
    min-height: 3.25rem;
    max-height: 12rem;
    field-sizing: content;
    resize: none;
    padding: var(--gap-group) var(--gap-group) var(--gap-inside);
    color: var(--shimpz-color-text);
    font: 400 0.95rem/1.5 var(--shimpz-font-sans);
    background: transparent;
    border: 0;
    clip-path: none;
    overflow-y: auto;
  }

  .composer-input :global(.composer-field textarea::placeholder),
  .composer-input :global(.composer-field input::placeholder) {
    color: var(--shimpz-color-text-dim);
    font-family: var(--shimpz-font-mono);
    font-size: 0.82rem;
    letter-spacing: 0.02em;
  }

  /* The frame carries focus; the field's own ring would draw a box inside the box. */
  .composer-input :global(.composer-field textarea:focus),
  .composer-input :global(.composer-field input:focus) {
    border: 0;
    outline: none;
    box-shadow: none;
  }

  :global(.composer-actions) {
    display: flex;
    align-items: center;
    gap: var(--gap-inside);
    padding: var(--gap-inside) var(--gap-item) var(--gap-item);
  }

  :global(.composer-actions .composer-integrations) {
    margin-inline-end: auto;
  }

  /* Tool controls are bare icons: no frame, only their color reacts. */
  .composer-input :global(.shimpz-button.composer-attach),
  .composer-input :global(.shimpz-button.composer-attach:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations),
  .composer-input :global(.shimpz-button.composer-integrations:hover:not(:disabled)) {
    color: var(--shimpz-color-text-dim);
    border-color: transparent;
    background: transparent;
    clip-path: none;
    box-shadow: none;
  }

  .composer-input :global(.shimpz-button.composer-attach:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations[aria-expanded="true"]) {
    color: var(--shimpz-color-cyan);
  }

  .composer :global(.shimpz-button) {
    height: 2.25rem;
    min-height: 0;
  }

  .composer-input :global(.brain-trigger),
  .composer-input :global(.composer-attach),
  .composer-input :global(.composer-integrations) {
    width: 2.25rem;
    height: 2.25rem;
  }

  /* Send is a compact chamfered key: a dim outline at rest, cyan once there is something to send. */
  .composer-input :global(.shimpz-button.composer-send) {
    width: 2.25rem;
    padding: 0;
    color: var(--shimpz-color-cyan);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 10%, transparent);
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent);
  }

  .composer-input :global(.shimpz-button.composer-send:hover:not(:disabled)) {
    color: var(--shimpz-color-bg);
    background: var(--shimpz-color-cyan);
    border-color: var(--shimpz-color-cyan);
  }

  .composer-input :global(.shimpz-button.composer-send:disabled) {
    color: var(--shimpz-color-text-dim);
    background: transparent;
    border-color: var(--shimpz-color-border);
    filter: none;
    opacity: 1;
  }

  /* Stop takes Send's place while a turn runs: the same key, filled red with an X. */
  .composer-input :global(.shimpz-button.composer-send.composer-stop),
  .composer-input :global(.shimpz-button.composer-send.composer-stop:hover:not(:disabled)) {
    color: var(--shimpz-color-bg);
    background: var(--shimpz-color-danger);
    border-color: var(--shimpz-color-danger);
  }

  .composer-input :global(.shimpz-button.composer-send.composer-stop:disabled) {
    color: var(--shimpz-color-bg);
    background: color-mix(in srgb, var(--shimpz-color-danger) 45%, transparent);
    border-color: color-mix(in srgb, var(--shimpz-color-danger) 45%, transparent);
  }

  :global(.composer-actions .shimpz-button svg) {
    width: 1.05rem;
    height: 1.05rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .composer-input :global(.shimpz-button.composer-send:hover:not(:disabled) svg) { filter: none; }

  @media (prefers-reduced-motion: reduce) {
    .composer-input, .composer-input::before { transition: none; }
    .composer-input :global(svg) { animation: none !important; }
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

  @media (max-width: 820px) {
    .empty-conversation .composer { align-self: end; }
  }

  @media (forced-colors: active) {
    .composer-input { border-color: CanvasText; clip-path: none; }
  }

  @media (max-width: 640px) {
    :global(.turns .shimpz-message--user) { max-width: 92%; }
    .composer :global(.shimpz-button) { padding-inline: var(--gap-item); }
  }
</style>
