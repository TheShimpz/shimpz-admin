<script>
  import { getContext, onMount, tick } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { readable } from 'svelte/store';
  import { Button, EmptyState, Notice, ScrollArea } from '@shimpz/frontend';
  import AssistantHumanRequestDialog from '#lib/assistants/HumanRequestDialog.svelte';
  import { MessageFiles, refuseFileDrop } from '#lib/chat/attachments/upload.svelte.js';
  import AssistantIntegrationsDialog from '#lib/assistants/IntegrationsDialog.svelte';
  import AssistantIntegrationsDrawer from '#lib/assistants/IntegrationsDrawer.svelte';
  import Composer from '#lib/chat/Composer.svelte';
  import Exchange from '#lib/chat/Exchange.svelte';
  import { UninstallLifecycle } from '#lib/chat/lifecycle/uninstall.svelte.js';
  import {
    cardAnswers,
    friendlyChatError,
    groupExchanges,
    installPlanTurns,
    projectedChatError,
    replyFields,
  } from '#lib/chat/turns.js';
  import { clarifiedRequest, matchClarificationAnswers } from '#lib/chat/clarification/compose.js';
  import { promptHistoryStep } from '#lib/chat/prompts.js';
  import ChatDay from '#lib/chat/day/Header.svelte';
  import { calendarDay, exchangeDays, turnInstants, untilNextDay } from '#lib/chat/day/calendar.js';
  import { questionWords } from '#lib/routines/words.js';
  import { adminSocket, commandsReady, openChatChannel, outcomeUnknown } from '#lib/session/socket.js';
  import {
    localizedEventLabel,
  } from '#lib/chat/progress/projection.js';
  import { escapeMarkdownText } from '#lib/chat/markdown.js';
  import { ChatTurn } from '#lib/chat/turn.svelte.js';
  import { HumanRequest } from '#lib/chat/humanRequest.svelte.js';
  import { IntegrationAuthorization } from '#lib/chat/integrationAuthorization.svelte.js';
  import { Transcript } from '#lib/chat/transcript.svelte.js';
  import { locale, t } from '#lib/i18n/index.js';
  import { INITIAL_VIEW_READINESS } from '#lib/shell/initialView.js';
  import { focusLost, focusMark, regainFocus } from '#lib/shell/focus.js';
  import { CLARIFICATION_LABELS } from '#lib/chat/clarification/labels.js';
  import { routineQuestionMessages } from '#lib/routines/questionMessages.js';
  import { configureModelContext, loadModelContext, modelContext } from '#lib/brain/context.js';
  import { sessionContext } from '#lib/session/context.js';
  import ShimpzThinking from '#lib/chat/progress/Thinking.svelte';
  import PageLoading from '#lib/shell/Loading.svelte';
  import { MAX_TEAM_ASSISTANTS, refreshTeamInventory, teamContext } from '#lib/teams/context.js';
  import { assistantName } from '#lib/assistants/names.js';
  import { ASSISTANT_LIMIT_REACHED } from '#lib/api.js';
  import { oauthReturnFailure } from '#lib/assistants/integrations.js';
  import {
    capabilityContinuation,
    createChatFrame,
    createResumeTaskFrame,
    createStopFrame,
    parseChatEvent,
  } from '#lib/chat/protocol.js';


  const booting = getContext(INITIAL_VIEW_READINESS)?.booting ?? readable(false);
  let mounted = $state(false);
  let socketTeamId = $state('');
  let draft = $state('');
  let draftTeamId = '';
  // The next message's files (ADR-0093), uploaded one at a time to the Team they were selected for.
  const messageFiles = new MessageFiles(attachmentRefusalText, () => (attachmentsUnavailable ? '' : chatTeamId));
  let attachmentInput = $state();
  // The Team's turns and the history behind them (lib/chat/transcript.svelte.js).
  const transcript = new Transcript({
    teamId: () => chatTeamId,
    mounted: () => mounted,
    team: teamOf,
    words: () => words,
    error: () => error,
    setError,
    clearError,
    loadFailed: () => copy.loadFailed,
    connect: (teamId) => connectSocket(teamId),
  });
  // An Assistant uninstall's proposal, decision, and outcome (lib/chat/lifecycle/uninstall.svelte.js).
  const uninstall = new UninstallLifecycle(transcript, {
    teamId: () => chatTeamId,
    words: () => words,
    error: () => error,
    setError,
    clearError,
    socket: () => socket,
    submit: (decision) => submitMessage(decision, {
      focusActiveTurn: false,
      projectUserTurn: false,
      useCapabilityObjective: false,
    }),
  });
  // The turn in flight, its progress, and its receipt (lib/chat/turn.svelte.js).
  const liveTurn = new ChatTurn();

  // What a connection that ended, closed or refused for a protocol violation, leaves behind: no turn, progress,
  // challenge, or lifecycle card of it stays live. A reconnect may restore another turn; one this page still waits on
  // keeps only what it observes from then on.
  function resetConnection() {
    liveTurn.forgetSegments();
    socket = null;
    socketReady = false;
    liveTurn.settle();
    uninstall.expireAll();
    liveTurn.resetProgress();
    resetChallengeState();
  }

  // A channel closed for a protocol violation attaches again, up to PROTOCOL_REATTACHES times for one Team and longer
  // apart each time, so one invalid frame never leaves the chat unable to send until a reload; past that the error
  // stays. Attaching synchronizes the Team again.
  const PROTOCOL_REATTACHES = 3;
  let protocolFailures = 0;
  let reattachTimer = 0;

  function failProtocol(active) {
    resetConnection();
    liveTurn.clearInstalled();
    setError(copy.protocolError);
    active.close(1002, 'Invalid chat event');
    if (protocolFailures >= PROTOCOL_REATTACHES) return;
    const teamId = chatTeamId;
    const wait = 1000 * 2 ** protocolFailures;
    protocolFailures += 1;
    globalThis.clearTimeout(reattachTimer);
    reattachTimer = globalThis.setTimeout(() => {
      if (mounted && chatTeamId === teamId && socket === null) connectSocket(teamId);
    }, wait);
  }

  function forgetProtocolFailures() {
    globalThis.clearTimeout(reattachTimer);
    protocolFailures = 0;
  }
  let error = $state('');
  let errorDetail = $state('');
  // The selected Team's chat channel on the Admin session socket (ADR-0114). The shell's socket reconnects on its own
  // and asks Admin whether the session still holds; the channel attaches again when it reopens, and Admin then
  // synchronizes the Team, so this page only reflects whether its channel is open.
  let socket = $state(null);
  let socketReady = $state(false);
  let integrationsOpen = $state(false);
  let integrationsButton = $state();
  // The Integration request the turn waits on and its authorization.
  const integration = new IntegrationAuthorization({
    teamId: () => chatTeamId,
    completionMode: () => $sessionContext.oauthCompletionMode,
    words: () => integrationsCopy,
    setError,
    failureDetail,
  });
  // The human request the turn waits on (ADR-0091).
  const human = new HumanRequest({
    liveTurn,
    channel: () => (socketReady ? socket : null),
    teamId: () => chatTeamId,
    locale: () => $locale,
    setError,
    clearError,
    failSend,
    expired: () => humanRequestCopy.expired,
    focusStop,
  });
  let composerInput = $state();
  let chatRoute = $state();
  let inventoryRetry = $state();
  // Whether the focus was last inside this chat (or the chat was just opened); only then may it return to the composer.
  let chatOwnsFocus = true;
  // A navigation onto this chat asked for the composer: it takes the focus as soon as it is usable, even when it is still
  // busy (reconnecting, its history being checked) at the moment the navigation ends.
  let focusWanted = $state(false);
  // A failed Brain save or retry (its selection and the focus mark of its start) that gives the focus to the notice's
  // Try again (`brainRetry`) once shown.
  let retryFocus = $state(null);
  let brainRetry = $state();
  let stopButton = $state();
  let capabilityObjective = null;
  let promptHistoryIndex = -1;
  let historySentinel = $state();

  let copy = $derived($t('chatPage'));
  // The chat's words for its transcript (chat/turns.js): its copy and the localized Assistant-limit refusal.
  let words = $derived({
    ...copy,
    limit: $t('store.assistantLimitReached', { maximum: String(MAX_TEAM_ASSISTANTS) }),
    credentialRecordInvalid: $t('shell.credentialRecordInvalid'),
  });
  let integrationsCopy = $derived($t('assistantIntegrations'));
  let humanRequestCopy = $derived($t('humanRequest'));
  // A request rendered in another language than the one selected now is never answered; a fresh one is requested.
  let humanStale = $derived(Boolean(human.challenge) && human.challenge.locale !== $locale);
  // While a reconciling sync is in flight Team may already have replaced the shown request, even after switching back.
  let humanUnanswerable = $derived(humanStale || Boolean(human.relocalizing));
  let selectedTeamId = $derived($teamContext.selectedTeamId);
  let activeTeam = $derived(teamOf(selectedTeamId) ?? null);
  // The conversation stays mounted while this Team's Brain loads, needs a key, or failed; only a send needs it ready.
  let chatTeamId = $derived(
    $modelContext.phase !== 'idle' && $modelContext.teamId === selectedTeamId ? selectedTeamId : '',
  );
  let teamName = $derived(activeTeam?.name ?? copy.title);
  let placeholder = $derived($t('chatPage.placeholder', { team: teamName }));
  // How each Routine card was answered, so a reloaded card shows its answer, never its buttons again.
  let answers = $derived(cardAnswers(transcript.turns));
  let exchanges = $derived(groupExchanges(transcript.turns, answers));
  // Each exchange's calendar day in the viewer's timezone (chat/day/calendar.js says which time an item carries); a header
  // opens each day, and "today" moves at the viewer's midnight.
  const instantOf = turnInstants();
  let today = $state(calendarDay(Date.now()));
  let days = $derived(exchangeDays(exchanges, instantOf));
  $effect(() => instantOf.retain(transcript.turns));
  let installPlanWorking = $derived(transcript.turns.some((turn) => (
    ['planned', 'installing'].includes(turn.installPlan?.state)
  )));
  let lifecycleWorking = $derived(transcript.turns.some((turn) => (
    turn.lifecycle?.state === 'working'
  )) || installPlanWorking);
  // A running turn can be stopped except while Admin synchronizes it or a lifecycle card other than an install plan
  // works; an Integration or human request pauses it.
  let stopShown = $derived(liveTurn.busy && !liveTurn.syncing && (!lifecycleWorking || installPlanWorking));
  let challengePending = $derived(Boolean(integration.challenge || human.challenge));
  let historyHydrating = $derived(
    Boolean(chatTeamId) && (transcript.loading || socketTeamId !== chatTeamId),
  );
  // A connection that is opening is about to sync, so the composer stays read-only from the history load through the
  // first sync instead of accepting text for a moment and dropping what is typed when the sync starts.
  let socketOpening = $derived(Boolean(socket) && !socketReady);
  let composerBusy = $derived(
    liveTurn.busy || liveTurn.syncing || socketOpening || uninstall.outcomePending !== null || historyHydrating || transcript.checking,
  );
  // The Brain and fast-routing menus stay open while Admin reconnects, so a change they sent can say how it ended; what
  // they would send waits for the connection on its own.
  let menusBusy = $derived(
    liveTurn.busy || liveTurn.syncing || uninstall.outcomePending !== null || historyHydrating || liveTurn.stopping,
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
  let currentProgress = $derived(liveTurn.events.at(-1));
  let liveStatus = $derived(
    lifecycleWorking
      ? installPlanWorking
        ? copy.install.working
        : copy.uninstall.working
      : currentProgress
      ? `${copy.sending} ${localizedEventLabel(currentProgress, copy.progress, { assistantName: $assistantName })}`
      : liveTurn.busy ? copy.sending : '',
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
      liveTurn.stopping ||
      uninstall.decisionPending ||
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
    const userKey = transcript.nextKey;
    if (submitMessage(composed) && transcript.turns.at(-1)?.renderKey === userKey) {
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

  // A row is never added while history or a turn is in motion, so never under a message still waiting for its reply:
  // a turn is busy from its send on. A message whose turn ended without a reply (stopped or failed) waits for nothing.
  function routineMergeIdle() {
    return !composerBusy && !transcript.working;
  }

  // What the head read while the conversation was in motion is applied, in order, once it is idle again.
  $effect(() => {
    const teamId = chatTeamId;
    if (transcript.waiting && teamId && !historyHydrating && routineMergeIdle()) {
      void transcript.drain(teamId, () => chatTeamId === teamId && !historyHydrating && routineMergeIdle());
    }
  });

  $effect(() => {
    void today;
    const timer = setTimeout(() => (today = calendarDay(Date.now())), untilNextDay(Date.now()) + 1_000);
    return () => clearTimeout(timer);
  });

  // A plan's frame adds or updates its turn; a new turn takes the next render identity.
  function applyInstallPlanEvent(incoming, receipt) {
    transcript.extend((key) => installPlanTurns(transcript.turns, incoming, receipt, key, words));
  }

  // A listed Team by its id.
  function teamOf(teamId) {
    return $teamContext.teams.find((entry) => entry.id === teamId);
  }

  function clearError() {
    error = '';
    errorDetail = '';
  }

  function setError(message, detail = '') {
    error = message;
    errorDetail = detail;
  }

  // A frame the channel could not take: the error says why, and the channel is closed.
  function failSend(reason) {
    setError(reason instanceof Error ? reason.message : copy.loadFailed);
    socket.close();
  }

  // The composer takes the focus back only when the chat owned it and the control holding it went away (a Stop that
  // became Send, a composer that turned read-only while reconnecting): focus in another region, or on a control the
  // Supervisor chose, stays where it is.
  async function focusComposer() {
    await tick();
    if (
      !mounted ||
      !chatTeamId ||
      keyRequired ||
      composerBusy ||
      integrationsOpen ||
      inventoryRetrying ||
      !chatOwnsFocus ||
      !focusLost() ||
      document.querySelector('dialog[open], :popover-open')
    ) return;
    focusWanted = false;
    composerInput?.focus({ preventScroll: true });
  }

  // A navigation (opening a Team from the Team list, or coming back from the Store) puts the focus on the body; that is
  // nobody taking it, so the composer still takes it once usable.
  function trackFocus(event) {
    if (event.target === document.body) return;
    chatOwnsFocus = Boolean(chatRoute?.contains(event.target));
    // The person moved the focus themselves: the navigation's request for the composer lapses.
    if (event.target !== composerInput) focusWanted = false;
  }

  // Every navigation that lands on this chat, its own Team's link clicked again included, leaves the focus on the body
  // once it completes: the composer takes it as soon as it is usable.
  afterNavigate(() => {
    chatOwnsFocus = true;
    focusWanted = true;
  });


  async function saveProviderKey(event) {
    event.preventDefault();
    const teamId = chatTeamId;
    const selection = keySelection;
    const apiKey = providerKey;
    // While Admin reconnects the key stays in its field, unsent, until it can be saved.
    if (!teamId || !keyRequired || brainSaving || !$commandsReady || apiKey.trim().length < 16) return;
    providerKey = '';
    retryFocus = null;
    const mark = focusMark();
    try {
      await configureModelContext(teamId, apiKey);
    } catch {
      // The model context carries the public error shown above the composer. The save disabled the key field, which
      // dropped the focus to the document: the emptied field takes it back for the same Team and provider, unless the
      // person moved it or pressed elsewhere meanwhile. A key that was saved takes the field away once the selection
      // is read again, and the Brain notice's Try again takes the focus then.
      if (focusMark() !== mark) return;
      await regainFocus(() => document.getElementById('chat-provider-key'), {
        shown: () => keySelection === selection && keyRequired,
        since: mark,
        preventScroll: true,
      });
      retryFocus = { selection, since: focusMark() };
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
      await (uninstall.retry(chatTeamId) ?? refreshTeamInventory().catch(() => {}));
      await tick();
    } finally {
      inventoryRetrying = false;
    }
    if (!focusLost()) return;
    if ($teamContext.inventory === 'ready') void focusComposer();
    else inventoryRetry?.focus();
  }

  // The earlier history's Retry leaves while the page is read again, so the focus it held comes back: to the new Retry
  // when the read fails again, to the composer once it succeeds, both for the same Team. Focus the person moved or
  // pressed elsewhere meanwhile stays where it is.
  let olderRetry = $state();

  async function retryOlder() {
    const teamId = chatTeamId;
    const since = focusMark();
    await transcript.retryOlder();
    if (chatTeamId !== teamId) return;
    if (transcript.olderFailed) await regainFocus(() => olderRetry, { since });
    else if (focusMark() === since) void focusComposer();
  }

  function retryBrain() {
    const teamId = chatTeamId;
    if (!teamId || brainSaving || !$commandsReady) return;
    retryFocus = null;
    // A configured selection only needs its save repeated; an unreadable catalog or selection is reloaded.
    const selection = keySelection;
    const since = focusMark();
    const retry = brainProvider?.configured && brainModel
      ? configureModelContext(teamId, '')
      : loadModelContext(teamId);
    retry.catch(() => {
      retryFocus = { selection, since };
    });
  }

  // A Brain save or retry that failed took its notice, and the focus with it, while it ran: once the reads after it
  // show the notice again, its Try again takes the focus for the same Team and provider, unless the person moved the
  // focus or pressed elsewhere since the request began.
  $effect(() => {
    if (!retryFocus || !brainRetry) return;
    const { selection, since } = retryFocus;
    retryFocus = null;
    void regainFocus(() => brainRetry, {
      shown: () => mounted && keySelection === selection,
      since,
      preventScroll: true,
    });
  });

  async function focusStop(fromElement) {
    await tick();
    if (fromElement && document.activeElement !== fromElement) return;
    if (mounted && stopShown && !challengePending) {
      stopButton?.focus({ preventScroll: true });
    }
  }

  async function focusLifecycleTask(proposalId) {
    await tick();
    if (!mounted || !liveTurn.busy || !lifecycleWorking) return;
    document.getElementById(`assistant-lifecycle-${proposalId}`)?.focus({ preventScroll: true });
  }

  function resetChallengeState() {
    integration.reset();
    human.reset();
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    socketReady = false;
    liveTurn.syncing = false;
    uninstall.expireAll();
    liveTurn.resetProgress();
    resetChallengeState();
    current?.close(1000, 'Team changed');
  }

  function integrationAssistantIds(incoming) {
    return incoming.requirements.map((requirement) => requirement.assistant_id);
  }

  // Only a settled inventory admits an Assistant's request at once; one being read again is checked when it arrives.
  function knownIntegrationAssistants(incoming) {
    const selected = new Set(inventoryReady ? $teamContext.activeAssistantIds : []);
    return integrationAssistantIds(incoming).every((id) => selected.has(id) || liveTurn.installedIn(chatTeamId, id));
  }

  function knownHumanAssistant(incoming) {
    const installed = new Set(
      inventoryReady ? $teamContext.installedAssistants.map((assistant) => assistant.assistant) : [],
    );
    return installed.has(incoming.assistant.id) || liveTurn.installedIn(chatTeamId, incoming.assistant.id);
  }

  // The cached Team inventory may be one being read again (after an install, for instance), so an Assistant it does
  // not admit is checked against the fresh authenticated Team inventory before the request is refused as a protocol
  // error.
  async function admitWithFreshInventory(active, expectedTeamId, assistantIds, accept) {
    const epoch = liveTurn.epoch;
    let installed = new Set();
    try {
      const { installedAssistants } = await refreshTeamInventory();
      installed = new Set(installedAssistants.map((assistant) => assistant.assistant));
    } catch {
      installed = new Set();
    }
    if (socket !== active || chatTeamId !== expectedTeamId || epoch !== liveTurn.epoch) return;
    if (assistantIds.every((id) => installed.has(id) || liveTurn.installedIn(chatTeamId, id))) accept();
    else failProtocol(active);
  }

  function acceptIntegrationChallenge(incoming) {
    uninstall.expireAll();
    integration.accept(incoming);
    human.dismiss();
    integrationsOpen = false;
    liveTurn.pause();
  }

  function acceptHumanChallenge(incoming) {
    uninstall.expireAll();
    human.accept(incoming);
    integrationsOpen = false;
    liveTurn.pause();
  }

  // Each chat frame that is not a turn's terminal answer, and its handler. A handler throws on a frame the turn does not
  // admit, and the channel then fails as a protocol violation.
  const FRAME_HANDLERS = new Map([
    ['integrations-required', integrationsRequired],
    ['human-required', humanRequired],
    ['human-response-rejected', (incoming) => human.rejected(incoming)],
    ['progress', progressFrame],
    ['running', runningFrame],
    ['sync-empty', syncEmpty],
    ['assistant-install-plan', installPlanFrame],
    ['assistant-guidance', guidanceFrame],
    ['assistant-uninstall', uninstallFrame],
  ]);

  // An Integration request: admitted once every Assistant it names is in the Team's inventory.
  function integrationsRequired(challenge, active, expectedTeamId) {
    if (knownIntegrationAssistants(challenge)) acceptIntegrationChallenge(challenge);
    else {
      void admitWithFreshInventory(active, expectedTeamId, integrationAssistantIds(challenge), () => (
        acceptIntegrationChallenge(challenge)
      ));
    }
  }

  // A human request: admitted once its Assistant is in the Team's inventory, in the language a reconciling sync named.
  function humanRequired(challenge, active, expectedTeamId) {
    human.admitLocale(challenge);
    if (knownHumanAssistant(challenge)) acceptHumanChallenge(challenge);
    else {
      void admitWithFreshInventory(active, expectedTeamId, [challenge.assistant.id], () => (
        acceptHumanChallenge(challenge)
      ));
    }
  }

  // Team's progress of the turn; the first after a human answer ends that request.
  function progressFrame(incoming) {
    liveTurn.progress(incoming);
    human.progressed();
  }

  // Where the Team's chat is (ADR-0119): a turn this page attached to while it works, or one waiting for the Space's
  // chat gate. The message it answers is shown, so it no longer reads as unfinished.
  function runningFrame(incoming) {
    liveTurn.restore(incoming);
    transcript.clearUnfinished();
  }

  // Admin synchronized the Team and nothing is pending: a turn this page still waited on ended while the page could
  // not watch it, so its ending is read from the history, as a reload shows it (ADR-0119).
  function syncEmpty() {
    liveTurn.syncing = false;
    liveTurn.forgetSegments();
    liveTurn.resetProgress();
    liveTurn.clearInstalled();
    // A request that ended before it could be opened in the selected language, one that expired, or a turn that ended
    // without its reply: nothing of it stays live.
    let failure;
    if (human.relocalizing) failure = humanRequestCopy.expired;
    else if (human.expiredId) failure = '';
    else if (liveTurn.busy && transcript.turns.length > 0) {
      failure = '';
      transcript.resync();
    } else return;
    liveTurn.settle();
    resetChallengeState();
    if (failure) setError(failure);
  }

  // An install plan of the turn; an installed plan that continues keeps the turn running.
  function installPlanFrame(incoming) {
    liveTurn.requireRunning('Assistant install plan event');
    const receipt = liveTurn.receipt();
    applyInstallPlanEvent(incoming, receipt);
    const restoreStoppedFocus = liveTurn.stopping && focusLost();
    liveTurn.stopping = false;
    liveTurn.resetProgress();
    if (restoreStoppedFocus) void focusStop();
    if (incoming.state === 'planned' || incoming.state === 'installing') {
      return;
    }
    if (incoming.state === 'installed') {
      if (incoming.continuation === 'dispatch') {
        liveTurn.addInstalled(chatTeamId, incoming.assistants.map((assistant) => assistant.id));
      }
      void refreshTeamInventory().catch(() => undefined);
      if (incoming.continuation === 'none') {
        capabilityObjective = null;
        liveTurn.busy = false;
        clearError();
      }
      return;
    }
    liveTurn.busy = false;
    if (incoming.state === 'failed') {
      setError(
        incoming.code === ASSISTANT_LIMIT_REACHED ? words.limit : friendlyChatError(incoming.status, words),
        `HTTP ${incoming.status}`,
      );
    } else {
      clearError();
    }
  }

  // Guidance that ends the turn with a reply of its own.
  function guidanceFrame(incoming) {
    liveTurn.requireRunning('Assistant guidance event');
    capabilityObjective = null;
    transcript.append({
      role: 'assistant',
      text: escapeMarkdownText(incoming.reply),
      author: incoming.team_name,
      receipt: liveTurn.receipt(),
    });
    liveTurn.settle();
    liveTurn.resetProgress();
    clearError();
    void transcript.reveal();
  }

  // An uninstall proposal or its outcome; only an outcome ends the turn.
  function uninstallFrame(incoming) {
    liveTurn.requireRunning('Assistant lifecycle event');
    capabilityObjective = null;
    const receipt = liveTurn.receipt();
    // A Stop may cross a proposal or the uninstall it approved; Admin answers that Stop with nothing, so the
    // lifecycle event is applied as it is and ends the stop.
    const terminal = uninstall.apply(incoming, receipt);
    liveTurn.stopping = false;
    liveTurn.resetProgress();
    if (!terminal) {
      void focusLifecycleTask(incoming.proposal_id);
      return;
    }
    liveTurn.busy = false;
    clearError();
    if (incoming.state === 'uninstalled') void uninstall.confirm(incoming);
  }

  // The turn's terminal answer: its reply, its stop, or its failure.
  function endTurn(incoming) {
    const receipt = liveTurn.receipt();
    uninstall.expireAll();
    liveTurn.settle();
    resetChallengeState();
    liveTurn.clearInstalled();
    if (incoming.type === 'done') {
      transcript.append({
        role: 'assistant',
        text: incoming.reply,
        author: incoming.team_name,
        receipt,
        ...replyFields(incoming),
      });
      clearError();
    } else if (incoming.type === 'stopped') {
      clearError();
    } else {
      const projectedError = projectedChatError(incoming.status, incoming.detail, words);
      setError(projectedError.message, projectedError.detail);
    }
    liveTurn.resetProgress();
  }

  function connectSocket(expectedTeamId) {
    closeSocket();
    if (!mounted || !expectedTeamId || chatTeamId !== expectedTeamId) return;

    const expectedTeam = teamOf(expectedTeamId);
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
      liveTurn.syncing = true;
      liveTurn.resetProgress();
      if (error === copy.disconnected || error === copy.connectionFailed) clearError();
    };
    active.onframe = (frame) => {
      if (socket !== active || chatTeamId !== expectedTeamId) return;
      let incoming;
      try {
        incoming = parseChatEvent(frame, expectedTeam.id, expectedTeam.name);
        const handle = FRAME_HANDLERS.get(incoming.type);
        if (handle) {
          handle(incoming, active, expectedTeamId);
          return;
        }
        liveTurn.requireTerminal();
      } catch {
        failProtocol(active);
        return;
      }
      endTurn(incoming);
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
    forgetProtocolFailures();
    chatOwnsFocus = true;
    liveTurn.forgetSegments();
    if (messageFiles.teamId !== nextTeamId) messageFiles.clear();
    // Closing the socket already ended the old Team's progress, challenges, and lifecycle cards.
    closeSocket();
    liveTurn.settle();
    liveTurn.clearInstalled();
    uninstall.forgetIcons();
    capabilityObjective = null;
    liveAnswers = new Map();
    socketTeamId = nextTeamId;
    uninstall.reset();
    if (nextTeamId && draftTeamId && draftTeamId !== nextTeamId) draft = '';
    if (nextTeamId) draftTeamId = nextTeamId;
    promptHistoryIndex = -1;
    integrationsOpen = false;
    clearError();
    transcript.open(nextTeamId);
  }

  function closeIntegrations() {
    integrationsOpen = false;
    queueMicrotask(() => integrationsButton?.focus());
  }

  // A failure's detail: a change Admin never confirmed before it disconnected may or may not have happened.
  function failureDetail(reason, fallback) {
    if (outcomeUnknown(reason)) return $t('shell.outcomeUnknown');
    return reason instanceof Error ? reason.message : fallback;
  }

  function toggleIntegrations() {
    integrationsOpen = !integrationsOpen;
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

  function chooseAttachments() {
    attachmentInput?.click();
  }

  // A Routine card's edited prompt, sent only into the conversation of the card's own Team: a page that moved to another
  // Team meanwhile sends nothing, and the card keeps the text.
  function rewriteRoutine(message, teamId) {
    if (teamId !== $teamContext.selectedTeamId || chatTeamId !== teamId) return false;
    return submitMessage(message);
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
    liveTurn.clearInstalled();
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
    liveTurn.begin();
    liveTurn.forgetSegments();
    liveTurn.resetProgress();
    clearError();
    if (projectUserTurn) {
      transcript.append({
        role: 'user',
        text: normalized,
        ...(resumedObjective ? { resumedObjective } : {}),
        ...(files.length
          ? {
            files: attached.map(({ key, id, name, mediaType, size, kind, note }) => (
              { key, id, name, mediaType, size, kind, note }
            )),
          }
          : {}),
      });
      void transcript.reveal();
    }
    try {
      socket.send(frame);
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
      liveTurn.busy = false;
      liveTurn.resetProgress();
      failSend(reason);
      return false;
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
    return transcript.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
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
    if (!liveTurn.busy || liveTurn.syncing || liveTurn.stopping || !teamId || !socketReady || !socket) return;
    liveTurn.stopping = true;
    clearError();
    try {
      socket.send(createStopFrame(teamId));
    } catch (reason) {
      liveTurn.stopping = false;
      failSend(reason);
    }
  }

  $effect(() => {
    const selected = $locale;
    if (!humanStale || human.working || human.relocalizing || liveTurn.syncing || !socketReady || !socket) return;
    if (human.challenge.challenge_id === human.expiredId) return;
    human.relocalize(selected);
  });

  $effect(() => {
    const nextTeamId = chatTeamId;
    if (!mounted || nextTeamId === socketTeamId) return;
    activateTeam(nextTeamId);
  });

  // The composer takes the focus whenever it turns usable, and again when a navigation asks for it (`focusWanted`).
  $effect(() => {
    void focusWanted;
    if (mounted && chatTeamId && $modelContext.ready && !composerBusy && !integrationsOpen) void focusComposer();
  });

  // A fresh observer after every load reports whether the top is still in view, so a short page keeps filling.
  $effect(() => {
    const sentinel = historySentinel;
    const root = transcript.viewport;
    if (!transcript.olderArmed || transcript.olderFailed || transcript.working || !sentinel || !root) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void transcript.loadOlder();
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
    const oauthFailedOnReturn = oauthReturnFailure(location.href);
    const initialTeamId = chatTeamId;
    if (initialTeamId !== socketTeamId) activateTeam(initialTeamId);
    else transcript.loading = false;
    if (oauthFailedOnReturn) {
      history.replaceState(history.state, '', '/chat');
      setError(integrationsCopy.authorizationFailed);
    }
    return () => {
      document.removeEventListener('focusin', trackFocus);
      forgetProtocolFailures();
      mounted = false;
      transcript.close();
      closeSocket();
      uninstall.forgetIcons();
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
          class:empty-conversation={transcript.turns.length === 0}
          aria-label={teamName}
          aria-busy={composerBusy && !challengePending}
          inert={historyHydrating}
        >
        <p class="live-status sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
        {#if transcript.before && !transcript.olderFailed}
          <p id="chat-history-hint" class="sr-only">{copy.olderHint}</p>
        {/if}
        <ScrollArea
          class="turns"
          bind:element={transcript.viewport}
          aria-describedby={transcript.before && !transcript.olderFailed ? 'chat-history-hint' : undefined}
        >
          {#if transcript.before}
            <div class="history-older" bind:this={historySentinel}>
              {#if transcript.olderFailed}
                <Button
                  variant="ghost"
                  size="compact"
                  type="button"
                  bind:element={olderRetry}
                  onclick={retryOlder}
                >
                  {copy.olderMessages}
                </Button>
              {:else if transcript.working}
                <p class="history-older-status" role="status">{copy.olderLoading}</p>
              {/if}
            </div>
          {/if}
          <!-- The turn in flight's live progress, shown after its exchange. -->
          {#snippet liveThinking()}
            <ShimpzThinking
              label={copy.sending}
              steps={liveTurn.projection.steps}
              currentIndex={liveTurn.projection.currentIndex}
              elapsedText={copy.elapsed}
              progressLabels={copy.progress}
              startedAt={liveTurn.startedAt}
              queuePosition={liveTurn.position}
              teamId={chatTeamId}
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
              sentAnswer={clarificationAnswers.sent.get(index) ?? null}
              givenAnswer={clarificationAnswers.given.get(index) ?? null}
              answerDisabled={sendUnavailable}
              lifecycleDisabled={lifecycleDecisionDisabled}
              onanswer={(answer) => answerClarification(exchange, answer)}
              onrewrite={rewriteRoutine}
              onleave={focusComposer}
              cardAnswer={answers.get(exchange.assistant?.routineProposal?.proposal_id) ?? ''}
              unfinishedShown={socketReady && !liveTurn.syncing && !liveTurn.busy}
              ondecide={uninstall.decide}
              thinking={index === exchanges.length - 1 && liveTurn.busy && !challengePending &&
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
            teamId={chatTeamId}
            files={messageFiles}
            bind:draft
            bind:providerKey
            bind:composerInput
            bind:attachmentInput
            bind:integrationsButton
            bind:stopButton
            bind:retryButton={brainRetry}
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
            integrationsDisabled={$teamContext.installedAssistants.length === 0 && !integration.challenge}
            {stopShown}
            stopping={liveTurn.stopping}
            {sendUnavailable}
            {socketReady}
            onsubmit={keyRequired ? saveProviderKey : send}
            ondrag={messageFiles.dragOver}
            ondragleave={messageFiles.dragLeave}
            ondrop={messageFiles.drop}
            onretrybrain={retryBrain}
            onkeydown={handleComposerKeydown}
            onpaste={messageFiles.paste}
            oncancelfiles={cancelAttachmentUploads}
            onremovefile={removeAttachment}
            onchoose={chooseAttachments}
            onfileschosen={messageFiles.chosen}
            ontoggleintegrations={toggleIntegrations}
            onstop={stop}
          />
        </section>
        <AssistantIntegrationsDrawer
          open={integrationsOpen}
          teamId={chatTeamId}
          pending={integration.challenge}
          authorizing={integration.working}
          onclose={closeIntegrations}
          onconnect={integration.authorize}
          onerror={setError}
        />
        <AssistantIntegrationsDialog
          open={integration.dialogOpen}
          challenge={integration.challenge}
          installedAssistants={$teamContext.installedAssistants}
          onclose={() => (integration.dialogOpen = false)}
          onauthorize={integration.authorize}
          oncomplete={integration.complete}
          oncancel={integration.cancel}
        />
        <AssistantHumanRequestDialog
          open={human.open}
          challenge={human.challenge}
          rejection={human.rejection}
          working={human.working || humanUnanswerable}
          onrespond={(response) => { if (!humanUnanswerable) human.respond(response); }}
          onretry={() => human.retry()}
          onexpire={(challengeId) => human.expire(challengeId)}
        />
        {#if historyHydrating}
          <section class="history-loading">
            <PageLoading label={copy.loading} />
          </section>
        {/if}
      </div>
    {:else}
      <section class="empty-state">
        <PageLoading label={copy.loading} />
      </section>
    {/if}
  {:else if teamsKnownEmpty || contextFailed || visibleError}
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
  {:else}
    <section class="empty-state">
      <PageLoading label={copy.loading} />
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
    border-radius: 0;
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
    border-radius: 0;
    color: var(--text-faint);
    overflow: auto;
  }

  @media (max-width: 640px) {
    :global(.turns .shimpz-message--user) { max-width: 92%; }
  }
</style>
