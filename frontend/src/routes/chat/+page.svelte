<script>
  import { flushSync, getContext, onMount, tick } from 'svelte';
  import { AssistantIcon, Button, ChatTask, EmptyState, FileInput, Message, Notice, ScrollArea, TextAreaField, TextField, TextLink, Toolbar } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '$lib/AssistantHumanRequestDialog.svelte';
  import AttachmentChip from '$lib/AttachmentChip.svelte';
  import {
    AttachmentUploadError,
    attachmentKind,
    attachmentReadability,
    attachmentRefusal,
    MAX_ATTACHMENTS,
    uploadTeamFile,
  } from '$lib/attachments.js';
  import ComposerAttachments from '$lib/ComposerAttachments.svelte';
  import RestrictedActionsNote from '$lib/RestrictedActionsNote.svelte';
  import DialogAction from '$lib/DialogAction.svelte';
  import AssistantIntegrationsDialog from '$lib/AssistantIntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '$lib/AssistantIntegrationsDrawer.svelte';
  import { historyBoundary, historySince, listChatHistory } from '$lib/chatHistory.js';
  import BrainMenu from '$lib/BrainMenu.svelte';
  import EffortMenu from '$lib/EffortMenu.svelte';
  import FastRoutingMenu from '$lib/FastRoutingMenu.svelte';
  import ClarificationCard from '$lib/ClarificationCard.svelte';
  import { clarifiedRequest, matchClarificationAnswers } from '$lib/clarification.js';
  import { formatTaskUsage, formatTaskUsageDetail, taskUsageSummary } from '$lib/taskUsage.js';
  import RoutineRunEntry from '$lib/RoutineRunEntry.svelte';
  import ChatDay from '$lib/ChatDay.svelte';
  import { calendarDay, clockTime, exchangeDays, instantValue, turnInstants, untilNextDay } from '$lib/chatDays.js';
  import { newerRoutineEntries } from '$lib/routine.js';
  import { loadTeamRoutines } from '$lib/routineContext.js';
  import ExecutionReceipt from '$lib/ExecutionReceipt.svelte';
  import {
    createExecutionProjection,
    extendExecutionProjection,
    localizedEventLabel,
  } from '$lib/executionProgress.js';
  import Markdown from '$lib/Markdown.svelte';
  import { escapeMarkdownText } from '$lib/markdown.js';
  import { locale, t } from '$lib/i18n.js';
  import { messages } from '$lib/messages.js';
  import { configureModelContext, loadModelContext, modelContext } from '$lib/modelContext.js';
  import { SESSION_ENDED, sessionContext } from '$lib/sessionContext.js';
  import ShimpzThinking from '$lib/ShimpzThinking.svelte';
  import { MAX_CHAT_ASSISTANTS, refreshTeamInventory, teamContext } from '$lib/teamContext.js';
  import {
    CHAT_WS_PROTOCOL,
    authorizeAssistantIntegration,
    capabilityContinuation,
    cancelAssistantIntegrationAuthorization,
    chatSocketUrl,
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
  } from '$lib/localChat.js';


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
  let turns = $state([]);
  let nextRenderKey = 0;
  let busy = $state(false);
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

  function failProtocol(active) {
    socket = null;
    socketReady = false;
    busy = false;
    syncing = false;
    stopping = false;
    resetProgress();
    resetChallengeState();
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
  // The message of the turn in flight, and the message of a turn that just failed, which its error offers to send
  // again. Only a user message is retryable; a failed decision or a later unrelated error never offers a resend.
  let retryMessage = $state('');
  let lastSentMessage = '';
  // The seal Admin gave the send a retry repeats (ADR-0092): Admin reuses its identity and refuses an expired one. A
  // send Admin never sealed reached no Team, so its retry is simply a new send.
  let lastSentRequest = null;
  let retryRequest = null;
  let socket = $state(null);
  let socketReady = $state(false);
  let reconnectTimer;
  const lifecycleExpiryTimers = new Map();
  const lifecycleIconCaptures = new Map();
  let reconnectAttempt = 0;
  let reconnectSince = 0;
  // A Local release swap restarts Admin and Team for about half a minute, so a dropped socket keeps reconnecting with
  // a capped backoff for long enough to cover it before the page asks for a refresh. Admin refuses an expired session
  // before it accepts the upgrade, which the browser reports only as a failed connection, so a socket that never
  // opened asks Admin whether the session is still valid before the next attempt. A confirmed signed-out session
  // returns to the sign-in flow, and Admin's session refusal of an open socket is final either way.
  const RECONNECT_WINDOW_MS = 150_000;
  const MAX_RECONNECT_DELAY_MS = 10_000;
  const SESSION_PROBE_TIMEOUT_MS = 5_000;
  const SESSION_REFUSED_CLOSE_CODE = 4401;
  const sessionEnded = getContext(SESSION_ENDED);
  let sessionProbe = 0;
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
  // A message waits for a pending Brain change to be saved so the turn never runs on the previous selection.
  let brainSaving = $derived($modelContext.phase === 'saving');
  // A question answer or a retry sends at once, so it is offered only when a message could be sent now.
  let sendUnavailable = $derived(composerBusy || brainSaving || !$modelContext.ready || !socketReady);
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
  let omittedAssistantNames = $derived(
    $teamContext.omittedAssistantIds.map((id) => assistantNames.get(id) ?? id),
  );
  let liveStatus = $derived(
    lifecycleWorking
      ? installPlanWorking
        ? copy.install.working
        : copy.uninstall.working
      : currentProgress
      ? `${thinking} ${localizedEventLabel(currentProgress, copy.progress, { teamName, assistantNames })}`
      : busy ? thinking : '',
  );
  let contextLoading = $derived(
    $teamContext.phase === 'idle' || $teamContext.phase === 'loading' || historyHydrating,
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
      lifecycleDecisionPending ||
      !socketReady ||
      !socket ||
      chatTeamId !== selectedTeamId,
  );
  let visibleError = $derived(error || (contextFailed ? copy.loadFailed : ''));
  let visibleErrorDetail = $derived(error ? errorDetail : contextErrorDetail);

  // Every interface language's labels, so an answer sent in one language still closes its question in another.
  const CLARIFY_LABELS = Object.values(messages)
    .map(({ clarify }) => ({ question: clarify?.questionLabel, answer: clarify?.answerLabel }))
    .filter(({ question, answer }) => question && answer);

  // The user message each live answer projected, mapped to the assistant turn of the card it answered.
  let liveAnswers = $state(new Map());

  function answerClarification(exchange, { composed }) {
    const userKey = nextRenderKey;
    if (submitMessage(composed) && turns.at(-1)?.renderKey === userKey) {
      liveAnswers = new Map(liveAnswers).set(userKey, exchange.assistant.renderKey);
    }
  }

  // Each question is answered by at most one later message that is exactly its composed request; see the module.
  let clarificationAnswers = $derived(matchClarificationAnswers(exchanges, liveAnswers, CLARIFY_LABELS));

  // While the latest reply asks a question nobody answered, the composer waits for that answer; the card sends it.
  let questionOpen = $derived.by(() => {
    const last = exchanges.length - 1;
    return last >= 0 && clarifiedRequest(exchanges[last]) !== null && !clarificationAnswers.given.has(last);
  });
  // Files join only a message that can be written now, for the Team whose Brain is ready to receive it.
  let attachmentsUnavailable = $derived(
    composerBusy || questionOpen || brainSaving || keyRequired || !chatTeamId,
  );

  function retryLastTurn() {
    const message = retryMessage;
    if (message) submitMessage(message, { projectUserTurn: false, retryable: true, request: retryRequest });
  }

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
            ? copy.install.failed
            : copy.disconnected,
        author,
        installPlan: {
          plan_id: `history-${entry.id}`,
          state: entry.state,
          assistants: entry.assistants,
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
          ...(entry.status ? { status: entry.status } : {}),
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
      const page = await listChatHistory(fetch, teamId);
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
      const page = await listChatHistory(fetch, teamId, before);
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
      clearError();
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

  // Admin delivers Routine notices on its own schedule (ADR-0086), so while a Local Team's conversation is open and the
  // page is visible, that Team's Routine list and the history written since it was last read are re-read at a modest
  // interval and when the page becomes visible again: pages newest first, back to the newest row already read. Only
  // Routine rows merge into the transcript, by identity and version: a new row, or a newer version of a shown one,
  // moves to the end as a reload would show it. The rest of the conversation, the draft, and the reader's place stay as
  // they are; a reader already at the end follows the new row. When more was written than one refresh reads (a page
  // hidden for long), the transcript starts again from what it read, as a reload shows it, and earlier history
  // continues from where the refresh stopped, through every row written in between.
  const ROUTINE_REFRESH_MS = 15_000;
  const FOLLOW_SLACK = 48;
  let routineRefreshing = false;

  // A row is never added under a message still waiting for its reply, or while history or a turn is in motion.
  function routineMergeIdle() {
    return !composerBusy && !historyWorking && turns.at(-1)?.role !== 'user';
  }

  async function refreshRoutineNotices(teamId) {
    if (routineRefreshing || document.visibilityState !== 'visible' || chatTeamId !== teamId) return;
    routineRefreshing = true;
    const generation = historyGeneration;
    try {
      loadTeamRoutines(fetch, teamId).catch(() => {});
      if (!routineMergeIdle()) return;
      const since = await historySince(fetch, teamId, historySeen);
      if (generation !== historyGeneration || chatTeamId !== teamId || !routineMergeIdle()) return;
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
      // The next refresh tries again; the open conversation stays as it is.
    } finally {
      routineRefreshing = false;
    }
  }

  $effect(() => {
    const teamId = chatTeamId;
    if (!mounted || !teamId || $sessionContext.profile !== 'local') return;
    const refresh = () => void refreshRoutineNotices(teamId);
    const shown = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(refresh, ROUTINE_REFRESH_MS);
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
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
              ? copy.install.failed
              : incoming.state === 'stopped'
                ? copy.disconnected
                : turn.text,
          installPlan: {
            ...current,
            state: incoming.state,
            assistants: incoming.assistants,
            ...(incoming.status ? { status: incoming.status } : {}),
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

  function clearError() {
    error = '';
    errorDetail = '';
    retryMessage = '';
  }

  function setError(message, detail = '') {
    error = message;
    errorDetail = detail;
    retryMessage = '';
  }

  async function focusComposer() {
    await tick();
    if (
      !mounted ||
      !chatTeamId ||
      keyRequired ||
      composerBusy ||
      integrationsOpen ||
      document.querySelector('dialog[open], :popover-open') ||
      // Escape from a composer control returns focus to its trigger; a finished save must not take it away.
      document.activeElement?.closest('.brain-menu, .effort-menu, .fast-menu')
    ) return;
    composerInput?.focus({ preventScroll: true });
  }

  async function saveProviderKey(event) {
    event.preventDefault();
    const teamId = chatTeamId;
    const selection = keySelection;
    const apiKey = providerKey;
    providerKey = '';
    if (!teamId || !keyRequired || brainSaving || apiKey.trim().length < 16) return;
    try {
      await configureModelContext(fetch, teamId, apiKey);
    } catch {
      // The model context carries the public error shown above the composer.
      return;
    }
    if (keySelection === selection) void focusComposer();
  }

  function retryBrain() {
    const teamId = chatTeamId;
    if (!teamId || brainSaving) return;
    // A configured selection only needs its save repeated; an unreadable catalog or selection is reloaded.
    const retry = brainProvider?.configured && brainModel
      ? configureModelContext(fetch, teamId, '')
      : loadModelContext(fetch, teamId);
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

  function projectedChatError(status, detail) {
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
    sessionProbe += 1;
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

  function integrationAssistantIds(incoming) {
    return incoming.requirements.map((requirement) => requirement.assistant_id);
  }

  function knownIntegrationAssistants(incoming) {
    const selected = new Set($teamContext.activeAssistantIds);
    return integrationAssistantIds(incoming).every((id) => selected.has(id) || installedThisTurn(id));
  }

  function knownHumanAssistant(incoming) {
    const installed = new Set($teamContext.installedAssistants.map((assistant) => assistant.assistant));
    return installed.has(incoming.assistant.id) || installedThisTurn(incoming.assistant.id);
  }

  // The cached Team inventory is empty while it refreshes after an install, so an Assistant the cache does not know
  // is checked against the fresh authenticated Team inventory before the request is refused as a protocol error.
  async function admitWithFreshInventory(active, expectedTeamId, assistantIds, accept) {
    const epoch = turnEpoch;
    let installed = new Set();
    try {
      const { installedAssistants } = await refreshTeamInventory(fetch);
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
    busy = true;
    syncing = false;
    stopping = false;
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
    busy = true;
    syncing = false;
    stopping = false;
    resetProgress();
  }

  function scheduleReconnect(expectedTeamId) {
    if (reconnectTimer || !mounted || chatTeamId !== expectedTeamId) return;
    const now = performance.now();
    if (reconnectAttempt === 0) reconnectSince = now;
    if (now - reconnectSince >= RECONNECT_WINDOW_MS) {
      setError(copy.connectionFailed);
      return;
    }
    const delay = Math.min(400 * (2 ** Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (mounted && chatTeamId === expectedTeamId) connectSocket(expectedTeamId);
    }, delay);
  }

  // Only an answered session check that reports no authentication ends the reconnect loop; an unreachable or failing
  // Admin is the transient outage the loop exists to ride out.
  async function sessionSignedOut() {
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const session = await response.json();
      return session?.authenticated === false;
    } catch {
      return false;
    }
  }

  async function continueAfterSessionCheck(expectedTeamId, sessionRefused) {
    const probe = ++sessionProbe;
    const signedOut = await sessionSignedOut();
    if (probe !== sessionProbe || socket || !mounted || chatTeamId !== expectedTeamId) return;
    if (signedOut) sessionEnded();
    else if (sessionRefused) setError(copy.connectionFailed);
    else scheduleReconnect(expectedTeamId);
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
    let opened = false;

    active.onopen = () => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      opened = true;
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
        active.send(JSON.stringify(createSyncFrame(expectedTeamId, $locale)));
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
        if (incoming.type === 'sent') {
          if (!busy) throw new Error('unexpected sent frame');
          if (lastSentMessage) lastSentRequest = incoming.request;
          return;
        }
        if (incoming.type === 'progress') {
          if (!busy && !syncing) throw new Error('unexpected progress frame');
          if (incoming.seq !== progressSequence + 1) throw new Error('out-of-order progress frame');
          if (syncing) busy = true;
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
          const receipt = progressEvents.map((item) => ({ ...item }));
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
            void refreshTeamInventory(fetch).catch(() => undefined);
            if (incoming.continuation === 'none') {
              capabilityObjective = null;
              busy = false;
              clearError();
            }
            return;
          }
          busy = false;
          if (incoming.state === 'failed') {
            setError(friendlyChatError(incoming.status), `HTTP ${incoming.status}`);
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
            receipt: progressEvents.map((item) => ({ ...item })),
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
          const receipt = progressEvents.map((item) => ({ ...item }));
          if (stopping) throw new Error('unexpected Assistant lifecycle event');
          const terminal = applyLifecycleEvent(incoming, receipt);
          stopping = false;
          resetProgress();
          if (!terminal) {
            void focusLifecycleTask(incoming.proposal_id);
            return;
          }
          busy = false;
          clearError();
          if (incoming.state === 'uninstalled') {
            lifecycleOutcomePending = {
              teamId: incoming.team_id,
              proposalId: incoming.proposal_id,
              assistantId: incoming.assistant_id,
            };
            const lifecycleMessages = copy.uninstall;
            void appendUninstallOutcome(incoming)
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
        failProtocol(active);
        return;
      }

      const receipt = progressEvents.map((item) => ({ ...item }));
      // Only a turn this socket started and the user did not stop can be sent again; a terminal delivered by a
      // reconnect sync may belong to any earlier request.
      const retryable = !syncing && !stopping;
      expireSocketLifecycles();
      busy = false;
      syncing = false;
      stopping = false;
      resetChallengeState();
      clearTurnInstalled();
      const failedMessage = lastSentMessage;
      const failedRequest = lastSentRequest;
      lastSentMessage = '';
      lastSentRequest = null;
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
        }];
        clearError();
      } else if (incoming.type === 'stopped') {
        clearError();
      } else {
        const projectedError = projectedChatError(incoming.status, incoming.detail);
        setError(projectedError.message, projectedError.detail);
        // A send whose identity Admin refused as expired (410) is sent again only as a new message.
        retryMessage = retryable && incoming.status !== 410 ? failedMessage : '';
        retryRequest = failedRequest;
      }
      resetProgress();
    };
    active.onclose = (event) => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      lastSentMessage = '';
      lastSentRequest = null;
      socket = null;
      socketReady = false;
      syncing = false;
      stopping = false;
      expireSocketLifecycles();
      resetProgress();
      if (busy) busy = false;
      resetChallengeState();
      if (event.code === SESSION_REFUSED_CLOSE_CODE) {
        void continueAfterSessionCheck(expectedTeamId, true);
        return;
      }
      setError(copy.disconnected);
      if (opened) scheduleReconnect(expectedTeamId);
      else void continueAfterSessionCheck(expectedTeamId, false);
    };
  }

  function activateTeam(nextTeamId) {
    if (attachmentTeamId !== nextTeamId) clearAttachments();
    closeSocket();
    clearTurnInstalled();
    clearLifecycleIconCaptures();
    capabilityObjective = null;
    lastSentMessage = '';
    lastSentRequest = null;
    liveAnswers = new Map();
    socketTeamId = nextTeamId;
    reconnectAttempt = 0;
    stopping = false;
    lifecycleOutcomePending = null;
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
    if (nextTeamId) void hydrateHistory(nextTeamId, generation);
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
      const [integrationInventory, storedInputInventory] = await Promise.all([
        listAssistantIntegrations(fetch, teamId),
        listAssistantStoredInputs(fetch, teamId),
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
      await clearAssistantStoredInput(fetch, teamId, item.assistant_id, item.stored_input_id);
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
        reason instanceof Error ? reason.message : integrationsCopy.storedInputClearFailed,
      );
      throw reason;
    } finally {
      if (chatTeamId === teamId) storedInputWorking = '';
    }
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
        fetch,
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
    retryable = projectUserTurn,
    useCapabilityObjective = true,
    request = null,
    attached = [],
  } = {}) {
    const teamId = $teamContext.selectedTeamId;
    const normalized = message.trim();
    if (
      composerBusy ||
      brainSaving ||
      !$modelContext.ready ||
      !teamId ||
      chatTeamId !== teamId ||
      !normalized ||
      !socketReady ||
      !socket
    ) return false;
    let frame;
    let resumedObjective = '';
    const decisionPending = turns.some((turn) => turn.lifecycle?.state === 'proposed');
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
        frame = createResumeTaskFrame(teamId, currentTurn, resumable, $locale, request);
        resumedObjective = resumable.message;
        capabilityObjective = null;
      } else {
        frame = createChatFrame(teamId, currentTurn, $locale, request);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.loadFailed);
      return false;
    }
    busy = true;
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
      // A resumed task or a message sent while an uninstall awaits its decision cannot be resent as itself: the
      // objective or the proposal was consumed, so neither is ever offered again.
      // A message with attachments is never resent as text alone; its files are selected again.
      lastSentMessage = retryable && !resumable && !decisionPending && files.length === 0 ? normalized : '';
      // A resend keeps the seal it carries; a new send waits for the seal Admin returns.
      lastSentRequest = lastSentMessage ? request : null;
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

  async function submitLifecycleDecision(decision) {
    if (lifecycleDecisionPending) return false;
    lifecycleDecisionPending = true;
    try {
      const pendingUninstall = turns.findLast((turn) => (
        turn.lifecycle?.state === 'proposed'
      ))?.lifecycle;
      if (decision === 'yes' && pendingUninstall && chatTeamId) {
        await captureUninstallIcon(
          pendingUninstall.proposal_id,
          pendingUninstall.assistant.id,
          chatTeamId,
        );
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
    if (
      !['ArrowUp', 'ArrowDown'].includes(event.key) ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing
    ) return false;
    const prompts = sentPrompts();
    if (prompts.length === 0) return false;
    if (promptHistoryIndex < 0) {
      if (event.key !== 'ArrowUp' || draft !== '') return false;
      promptHistoryIndex = 0;
    } else {
      const current = prompts[prompts.length - 1 - promptHistoryIndex];
      if (draft !== current) {
        promptHistoryIndex = -1;
        return false;
      }
      if (event.key === 'ArrowUp') {
        promptHistoryIndex = Math.min(promptHistoryIndex + 1, prompts.length - 1);
      } else if (promptHistoryIndex === 0) {
        promptHistoryIndex = -1;
        draft = '';
        event.preventDefault();
        return true;
      } else {
        promptHistoryIndex -= 1;
      }
    }
    draft = prompts[prompts.length - 1 - promptHistoryIndex];
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
      mounted = false;
      historyGeneration += 1;
      closeSocket();
      clearLifecycleIconCaptures();
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
                    <p class="clarification-reply"><span class="reply-label">{$t('clarify').answered}</span>{answer}</p>
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
                      teamId={selectedTeamId}
                      teamName={assistantTurn.author}
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
                  {#if assistantTurn.usage}
                    <p class="task-usage" title={formatTaskUsageDetail(assistantTurn.usage, $locale, copy.usage)}>
                      {formatTaskUsage(assistantTurn.usage, $locale, copy.usage)}
                    </p>
                  {/if}
                  <ExecutionReceipt
                    events={assistantTurn.receipt ?? []}
                    label={copy.progressStagesExecuted}
                    progressLabels={copy.progress}
                    teamName={assistantTurn.author}
                    {assistantNames}
                  />
                  {#if assistantTurn.restricted}
                    <RestrictedActionsNote restricted={assistantTurn.restricted} {assistantNames} />
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
                />
              {/if}
            </section>
          {/each}
        </ScrollArea>

        {#if omittedAssistantNames.length > 0}
          <Notice class="assistant-overflow" variant="warning">
            {$t('chatPage.assistantOverflow', {
              limit: MAX_CHAT_ASSISTANTS,
              names: omittedAssistantNames.join(', '),
            })}
            <TextLink href={`/assistants/?team=${encodeURIComponent($teamContext.selectedTeamId)}`}>{copy.openStore}</TextLink>
          </Notice>
        {/if}
        {#if visibleError}
          <Notice class="error" variant="error">
            <strong>{visibleError}</strong>
            {#if visibleErrorDetail}<code>{copy.technicalDetail}: {visibleErrorDetail}</code>{/if}
            {#if error && retryMessage && !busy}
              <Button size="sm" variant="secondary" disabled={sendUnavailable} onclick={retryLastTurn}>{copy.retry}</Button>
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
              <Notice class="brain-error" variant="error">
                <strong>{$modelContext.error}</strong>
                {#if brainUnavailable}
                  <Button variant="secondary" size="compact" type="button" onclick={retryBrain} disabled={brainSaving}>
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
              <BrainMenu disabled={composerBusy || stopping} />
              <EffortMenu disabled={composerBusy || stopping} />
              {#if $sessionContext.profile === 'local'}
                <FastRoutingMenu disabled={composerBusy || stopping} />
              {/if}
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
                <Button type="submit" disabled={brainSaving || providerKey.trim().length < 16}>
                  {brainSaving ? keyCopy.validating : keyCopy.saveKey}
                </Button>
              {:else}
                <Button
                  class="composer-send"
                  type="submit"
                  variant="ghost"
                  disabled={composerBusy || questionOpen || brainSaving || !$modelContext.ready || !socketReady || !draft.trim() || attachmentsPending}
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

  :global(.turns) {
    position: relative;
    display: block;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* A day header sticks flush with the top edge, over this padding; an exchange scrolled to the top stays below it. */
    --chat-day-inset: -1rem;
    scroll-padding-block-start: 2rem;
    padding-block: 1rem;
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
    --routine-rail-gap: 1.1rem;
    display: grid;
    min-width: 0;
    align-content: start;
    gap: 0.65rem;
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

  .task-usage {
    margin: 0.35rem 0 0;
    color: var(--shimpz-color-text-dim);
    font: 500 0.68rem/1.4 var(--shimpz-font-mono);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  /* The time sits right after its author's name instead of across the message. */
  :global(.turns [data-slot="message-header"]) {
    justify-content: flex-start;
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
  .clarification-reply { display: grid; gap: 2px; margin: 0; }
  .reply-label {
    color: var(--shimpz-color-text-muted);
    font-family: var(--shimpz-font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .resumed-task {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.7rem;
    padding-left: 0.7rem;
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
    margin-top: 0.8rem;
  }
  .assistant-install-plan { display: grid; gap: 0.55rem; margin-top: 0.75rem; }
  .assistant-lifecycle-outcome { padding-top: 0.9rem; }

  :global(.assistant-lifecycle-task .assistant-lifecycle-detail-copy) {
    display: block;
  }

  :global(.assistant-lifecycle-task .assistant-lifecycle-provenance) {
    display: inline-block;
    padding: 0.18rem 0.42rem;
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

  :global(.brain-error) {
    display: grid;
    justify-items: start;
    gap: 0.35rem;
    font-size: 0.72rem;
  }

  :global(.error strong),
  :global(.brain-error strong),
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
    padding: 0.5rem 1rem 0;
    color: var(--shimpz-color-text-muted);
    font: 400 0.75rem/1.4 var(--shimpz-font-mono);
  }

  .message-attachments {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: 0.35rem;
    margin: 0.5rem 0 0;
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
    padding: 0.85rem 1rem 0.25rem;
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
    gap: 0.15rem;
    padding: 0.2rem 0.45rem 0.45rem;
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
    .conversation { --chat-rail-gutter: 0.6rem; }
    .composer { gap: 0.45rem; padding: 0.6rem 0; }
    :global(.composer-actions) { gap: 0.3rem; }
    .composer :global(.shimpz-button) { padding-inline: 0.65rem; }
  }
</style>
