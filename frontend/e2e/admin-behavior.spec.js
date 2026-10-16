import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';
import { assistantDetails, PAGE_COPY } from './assistantPages.js';

import { messages } from '../src/lib/i18n/catalogs.js';
import { accessibilityViolations } from './axe.js';
import { sendMessage, switchLanguage } from './interaction.js';
import { localizedChallenge } from './localizedRequest.js';

import {
  activityReports,
  dropSessions,
  raiseTopic,
  readsOf,
  routeChat,
  routeConnect,
  routeRead,
  routeScenario,
  nextRead,
  waitForRead,
} from './scenarioRoutes.js';
import {
  CARD_SETTINGS, diagnostic, httpFailure, noticeRow, planPage, planSummary, ROUTINE_TEXT, routineChallenge,
  routineLifecycleStart, runStepsPage,
} from './routineScenarios.js';
import { outputChoiceWords, proposalRequest, proposalWhen } from '../src/lib/routines/words.js';
import {
  authenticatedLocalSession,
  historyView,
  localSession,
  CLARIFICATION as SCENARIO_CLARIFICATION,
  ROUTINE_PLAN,
  ROUTINE_VIEW,
} from './scenarios.js';

const ok = (json, status = 200) => ({ status, json });

// Admin learned that Marketing's Routines and history changed (a run ended, a notice was written) and says so on the
// session socket (ADR-0114), so the page reads both again.
async function routineNotice(page) {
  await raiseTopic(page, 'team/marketing/routines');
  await raiseTopic(page, 'team/marketing/history');
}

// Every stored chat history row carries the UTC time Admin wrote it.
const HISTORY_AT = '2026-10-01T12:00:00Z';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/brain/catalog.json', import.meta.url), 'utf8'),
);

const localTeamResidues = [
  'action_checkpoints',
  'assistant_containers',
  'brain_checkpoints',
  'chat_continuations',
  'egress_policies',
  'inference_configuration',
  'integration_credentials',
  'publication_bindings',
  'runtime_state',
  'team_names',
  'team_networks',
  'team_storage',
];

async function routeSetup(page) {
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(localSession()),
  }));
}

async function routeAssistantStoreUninstall(page) {
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.1',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
        ...structuredClone(PAGE_COPY),
      }],
    } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: { assistants: [], trace_id: 'c'.repeat(32) } }));
  await routeRead(page, 'assistants.details', (params) => (
    params.team_id === 'marketing' && params.assistant_id === 'shimpz-cloudflare' && params.locale === 'en'
      ? { status: 200, json: assistantDetails({ assistant_version: '0.4.1' }) }
      : undefined
  ));
}

function humanRequest(kind) {
  const base = {
    kind,
    ordinal: 0,
    title: {
      approval: 'Publish reviewed DNS changes?',
      'auth:password': 'Confirm with your Supervisor password',
    }[kind] ?? 'Provide the missing Action context',
    description: 'Shimpz Cloudflare paused before continuing this exact Action.',
    fingerprint: 'c'.repeat(64),
  };
  if (['input:text', 'input:textarea', 'input:password', 'input:phone'].includes(kind)) {
    return {
      ...base,
      label: kind === 'input:password' ? 'Cloudflare API secret' : kind === 'input:phone' ? 'Contact phone' : 'Response',
      required: true,
      placeholder: kind === 'input:phone' ? '+1 415 555 0123' : 'Enter the reviewed value',
      min_length: 1,
      max_length: kind === 'input:textarea' ? 16_000 : kind === 'input:password' ? 128 : 64,
      // A password request always names the Stored Input Team keeps it as (ADR-0106).
      ...(kind === 'input:password' ? { stored_input: 'cloudflare-token' } : {}),
    };
  }
  const options = [
    { value: 'safe', label: 'Safe mode', description: 'Review every DNS change.' },
    { value: 'fast', label: 'Fast mode', description: 'Apply the complete reviewed batch.' },
  ];
  if (['input:select', 'input:choice'].includes(kind)) {
    return { ...base, label: 'Execution mode', required: true, options };
  }
  if (kind === 'input:choices') {
    return { ...base, label: 'Zones', required: true, options, min_selections: 1, max_selections: 2 };
  }
  return base;
}

// The composer accepts text only once the Team's history, connection, and first sync are ready, and then keeps it.
// The page's clock stands still a minute after `time`, before any page loads, until the test moves it: an expiry or a
// budget then depends only on the test's own clock steps, never on how fast this runner acts on a loaded host. The
// installed clock runs until the pause, so the pause leaves it ample room to still be ahead.
async function freezeClock(page, time = new Date()) {
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 60_000));
}

async function fillWhenReady(page, composer, message) {
  await composer.fill(message);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
}

// Drive the composer without the person: the value and the clicks are the page's own events, never trusted input, so a
// test can prove what the page does on its own never reports the person's activity (ADR-0114).
async function sendUntrusted(page, message) {
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.evaluate((field, value) => {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, message);
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled();
  await send.dispatchEvent('click');
}

async function openTeamNavigation(page) {
  if (page.viewportSize().width <= 820) {
    await page.getByRole('button', { name: 'Open the Team list' }).click();
    return page.getByRole('dialog', { name: 'Teams' });
  }
  return page.locator('.shell-sidebar');
}

// Each installed Assistant's summary per interface language, as Team reads it from the binding's pack (ADR-0091).
const INSTALLED_SUMMARIES = {
  'shimpz-cloudflare': {
    en: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
    pt: 'Inspeciona zonas do Cloudflare e gerencia registros DNS comuns por OAuth.',
  },
  'shimpz-slack': { en: 'Send reviewed messages to Slack.' },
};

async function routeReadyChat(page, {
  assistantPlan = false,
  alreadyInstalledResult = false,
  alreadyInstalledContinuation = 'none',
  storedInputAfterPlan = false,
  progressAfterPlan = false,
  assistantPlanContinuation = 'dispatch',
  holdAssistantPlan = false,
  holdStop = false,
  holdAssistantIcon = false,
  assistantSummary = 'Safely manage Cloudflare DNS records through OAuth.',
  assistantUninstall = false,
  assistantGuidanceCode = '',
  assistantGuidanceReply = '',
  holdTargetlessUninstallGuidance = false,
  assistantUninstallWasRemoved = true,
  failUninstallDecision = false,
  holdAssistantUninstall = false,
  holdUninstallProposal = false,
  holdAssistantInventoryRefresh = false,
  holdPostInstallInventory = false,
  disconnectHumanResponse = false,
  disconnectFirstChat = false,
  refusedReconnects = 0,
  adminDownRefusals = 0,
  expireSessionOnDisconnect = false,
  expireSessionOnFirstChat = false,
  holdHumanResponse = false,
  humanKind = '',
  humanAssistantId = 'shimpz-cloudflare',
  humanStoredInput = '',
  humanPurpose = '',
  // Team always sends a Stored Input request's help text and help link (ADR-0090); other requests carry neither.
  humanHelp = 'Create an API key in the Exa dashboard and copy it.',
  humanHelpUrl = 'https://dashboard.exa.ai/api-keys',
  humanExpiresIn = 300,
  // Team renders a request in the turn's interface language (ADR-0091); this fixture keeps its English copy.
  humanLocale = 'en',
  redeliverExpiredHuman = false,
  humanRejections = [],
  integrationChallenge = false,
  integrationStatus = 'connected',
  integrationRequirements,
  missingInference = false,
  holdInferenceWrite = false,
  unconfiguredProviders = [],
  failInferenceWrite = false,
  multipleIntegrations = false,
  oauthCompletionMode = 'automatic',
  holdReply = false,
  holdProgressStart = false,
  holdProgressFinish = false,
  invalidProgressSequence = false,
  terminalError = false,
  terminalDetail = 'synthetic runtime failure',
  whatsappInstalled = false,
  omitPlannedWhatsappFromInventory = false,
  storedInputStatus = '',
  historyStatus = 200,
  holdHistory = false,
  history = { entries: [], before: null },
  olderHistory = null,
  rejectDecisionKey = false,
  clarification = null,
  // A second Team, Support, with no Assistants and an empty conversation, for switching away from Marketing.
  secondTeam = false,
  reply,
  usage,
} = {}) {
  let inferenceWrites = 0;
  const decisionRequests = [];
  let decisionMasked = null;
  const inferenceBodies = [];
  const credentialBodies = [];
  const configuredProviders = new Set(
    modelCatalog.providers.map((provider) => provider.id).filter((id) => !unconfiguredProviders.includes(id)),
  );
  const humanResponses = [];
  let chatConnections = 0;
  let disconnectHumanSocket = () => {};
  let releaseHumanResponse = () => {};
  let humanPending = false;
  let humanRejectionIndex = 0;
  let syncFrames = 0;
  let expiredHumanRedelivered = false;
  let firstChatDisconnected = false;
  let reconnectsRefused = 0;
  let sessionExpired = false;
  let storedInputClears = 0;
  let assistantInstalled = assistantUninstall || !assistantPlan;
  let cloudflareInstalled = assistantInstalled;
  let uninstallProposed = false;
  let targetlessGuidanceSent = false;
  let targetlessGuidancePending = false;
  let advanceAssistantPlan = () => {};
  let completeAssistantPlan = () => {};
  let releaseAssistantPlan = () => {};
  let releaseAssistantUninstall = () => {};
  let releaseUninstallProposal = () => {};
  let releaseReply = () => {};
  let releaseProgressStart = () => {};
  let releaseProgressFinish = () => {};
  let sendProgressEvent = () => {};
  let closeChatSocket = () => {};
  let releaseInferenceWrite;
  const inferenceWriteHold = new Promise((resolve) => {
    releaseInferenceWrite = resolve;
  });
  let releaseAssistantInventory;
  const assistantInventoryHold = new Promise((resolve) => {
    releaseAssistantInventory = resolve;
  });
  let releaseAssistantIcon;
  const assistantIconHold = new Promise((resolve) => {
    releaseAssistantIcon = resolve;
  });
  let releaseHistory;
  const historyHold = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  const chatFrames = [];
  const assistantIconRequests = [];
  const historyRequests = [];
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => {
    // While Admin itself restarts, its session check is unreachable too.
    if (firstChatDisconnected && reconnectsRefused < adminDownRefusals) return route.abort('connectionrefused');
    if ((firstChatDisconnected && expireSessionOnDisconnect) || sessionExpired) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: oauthCompletionMode })),
    });
  });
  await routeRead(page, 'teams.list', () => ok({ teams: [
    { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
    ...(secondTeam ? [{ team_id: 'support', team_name: 'Support', status: 'running' }] : []),
  ] }));
  const supportFrames = [];
  if (secondTeam) {
    await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'support' ? { status: 200, json: { assistants: [] } } : undefined));
    await routeRead(page, 'inference.read', ({ team_id: teamId }) => (teamId === 'support' ? { status: 200, json: { team_id: 'support', provider: 'openai', model: 'gpt-6.1-sol' } } : undefined));
    await routeChat(page, 'support', (socket) => socket.onMessage((message) => {
      const frame = JSON.parse(message);
      supportFrames.push(frame);
      if (frame.type === 'sync') socket.send(JSON.stringify({ type: 'sync-empty' }));
    }));
  }
  await routeRead(page, 'assistants.registry', () => ({ status: 200, json: {
      assistants: [
        {
          id: 'shimpz-cloudflare',
          title: 'Shimpz Cloudflare',
        },
        {
          id: 'whatsapp',
          title: 'WhatsApp',
        },
        ...(multipleIntegrations ? [{
          id: 'shimpz-slack',
          title: 'Shimpz Slack',
        }] : []),
      ],
    } }));
  await routeRead(page, 'assistants.list', async ({ team_id: teamId }) => {
    if (teamId !== 'marketing') return undefined;
    if (holdAssistantInventoryRefresh && !assistantInstalled) await assistantInventoryHold;
    if (holdPostInstallInventory && assistantInstalled) await assistantInventoryHold;
    return ok({
        assistants: assistantInstalled ? [
          {
            assistant: 'shimpz-cloudflare',
            assistant_version: '0.4.1',
            status: 'running',
            provenance: 'published',
          },
          ...((assistantPlan && !omitPlannedWhatsappFromInventory) || whatsappInstalled ? [{
            assistant: 'whatsapp',
            assistant_version: '0.1.0',
            status: 'running',
            provenance: 'published',
          }] : []),
          ...(multipleIntegrations ? [{
            assistant: 'shimpz-slack',
            assistant_version: '1.2.3',
            status: 'running',
            provenance: 'published',
          }] : []),
        ] : [],
    });
  });
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare/icon', (route) => {
    assistantIconRequests.push(route.request().url());
    if (!cloudflareInstalled) return route.fulfill({ status: 404 });
    const fulfill = () => route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    return holdAssistantIcon ? assistantIconHold.then(fulfill) : fulfill();
  });
  await page.route('**/api/assistants/shimpz-cloudflare/catalog-icon', (route) => {
    assistantIconRequests.push(route.request().url());
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.route('**/api/assistants/whatsapp/catalog-icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.route('**/api/teams/marketing/assistants/whatsapp/icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  // Every listed Team has no Routine unless a test says otherwise; a failed listing would offer its Routines' error.
  await routeRead(page, 'routines.list', (params) => ok({
    team_id: params.team_id, routines: [], runs: [], incidents: [],
  }));
  await routeRead(page, 'history.page', async (params) => {
    if (params.team_id === 'support') return ok({ entries: [], before: null });
    if (params.team_id !== 'marketing') return null;
    historyRequests.push(params.before ?? null);
    if (holdHistory) await historyHold;
    // Each page answers in the view asked for: the chat's, or a Routine's own history.
    const page = 'before' in params ? olderHistory : history;
    return historyStatus === 200
      ? ok(page && { ...page, entries: historyView(page.entries, params.routine ?? null) })
      : ok({ detail: 'Synthetic history failure.' }, historyStatus);
  });
  const providerState = ({ credential_validation: _credential, ...provider }) => ({
    ...provider,
    configured: configuredProviders.has(provider.id),
    masked: configuredProviders.has(provider.id) ? '••••1234' : null,
  });
  await routeRead(page, 'models.list', () => ({ status: 200, json: { providers: modelCatalog.providers.map(providerState) } }));
  await routeRead(page, 'models.save', ({ provider: id, body }) => {
    credentialBodies.push({ id, ...body });
    configuredProviders.add(id);
    return ok(providerState(modelCatalog.providers.find((provider) => provider.id === id)));
  });
  // The fast-routing key's read, save, and removal, recorded as the operations Admin carries.
  const decision = (method, body) => {
    decisionRequests.push({ method, body });
    if (method === 'decision.save' && rejectDecisionKey) return ok({ detail: 'TypeSafe rejected API key' }, 400);
    if (method === 'decision.save') decisionMasked = `••••${body.api_key.slice(-4)}`;
    if (method === 'decision.remove') decisionMasked = null;
    return ok({ provider: 'typesafe', configured: decisionMasked !== null, masked: decisionMasked });
  };
  await routeRead(page, 'decision.read', () => decision('decision.read', null));
  await routeRead(page, 'decision.save', ({ body }) => decision('decision.save', body));
  await routeRead(page, 'decision.remove', () => decision('decision.remove', null));
  // Marketing's selection as Admin holds it: what a save stored is what the next read answers.
  let selection = missingInference ? null : { provider: 'openai', model: 'gpt-6.1-sol' };
  await routeRead(page, 'inference.read', ({ team_id: teamId }) => {
    if (teamId !== 'marketing') return undefined;
    if (!selection) return ok({ detail: 'not configured' }, 409);
    return ok({ team_id: 'marketing', ...selection });
  });
  await routeRead(page, 'inference.save', async ({ team_id: teamId, body }) => {
    if (teamId !== 'marketing') return undefined;
    inferenceWrites += 1;
    inferenceBodies.push(body);
    if (holdInferenceWrite) await inferenceWriteHold;
    if (failInferenceWrite && inferenceWrites === 1) {
      return ok({ detail: 'The Team model selection could not be saved.' }, 502);
    }
    selection = { ...body };
    return ok({ team_id: 'marketing', ...body });
  });
  await routeRead(page, 'integrations.list', ({ team_id: teamId }) => (teamId === 'marketing' ? { status: 200, json: {
      integrations: [
        {
          assistant_id: 'shimpz-cloudflare',
          assistant_name: 'Shimpz Cloudflare',
          assistant_version: '0.4.2',
          id: 'cloudflare',
          provider: 'cloudflare',
          name: 'Cloudflare',
          scopes: ['dns.read', 'dns.write', 'offline_access', 'zone.read'],
          status: integrationStatus,
          integration: { id: 'account-1', name: 'Shimpz', username: null },
          expires_at: '2026-08-31T12:00:00.000Z',
        },
        ...(multipleIntegrations ? [{
          assistant_id: 'shimpz-slack',
          assistant_name: 'Shimpz Slack',
          assistant_version: '0.1.0',
          id: 'slack',
          provider: 'slack',
          name: 'Slack',
          scopes: ['chat:write'],
          status: 'connected',
          integration: { id: 'account-2', name: 'Shimpz', username: null },
          expires_at: '2026-08-31T12:00:00.000Z',
        }] : []),
      ],
    } } : undefined));
  // Team reads an installed Assistant's summary from its binding's pack, only in the requested interface language.
  await routeRead(page, 'assistants.summary', ({ team_id: teamId, assistant_id: assistantId, locale }) => {
    if (teamId !== 'marketing') return undefined;
    const summary = INSTALLED_SUMMARIES[assistantId]?.[locale];
    return summary
      ? ok({ locale, summary })
      : ok({ detail: 'installed Assistant manifest failed its reviewed contract' }, 409);
  });
  await routeRead(page, 'stored_inputs.list', ({ team_id: teamId }) => (teamId === 'marketing' ? { status: 200, json: {
      stored_inputs: storedInputStatus ? [{
        assistant_id: 'whatsapp',
        stored_input_id: 'whatsapp-token',
        status: storedInputStatus,
      }] : [],
    } } : undefined));
  await routeRead(page, 'stored_inputs.clear', (params) => {
    if (params.team_id !== 'marketing' || params.assistant_id !== 'whatsapp' || params.stored_input_id !== 'whatsapp-token') {
      return undefined;
    }
    storedInputClears += 1;
    storedInputStatus = 'missing';
    return ok({ cleared: true });
  });
  await routeConnect(page, (socket) => {
    if (firstChatDisconnected && reconnectsRefused < refusedReconnects) {
      // Admin is down while a release swaps its containers, or refuses an expired session before accepting the
      // upgrade: either way the upgrade fails before the socket ever opens.
      reconnectsRefused += 1;
      socket.connectToServer();
      return false;
    }
    return true;
  });
  await routeChat(page, 'marketing', (socket) => {
    sendProgressEvent = (event) => socket.send(JSON.stringify(event));
    closeChatSocket = () => socket.close({ code: 1011, reason: 'Synthetic interrupted connection' });
    const connection = chatConnections;
    chatConnections += 1;

    // The optional Brain-written purpose and a Stored Input's help travel beside the fingerprinted request (ADR-0090).
    const humanPresentation = {
      ...(humanPurpose ? { purpose: humanPurpose } : {}),
      ...(storedInputAfterPlan || humanStoredInput || humanKind === 'input:password'
        ? { help: humanHelp, help_url: humanHelpUrl }
        : {}),
    };
    const sendHumanChallenge = (expiresIn = humanExpiresIn) => socket.send(JSON.stringify({
      type: 'human-required',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expires_in: expiresIn,
      assistant: { id: humanAssistantId, name: 'Shimpz Cloudflare', version: '0.4.1' },
      action: { id: 'list-zones', summary: 'List reviewed Cloudflare zones.' },
      ...localizedChallenge(storedInputAfterPlan || humanStoredInput
        ? { ...humanRequest('input:password'), stored_input: humanStoredInput || 'cloudflare-token' }
        : humanRequest(humanKind), { locale: humanLocale }),
      ...humanPresentation,
    }));

    const deliverHumanResponse = (progressOnly = false) => {
      if (humanRejectionIndex < humanRejections.length) {
        socket.send(JSON.stringify(humanRejections[humanRejectionIndex]));
        humanRejectionIndex += 1;
        return;
      }
      humanPending = false;
      if (progressOnly) {
        socket.send(JSON.stringify({
          type: 'progress',
          seq: 1,
          origin: 'admin',
          phase: 'admin-preparation',
          state: 'started',
        }));
        return;
      }
      socket.send(JSON.stringify({
        type: 'done',
        team_id: 'marketing',
        team_name: 'Marketing',
        reply: 'The reviewed human response was accepted.',
        clarification: null,
      }));
    };

    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      if (frame.type === 'sync') {
        syncFrames += 1;
        if (redeliverExpiredHuman && humanPending && !expiredHumanRedelivered) {
          expiredHumanRedelivered = true;
          sendHumanChallenge(2);
          return;
        }
        if (disconnectHumanResponse && connection > 0 && humanPending) {
          sendHumanChallenge();
          return;
        }
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      } else if (frame.type === 'chat' || frame.type === 'resume-task') {
        chatFrames.push(frame);
        if (disconnectFirstChat && !firstChatDisconnected && frame.type === 'chat') {
          firstChatDisconnected = true;
          socket.close({ code: 1011, reason: 'Synthetic interrupted turn' });
          return;
        }
        if (expireSessionOnFirstChat) {
          // Admin revalidates the session before every frame and closes the socket once it has expired.
          sessionExpired = true;
          socket.close({ code: 4401 });
          return;
        }
        if (assistantGuidanceCode && !targetlessGuidanceSent) {
          targetlessGuidanceSent = true;
          const sendTargetlessGuidance = () => socket.send(JSON.stringify({
            type: 'assistant-guidance',
            team_id: 'marketing',
            code: assistantGuidanceCode,
            reply: assistantGuidanceReply,
          }));
          if (holdTargetlessUninstallGuidance) targetlessGuidancePending = true;
          else sendTargetlessGuidance();
          return;
        }
        if (alreadyInstalledResult) {
          socket.send(JSON.stringify({
            type: 'assistant-install-plan',
            state: 'installed',
            plan_id: 'f'.repeat(32),
            team_id: 'marketing',
            assistants: [{
              id: 'shimpz-cloudflare',
              name: 'Shimpz Cloudflare',
              summary: assistantSummary,
              creator: '@shimpz',
              version: '0.4.5',
              providers: [],
              provenance: 'local',
              status: 'installed',
            }],
            continuation: alreadyInstalledContinuation,
            outcome: 'already-installed',
          }));
          if (alreadyInstalledContinuation === 'dispatch') {
            socket.send(JSON.stringify({
              type: 'done',
              team_id: 'marketing',
              team_name: 'Marketing',
              reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
              clarification: null,
            }));
          }
          return;
        }
        if (assistantPlan && !assistantInstalled) {
          const planId = 'd'.repeat(32);
          const assistants = [
            {
              id: 'shimpz-cloudflare',
              name: 'Shimpz Cloudflare',
              summary: assistantSummary,
              creator: '@shimpz',
              version: '0.4.5',
              providers: ['cloudflare'],
              provenance: 'local',
            },
            {
              id: 'whatsapp',
              name: 'WhatsApp',
              summary: 'Send reviewed WhatsApp messages.',
              creator: '@meta',
              version: '2.1.0',
              providers: ['whatsapp'],
              provenance: 'published',
            },
          ];
          const sendPlan = (state, statuses, extra = {}) => socket.send(JSON.stringify({
            type: 'assistant-install-plan',
            state,
            plan_id: planId,
            team_id: 'marketing',
            assistants: assistants.map((assistant, index) => ({
              ...assistant,
              status: statuses[index],
            })),
            ...extra,
          }));
          sendPlan('planned', ['pending', 'pending']);
          sendPlan('installing', ['installing', 'pending']);
          advanceAssistantPlan = () => {
            cloudflareInstalled = true;
            sendPlan('installing', ['installed', 'installing']);
          };
          let planCompleted = false;
          completeAssistantPlan = () => {
            if (planCompleted) return;
            planCompleted = true;
            assistantInstalled = true;
            sendPlan('installed', ['installed', 'installed'], { continuation: assistantPlanContinuation });
          };
          let planReleased = false;
          releaseAssistantPlan = () => {
            completeAssistantPlan();
            if (planReleased) return;
            planReleased = true;
            if (assistantPlanContinuation === 'none') return;
            if (progressAfterPlan) {
              socket.send(JSON.stringify({
                type: 'progress', seq: 1, origin: 'team', phase: 'model', state: 'started',
              }));
              releaseReply = () => socket.send(JSON.stringify({
                type: 'done',
                team_id: 'marketing',
                team_name: 'Marketing',
                reply: 'Continued task complete.',
                clarification: null,
              }));
              return;
            }
            if (storedInputAfterPlan) {
              humanPending = true;
              socket.send(JSON.stringify({
                type: 'human-required',
                challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                expires_in: humanExpiresIn,
                assistant: { id: humanAssistantId, name: 'Shimpz Cloudflare', version: '0.4.1' },
                action: { id: 'list-zones', summary: 'List reviewed Cloudflare zones.' },
                ...localizedChallenge({ ...humanRequest('input:password'), stored_input: 'cloudflare-token' }),
                ...humanPresentation,
              }));
              return;
            }
            socket.send(JSON.stringify({
              type: 'done',
              team_id: 'marketing',
              team_name: 'Marketing',
              reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
              clarification: null,
            }));
          };
          if (!holdAssistantPlan) {
            advanceAssistantPlan();
            releaseAssistantPlan();
          }
          return;
        }
        if (assistantUninstall && assistantInstalled) {
          if (!uninstallProposed) {
            uninstallProposed = true;
            const propose = () => socket.send(JSON.stringify({
              type: 'assistant-uninstall',
              state: 'proposed',
              proposal_id: 'e'.repeat(32),
              team_id: 'marketing',
              expires_in: 120,
              assistant: {
                id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1', creator: '@shimpz', provenance: 'local',
              },
            }));
            if (holdUninstallProposal) releaseUninstallProposal = propose;
            else propose();
            return;
          }
          if (failUninstallDecision) {
            socket.send(JSON.stringify({ type: 'error', status: 503, detail: 'chat history is unavailable' }));
            return;
          }
          if (frame.message === 'no') {
            socket.send(JSON.stringify({
              type: 'assistant-uninstall',
              state: 'cancelled',
              proposal_id: 'e'.repeat(32),
              assistant_id: 'shimpz-cloudflare',
            }));
            return;
          }
          if (frame.message !== 'yes') {
            socket.send(JSON.stringify({
              type: 'error',
              status: 400,
              detail: 'unexpected Assistant uninstall confirmation',
            }));
            return;
          }
          socket.send(JSON.stringify({
            type: 'assistant-uninstall',
            state: 'uninstalling',
            proposal_id: 'e'.repeat(32),
            assistant_id: 'shimpz-cloudflare',
          }));
          const completeAssistantUninstall = () => {
            assistantInstalled = false;
            cloudflareInstalled = false;
            socket.send(JSON.stringify({
              type: 'assistant-uninstall',
              state: 'uninstalled',
              proposal_id: 'e'.repeat(32),
              assistant_id: 'shimpz-cloudflare',
              team_id: 'marketing',
              uninstalled: assistantUninstallWasRemoved,
            }));
          };
          if (holdAssistantUninstall) releaseAssistantUninstall = completeAssistantUninstall;
          else completeAssistantUninstall();
          return;
        }
        if (integrationChallenge) {
          socket.send(JSON.stringify({
            type: 'integrations-required',
            challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            expires_in: 300,
            requirements: integrationRequirements ?? [{
              assistant_id: 'shimpz-cloudflare',
              assistant_name: 'Shimpz Cloudflare',
              integration_id: 'cloudflare',
              provider: 'cloudflare',
              name: 'Cloudflare',
              scopes: ['dns.read', 'dns.write', 'offline_access', 'zone.read'],
              actions: [{ id: 'list-zones' }],
            }],
          }));
          return;
        }
        if (humanKind) {
          humanPending = true;
          sendHumanChallenge();
          return;
        }
        const sendProgress = () => {
          const progress = {
            type: 'progress', seq: invalidProgressSequence ? 2 : 1,
            origin: 'admin', phase: 'admin-preparation',
          };
          if (holdProgressFinish) {
            socket.send(JSON.stringify({ ...progress, state: 'started' }));
            releaseProgressFinish = () => socket.send(JSON.stringify({
              ...progress, seq: 2, state: 'finished', elapsed_ms: 19,
            }));
          } else {
            socket.send(JSON.stringify({ ...progress, state: 'finished', elapsed_ms: 19 }));
          }
        };
        if (holdProgressStart) releaseProgressStart = sendProgress;
        else sendProgress();
        const completeReply = () => socket.send(JSON.stringify(terminalError
          ? { type: 'error', status: terminalError === true ? 503 : terminalError, detail: terminalDetail }
          : {
              type: 'done',
              team_id: 'marketing',
              team_name: 'Marketing',
              reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
              clarification: clarification ?? null,
              ...(usage === undefined ? {} : { usage }),
            }));
        if (holdReply) releaseReply = completeReply;
        else completeReply();
      } else if (frame.type === 'human-response') {
        humanResponses.push(frame);
        if (disconnectHumanResponse) {
          disconnectHumanSocket = () => socket.close({
            code: 1011,
            reason: 'Synthetic interrupted delivery',
          });
          return;
        }
        if (holdHumanResponse) {
          releaseHumanResponse = () => deliverHumanResponse(true);
          return;
        }
        deliverHumanResponse();
      } else if (frame.type === 'stop') {
        if (targetlessGuidancePending) {
          targetlessGuidancePending = false;
          socket.send(JSON.stringify({
            type: 'assistant-guidance',
            team_id: 'marketing',
            code: assistantGuidanceCode,
            reply: assistantGuidanceReply,
          }));
          return;
        }
        if (!holdStop) socket.send(JSON.stringify({ type: 'stopped' }));
      }
    });
  });
  return {
    assistantIconRequests: () => assistantIconRequests,
    chatFrames: () => chatFrames,
    chatConnections: () => chatConnections,
    refusedConnections: () => reconnectsRefused,
    credentialBodies: () => credentialBodies,
    decisionRequests: () => decisionRequests,
    configureDecisionElsewhere: (masked) => {
      decisionMasked = masked;
    },
    disconnectHumanSocket: () => disconnectHumanSocket(),
    humanResponses: () => humanResponses,
    historyRequests: () => historyRequests,
    inferenceWrites: () => inferenceWrites,
    inferenceBodies: () => inferenceBodies,
    advanceAssistantPlan: () => advanceAssistantPlan(),
    completeAssistantPlan: () => completeAssistantPlan(),
    releaseAssistantPlan: () => releaseAssistantPlan(),
    releaseAssistantUninstall: () => releaseAssistantUninstall(),
    releaseUninstallProposal: () => releaseUninstallProposal(),
    releaseAssistantInventory: () => releaseAssistantInventory(),
    releaseAssistantIcon: () => releaseAssistantIcon(),
    releaseInferenceWrite: () => releaseInferenceWrite(),
    releaseHumanResponse: () => releaseHumanResponse(),
    releaseHistory: () => releaseHistory(),
    releaseReply: () => releaseReply(),
    releaseProgressStart: () => releaseProgressStart(),
    releaseProgressFinish: () => releaseProgressFinish(),
    sendProgressEvent: (event) => sendProgressEvent(event),
    closeChatSocket: () => closeChatSocket(),
    supportFrames: () => supportFrames,
    storedInputClears: () => storedInputClears,
    syncFrames: () => syncFrames,
  };
}

test('the setup screen passes its accessibility scan and requires a 15-character password', async ({ page }) => {
  await routeSetup(page);
  await page.goto('/');
  await expect(page.locator('input[type="password"]').first()).toBeVisible();

  // The setup screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);
  await expect(page.locator('input[type="password"]').first()).toHaveAttribute('minlength', '15');
});

test('language menu implements keyboard navigation and RTL direction', async ({ page }) => {
  await routeSetup(page);
  await page.goto('/');

  const trigger = page.getByRole('button', { name: 'Language: English' });
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Language' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitemradio', { name: 'العربية' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('button', { name: 'اللغة: العربية' })).toBeFocused();
});

test('opens Chat directly when the provider key already exists', async ({ page }) => {
  const requests = await routeReadyChat(page, { missingInference: true });
  await page.goto('/chat/');

  await expect(page.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(requests.inferenceWrites()).toBe(1);
});

const KEYLESS_HISTORY = {
  entries: [
    { id: `${'c'.repeat(32)}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Summarize the launch plan' },
    {
      id: `${'c'.repeat(32)}:reply`,
      created_at: HISTORY_AT,
      kind: 'message',
      role: 'assistant',
      text: 'The launch plan has three milestones.',
      author: 'Marketing',
    },
  ],
  before: null,
};

async function chooseBrainModel(page, name) {
  const panel = page.getByRole('dialog', { name: 'Brain settings' });
  if (!await panel.isVisible()) await page.getByRole('button', { name: /^Brain: / }).click();
  await panel.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

test('a first Team without any provider key asks for one in the focused composer', async ({ page }) => {
  const chat = await routeReadyChat(page, { missingInference: true, unconfiguredProviders: ['openai', 'anthropic'] });
  await page.goto('/chat/');

  const apiKey = page.getByLabel('API key');
  await expect(apiKey).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toHaveCount(0);
  await apiKey.fill('sk-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
  await expect.poll(() => chat.credentialBodies()).toEqual([{ id: 'openai', api_key: 'sk-browser-contract-1234567890' }]);
  await expect.poll(() => chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6-luna' }]);
});

test('asks for a missing provider key in the composer without leaving the conversation', async ({ page }) => {
  const chat = await routeReadyChat(page, { unconfiguredProviders: ['anthropic'], history: KEYLESS_HISTORY });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Draft kept for later');
  const connections = chat.chatConnections();

  await chooseBrainModel(page, 'Claude Opus 5.5');
  const apiKey = page.getByLabel('API key');
  await expect(apiKey).toBeFocused();
  await expect(apiKey).toHaveAttribute('type', 'password');
  await expect(apiKey).toHaveAttribute('autocomplete', 'off');
  await expect(page.getByRole('dialog', { name: 'Brain settings' })).toBeHidden();
  await expect(page.getByText('The launch plan has three milestones.')).toBeVisible();
  await expect(composer).toHaveCount(0);
  const saveKey = page.getByRole('button', { name: 'Save key' });
  await expect(saveKey).toBeDisabled();

  const secret = 'sk-ant-browser-contract-1234567890';
  await apiKey.fill(secret);
  await saveKey.click();
  await expect(composer).toHaveValue('Draft kept for later');
  await expect(composer).toBeFocused();
  await expect(page.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  await expect.poll(() => chat.credentialBodies()).toEqual([{ id: 'anthropic', api_key: secret }]);
  await expect.poll(() => chat.inferenceBodies()).toEqual([{ provider: 'anthropic', model: 'claude-opus-5-5' }]);
  expect(chat.chatConnections()).toBe(connections);

  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  expect(JSON.stringify(chat.chatFrames())).not.toContain(secret);
});

test('a provider key the provider refuses is said so and its field takes the focus back', async ({ page }) => {
  await routeReadyChat(page, { missingInference: true, unconfiguredProviders: ['openai', 'anthropic'] });
  await routeRead(page, 'models.save', () => ok({ detail: 'The provider rejected this API key' }, 400));
  await page.goto('/chat/');
  const apiKey = page.getByLabel('API key');
  await expect(apiKey).toBeFocused();
  await apiKey.fill('sk-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The provider rejected this API key' })).toBeVisible();
  // The key never stays on the page; its emptied field takes the focus for the next one.
  await expect(apiKey).toHaveValue('');
  await expect(apiKey).toBeFocused();
});

test('a provider key refused after the person moved the focus leaves it where they put it', async ({ page }) => {
  await routeReadyChat(page, { missingInference: true, unconfiguredProviders: ['openai', 'anthropic'] });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  await routeRead(page, 'models.save', async () => {
    asked = true;
    await held;
    return ok({ detail: 'The provider rejected this API key' }, 400);
  });
  await page.goto('/chat/');
  const apiKey = page.getByLabel('API key');
  await expect(apiKey).toBeFocused();
  await apiKey.fill('sk-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect.poll(() => asked).toBe(true);
  const elsewhere = page.getByRole('button', { name: /^(New Team|Open the Team list)$/ });
  await elsewhere.focus();
  release();
  await expect(page.getByRole('alert').filter({ hasText: 'The provider rejected this API key' })).toBeVisible();
  await expect(elsewhere).toBeFocused();
});

// Text typed into the composer is never dropped: once the visible composer accepts input it stays editable while the
// Team's history loads, its connection opens, and its first sync settles, so a message typed at any moment can be sent.
test('the visible composer never turns read-only again before the first message', async ({ page }) => {
  await page.addInitScript(() => {
    window.composerStates = [];
    const record = () => {
      const composer = document.getElementById('chat-composer');
      if (!composer?.checkVisibility({ visibilityProperty: true })) return;
      const state = composer.disabled ? 'disabled' : 'enabled';
      if (window.composerStates.at(-1) !== state) window.composerStates.push(state);
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'disabled'],
    });
  });
  const chat = await routeReadyChat(page, { history: KEYLESS_HISTORY });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Typed as soon as it was editable');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled();
  const states = await page.evaluate(() => window.composerStates);
  expect(states.slice(states.indexOf('enabled'))).toEqual(['enabled']);
  await send.click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
});

async function openFastRouting(page) {
  const trigger = page.getByRole('button', { name: /^Fast routing \(Jev\)/ });
  await trigger.click();
  return { trigger, fast: page.getByRole('dialog', { name: 'Fast routing (Jev)' }) };
}

test('the Supervisor adds and removes the Jev key', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const { trigger, fast } = await openFastRouting(page);
  await expect(fast.getByRole('link', { name: /Create your key here/ }))
    .toHaveAttribute('href', 'https://console.typesafe.ai/keys');
  const key = fast.getByLabel('TypeSafe API key');
  await expect(key).toBeFocused();
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('autocomplete', 'off');
  const save = fast.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  const secret = 'tsk-browser-contract-0123456789';
  await key.fill(secret);
  await save.click();
  await expect(fast).toContainText('On · key ••••6789');
  await expect(fast.getByRole('button', { name: 'Remove' })).toBeFocused();
  await expect(page.getByText(secret, { exact: false })).toHaveCount(0);

  await fast.getByRole('button', { name: 'Remove' }).click();
  await expect(fast.getByLabel('TypeSafe API key')).toBeFocused();
  // What shows after each change is the key read again from Admin, never the change's own answer.
  expect(chat.decisionRequests()).toEqual([
    { method: 'decision.read', body: null },
    { method: 'decision.save', body: { api_key: secret } },
    { method: 'decision.read', body: null },
    { method: 'decision.remove', body: null },
    { method: 'decision.read', body: null },
  ]);
  expect(chat.credentialBodies()).toEqual([]);
  // Escape closes the panel and returns focus to the control that opened it.
  await page.keyboard.press('Escape');
  await expect(fast).toBeHidden();
  await expect(trigger).toBeFocused();

  // A key another session stores meanwhile is read once Admin announces it, and the panel shows it.
  chat.configureDecisionElsewhere('••••abcd');
  await raiseTopic(page, 'space/decision');
  await expect(trigger).toHaveAccessibleName(/••••abcd/);
  await trigger.click();
  await expect(fast).toContainText('On · key ••••abcd');
});

test('a rejected Jev key is reported and an unsent one never outlives the panel', async ({ page }) => {
  const chat = await routeReadyChat(page, { rejectDecisionKey: true });
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const { trigger, fast } = await openFastRouting(page);
  await fast.getByLabel('TypeSafe API key').fill('tsk-rejected-contract-0123456789');
  await fast.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(fast.getByRole('alert')).toHaveText('TypeSafe rejected this key.');
  await expect(fast.getByLabel('TypeSafe API key')).toHaveValue('tsk-rejected-contract-0123456789');
  await expect(fast.getByLabel('TypeSafe API key')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByLabel('TypeSafe API key')).toHaveCount(0);
  await trigger.click();
  await expect(fast.getByRole('alert')).toHaveCount(0);
  await expect(fast.getByLabel('TypeSafe API key')).toHaveValue('');
  expect(chat.decisionRequests().map((request) => request.method)).toEqual(['decision.read', 'decision.save']);
});

test('a Jev key refused after the person moved the focus out of the panel leaves the focus there', async ({ page }) => {
  await routeReadyChat(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  await routeRead(page, 'decision.save', async () => {
    asked = true;
    await held;
    return ok({ detail: 'rejected' }, 400);
  });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  const { fast } = await openFastRouting(page);
  await fast.getByLabel('TypeSafe API key').fill('tsk-held-contract-0123456789');
  await fast.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => asked).toBe(true);
  await composer.focus();
  release();
  await expect(fast.getByRole('alert')).toHaveText('TypeSafe rejected this key.');
  await expect(composer).toBeFocused();
});

const CLARIFICATION = {
  question: 'Which period should the list cover?',
  options: [
    { label: 'Today', description: 'Only models released today.' },
    { label: 'This week', description: '' },
    { label: 'This month', description: '' },
  ],
  default_index: 0,
};
const CLARIFICATION_REPLY = 'Which period should the list cover?\n\n1. Today ✓ — Only models released today.\n2. This week\n3. This month';
const VOICE_REQUEST = 'Compare every voice agent API on the market';

function composedAnswer(original, question, answer) {
  return `${original}\n\nQuestion: ${question}\nAnswer: ${answer}`;
}

function sentMessages(frames) {
  return frames.filter((frame) => frame.type === 'chat').map((frame) => frame.message);
}

async function askVoiceQuestion(page, scenario) {
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await sendMessage(page, VOICE_REQUEST);
  const card = page.getByRole('form', { name: SCENARIO_CLARIFICATION.question });
  await expect(card.getByRole('radio', { name: /· recommended/ })).toBeChecked();
  expect(sentMessages(scenario.chatFrames())).toEqual([VOICE_REQUEST]);
  return { composer, card };
}

test('answering a question sends the request with the answer at once and the Team replies', async ({ page }) => {
  const scenario = await routeScenario(page, 'clarify');
  const { composer, card } = await askVoiceQuestion(page, scenario);
  const recommended = SCENARIO_CLARIFICATION.options[SCENARIO_CLARIFICATION.default_index].label;
  // The composer waits while the latest question is open; the card's answer unlocks it.
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(composer).toBeDisabled();
  await expect(send).toBeDisabled();

  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText(`Certo — sigo com ${recommended}`)).toBeVisible();
  expect(sentMessages(scenario.chatFrames())).toEqual([
    VOICE_REQUEST,
    composedAnswer(VOICE_REQUEST, SCENARIO_CLARIFICATION.question, recommended),
  ]);
  // The answered question offers no second answer, even in another language, and nothing was left to send again.
  await expect(card).toHaveCount(0);
  // Once answered, the card is gone from the reply that asked it; only the person's message keeps the question.
  await expect(page.getByRole('article', { name: 'Marketing' }).filter({ hasText: SCENARIO_CLARIFICATION.question })).toHaveCount(0);
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEnabled();
  await composer.fill('Thanks');
  await expect(send).toBeEnabled();
  await composer.fill('');
  await expect(page.getByRole('article', { name: 'You' })).toHaveCount(2);
  await switchLanguage(page, 'en', 'pt');
  await expect(page.getByRole('textbox', { name: 'Enviar', exact: true })).toBeEnabled();
  await expect(card).toHaveCount(0);
  expect(sentMessages(scenario.chatFrames())).toHaveLength(2);
});

// Two open questions come back from the history: the composer waits for the latest, and either card answers.
function twoOpenQuestions(firstRequest, secondRequest) {
  return [['a'.repeat(32), firstRequest], ['b'.repeat(32), secondRequest]].flatMap(([turn, text]) => [
    { id: `${turn}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text },
    {
      id: `${turn}:reply`,
      created_at: HISTORY_AT,
      kind: 'message',
      role: 'assistant',
      text: CLARIFICATION_REPLY,
      author: 'Marketing',
      clarification: CLARIFICATION,
    },
  ]);
}

test('answering the newer of two identical questions closes that question and keeps the older one open', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    history: { entries: twoOpenQuestions(VOICE_REQUEST, VOICE_REQUEST), before: null },
  });
  await page.goto('/chat/');
  const cards = page.getByRole('form', { name: CLARIFICATION.question });
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeDisabled();

  await cards.last().getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(1);
  const replies = page.getByRole('article', { name: 'Marketing' });
  await expect(replies.first().getByRole('form')).toHaveCount(1);
  await expect(replies.nth(1).getByRole('form')).toHaveCount(0);
  expect(sentMessages(chat.chatFrames())).toEqual([composedAnswer(VOICE_REQUEST, CLARIFICATION.question, 'Today')]);
});

test('an older question answered after another request closes once its answer is sent', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    history: { entries: twoOpenQuestions(VOICE_REQUEST, 'Compare every video API too'), before: null },
  });
  await page.goto('/chat/');
  const cards = page.getByRole('form', { name: CLARIFICATION.question });
  await expect(cards).toHaveCount(2);

  await cards.first().getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(1);
  expect(sentMessages(chat.chatFrames())).toEqual([composedAnswer(VOICE_REQUEST, CLARIFICATION.question, 'Today')]);
  // The latest reply asks nothing, so the composer is free again although the newer question stays open.
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
});

test('a question that recommends nothing preselects no option and answers only once one is chosen', async ({ page }) => {
  const asked = { ...CLARIFICATION, default_index: null };
  const reply = 'Which period should the list cover?\n\n1. Today — Only models released today.\n2. This week\n3. This month';
  const turn = 'c'.repeat(32);
  const chat = await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${turn}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: VOICE_REQUEST },
        {
          id: `${turn}:reply`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'assistant',
          text: reply,
          author: 'Marketing',
          clarification: asked,
        },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');
  const card = page.getByRole('form', { name: CLARIFICATION.question });
  await expect(card.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(card.getByRole('radio', { name: /· recommended/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Answer' })).toBeDisabled();
  expect(sentMessages(chat.chatFrames())).toEqual([]);

  await card.getByRole('radio', { name: 'This week' }).check();
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  expect(sentMessages(chat.chatFrames())).toEqual([composedAnswer(VOICE_REQUEST, CLARIFICATION.question, 'This week')]);
});

test('a custom answer takes focus and can be sent only once it has text', async ({ page }) => {
  const scenario = await routeScenario(page, 'clarify');
  const { card } = await askVoiceQuestion(page, scenario);
  const answer = card.getByRole('button', { name: 'Answer' });

  await card.getByRole('radio', { name: 'Other answer' }).check();
  const custom = card.getByRole('textbox', { name: 'Other answer' });
  await expect(custom).toBeFocused();
  await expect(answer).toBeDisabled();
  await custom.fill('   ');
  await expect(answer).toBeDisabled();
  await custom.fill('  Only APIs that speak Portuguese  ');
  await expect(answer).toBeEnabled();
  await page.keyboard.press('Enter');

  await expect(page.getByText('Certo — sigo com Only APIs that speak Portuguese')).toBeVisible();
  expect(sentMessages(scenario.chatFrames())).toEqual([
    VOICE_REQUEST,
    composedAnswer(VOICE_REQUEST, SCENARIO_CLARIFICATION.question, 'Only APIs that speak Portuguese'),
  ]);
});

test('a send refused while the Space resets explains the reset', async ({ page }) => {
  await routeReadyChat(page, {
    terminalError: 409,
    terminalDetail: 'space-resetting: the Space is being reset; retry when it finishes',
  });
  await page.goto('/chat/');
  await sendMessage(page, 'List my DNS zones');
  const notice = page.locator('[data-slot="notice"].shimpz-notice--error');
  await expect(notice).toContainText(messages.en.chatPage.spaceResetting);
});

test('an error delivered by a reconnect sync is shown without sending the finished request again', async ({ page }) => {
  await routeScenario(page, 'ready');
  const frames = [];
  let connections = 0;
  // This chat channel takes precedence over the scenario's: the first request ends with Team guidance, the session
  // socket restarts, and the sync of the reattached channel reports a failure that belongs to no request of this page.
  await routeChat(page, 'marketing', (socket) => {
    connections += 1;
    const connection = connections;
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      frames.push(frame);
      if (frame.type === 'sync') {
        socket.send(JSON.stringify(connection === 1
          ? { type: 'sync-empty' }
          : { type: 'error', status: 503, detail: 'synthetic runtime failure' }));
      } else if (frame.type === 'chat') {
        socket.send(JSON.stringify({
          type: 'assistant-guidance',
          team_id: 'marketing',
          code: 'assistant-uninstall-target-required',
          reply: 'Which installed Assistant do you want to uninstall?',
        }));
        socket.close({ code: 1011, reason: 'Synthetic restart' });
      }
    });
  });
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'Uninstall the Assistant');

  await expect(page.getByText('The local chat runtime is unavailable.')).toBeVisible();
  expect(frames.filter((frame) => frame.type === 'chat')).toHaveLength(1);
  expect(connections).toBe(2);
});

test('a question of 240 emoji is offered and its emoji answer is sent', async ({ page }) => {
  // Team bounds clarification text by Unicode code points; each emoji is two UTF-16 units.
  const clarification = {
    question: '😀'.repeat(240),
    options: [{ label: '🌙'.repeat(80), description: '⭐'.repeat(160) }, { label: 'This week', description: '' }],
    default_index: 0,
  };
  const reply = `${clarification.question}\n\n1. ${clarification.options[0].label} ✓ — ${clarification.options[0].description}\n2. This week`;
  const chat = await routeReadyChat(page, { clarification, reply });
  await page.goto('/chat/');
  await sendMessage(page, 'Which new AI models were released?');

  const card = page.getByRole('form', { name: clarification.question });
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual([
    'Which new AI models were released?',
    composedAnswer('Which new AI models were released?', clarification.question, clarification.options[0].label),
  ]);
});

test('an answer that would exceed one message is refused and nothing is sent', async ({ page }) => {
  const chat = await routeReadyChat(page, { clarification: CLARIFICATION, reply: CLARIFICATION_REPLY });
  await page.goto('/chat/');
  const request = 'x'.repeat(16_000 - 60);
  await sendMessage(page, request);

  const card = page.getByRole('form', { name: CLARIFICATION.question });
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card).toBeVisible();
  expect(sentMessages(chat.chatFrames())).toEqual([request]);
});

// The person's message keeps the question above the answer, so it always shows what was answered (live and reloaded).
test('an answer shows the question it answers, when sent and after a reload', async ({ page }) => {
  const request = 'Which new AI models were released?';
  await routeReadyChat(page, { clarification: CLARIFICATION, reply: CLARIFICATION_REPLY });
  await page.goto('/chat/');
  await sendMessage(page, request);
  const card = page.getByRole('form', { name: CLARIFICATION.question });
  const answer = card.getByRole('button', { name: 'Answer' });
  await card.getByRole('radio', { name: 'Other answer' }).check();
  await card.getByRole('textbox').fill('only open-weight models');
  await answer.click();
  const sent = page.getByRole('article', { name: 'You' }).last();
  await expect(sent.getByText(CLARIFICATION.question)).toBeVisible();
  await expect(sent.getByText('only open-weight models')).toBeVisible();

  const [first, second] = ['f'.repeat(32), '0'.repeat(32)];
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${first}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: request },
        {
          id: `${first}:reply`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'assistant',
          text: CLARIFICATION_REPLY,
          author: 'Marketing',
          clarification: CLARIFICATION,
        },
        {
          id: `${second}:user`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'user',
          text: composedAnswer(request, CLARIFICATION.question, 'only open-weight models'),
        },
      ],
      before: null,
    },
  });
  await page.reload();
  const reloaded = page.getByRole('article', { name: 'You' }).last();
  await expect(reloaded.getByText(CLARIFICATION.question)).toBeVisible();
  await expect(reloaded.getByText('only open-weight models')).toBeVisible();
  await expect(page.getByRole('form', { name: CLARIFICATION.question })).toHaveCount(0);
});

test('a reloaded question answered in another language offers no second answer', async ({ page }) => {
  const [first, second] = ['d'.repeat(32), 'e'.repeat(32)];
  const composed = `Which new AI models were released?\n\nPergunta: ${CLARIFICATION.question}\nResposta: This week`;
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${first}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Which new AI models were released?' },
        {
          id: `${first}:reply`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'assistant',
          text: CLARIFICATION_REPLY,
          author: 'Marketing',
          clarification: CLARIFICATION,
        },
        { id: `${second}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: composed },
        { id: `${second}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant', text: 'Here are this week’s models.', author: 'Marketing' },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');
  await expect(page.getByText('Here are this week’s models.')).toBeVisible();
  await expect(page.getByRole('form', { name: CLARIFICATION.question })).toHaveCount(0);
});

test('discards an unsent provider key and never sends on the unsaved model', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    history: KEYLESS_HISTORY,
  });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Keep this message');

  await chooseBrainModel(page, 'Claude Opus 5.5');
  await page.getByLabel('API key').fill('sk-ant-unsent-secret-1234567890');
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await chooseBrainModel(page, 'GPT-6.1 Sol');
  await expect(composer).toHaveValue('Keep this message');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

  await chooseBrainModel(page, 'Claude Sonnet 5.5');
  await expect(page.getByLabel('API key')).toBeFocused();
  await expect(page.getByLabel('API key')).toHaveValue('');
  expect(chat.credentialBodies()).toEqual([]);
  await expect.poll(() => chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6.1-sol' }]);
  expect(chat.chatFrames()).toHaveLength(0);
});

test('shows a Brain failure and its retry beside an earlier chat error', async ({ page }) => {
  await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    failInferenceWrite: true,
    terminalError: true,
  });
  await page.goto('/chat/');
  await sendMessage(page, 'List my DNS zones');
  await expect(page.getByText('The local chat runtime is unavailable.')).toBeVisible();

  await chooseBrainModel(page, 'Claude Opus 5.5');
  await page.getByLabel('API key').fill('sk-ant-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('The Team model selection could not be saved.')).toBeVisible();
  await expect(page.getByText('The local chat runtime is unavailable.')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'The Team model selection could not be saved.' })
    .getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('keeps a saved key when the model selection fails and retries only the selection', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    failInferenceWrite: true,
    history: KEYLESS_HISTORY,
  });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'Wait for the retry');

  await chooseBrainModel(page, 'Claude Opus 5.5');
  await page.getByLabel('API key').fill('sk-ant-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('The Team model selection could not be saved.')).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.getByText('The launch plan has three milestones.')).toBeVisible();
  // The saved key's field left with the save; the Brain notice's Try again takes the focus it held.
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeFocused();

  // A retry that fails again leaves while the selection is saved, then its new Try again takes the focus back.
  let release;
  let held = new Promise((resolve) => { release = resolve; });
  let refusals = 1;
  await routeRead(page, 'inference.save', async () => {
    if (refusals === 0) return undefined;
    refusals -= 1;
    await held;
    return ok({ detail: 'The Team model selection could not be saved.' }, 502);
  });
  await retry.click();
  await expect(retry).toHaveCount(0);
  release();
  await expect(retry).toBeFocused();

  // One that fails after the person pressed elsewhere, leaving the focus on the document, leaves it there.
  held = new Promise((resolve) => { release = resolve; });
  refusals = 1;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(retry).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

  await retry.click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await expect.poll(() => chat.credentialBodies()).toHaveLength(1);
  expect(chat.inferenceBodies()).toEqual([
    { provider: 'anthropic', model: 'claude-opus-5-5' },
    { provider: 'anthropic', model: 'claude-opus-5-5' },
  ]);
});

test('a saved key whose model selection fails after the person pressed elsewhere gives its Try again no focus', async ({ page }) => {
  await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    failInferenceWrite: true,
    history: KEYLESS_HISTORY,
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  await routeRead(page, 'inference.save', async () => {
    asked = true;
    await held;
    return ok({ detail: 'The Team model selection could not be saved.' }, 502);
  });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'Wait for the retry');
  await chooseBrainModel(page, 'Claude Opus 5.5');
  await page.getByLabel('API key').fill('sk-ant-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect.poll(() => asked).toBe(true);
  // A press on the Admin version, which nothing focuses, leaves the focus on the document, as the person chose.
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("a Brain retry that fails once the person went back to another Team gives that Team's Try again no focus", async ({ page }) => {
  await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    failInferenceWrite: true,
    history: KEYLESS_HISTORY,
    secondTeam: true,
  });
  // Support's model selection cannot be read, so its Brain notice offers a Try again too.
  await routeRead(page, 'inference.read', ({ team_id: teamId }) => (
    teamId === 'support' ? ok({ detail: 'unavailable' }, 503) : undefined
  ));
  await page.goto('/chat/?team=support');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Marketing', exact: true }).click();
  await expect(page).toHaveURL(/team=marketing/);
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'Wait for the retry');
  await chooseBrainModel(page, 'Claude Opus 5.5');
  await page.getByLabel('API key').fill('sk-ant-browser-contract-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(retry).toBeFocused();

  // Marketing's retry waits, and fails once the person went back to Support, which is nobody's move on the page.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let asked = false;
  await routeRead(page, 'inference.save', async () => {
    asked = true;
    await held;
    return ok({ detail: 'The Team model selection could not be saved.' }, 502);
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => asked).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/team=support/);
  await expect(retry).toBeVisible();
  // The failed save reads the providers again before its Try again would take the focus.
  const providerReads = async () => (await readsOf(page, 'models.list')).length;
  const before = await providerReads();
  release();
  await expect.poll(providerReads).toBeGreaterThan(before);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(retry).not.toBeFocused();
});

test('compiled Chat renders Markdown and its execution receipt', async ({ page }) => {
  await routeReadyChat(page, {
    reply: `**Rendered answer** with a [safe link](https://example.com), [your bank](https://evil.example/c?d=1) and [https://pаypal.com](https://pаypal.com).

:success[The deployment completed.]
:warning[Review the DNS TTL before publishing.]
:error[The provider rejected the request.]`,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'safe link (example.com)', exact: true }))
    .toHaveAttribute('href', 'https://example.com/');
  // A label never hides where its link leads: the host it opens is part of the link.
  await expect(page.getByRole('link', { name: 'your bank (evil.example)', exact: true }))
    .toHaveAttribute('href', 'https://evil.example/c?d=1');
  // A look-alike address in the label names the punycode host it really opens.
  await expect(page.getByRole('link', { name: 'https://pаypal.com (xn--pypal-4ve.com)', exact: true }))
    .toHaveAttribute('href', 'https://xn--pypal-4ve.com/');
  const notices = page.locator('.shimpz-message--assistant [data-slot="notice"]');
  await expect(notices).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(notices.nth(index)).toHaveAttribute('role', 'status');
  }
});

test('finishing a measured span updates its duration and announcements across turns', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdProgressFinish: true, holdReply: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Check progress');
  await page.getByRole('button', { name: 'Send' }).click();

  const thinking = page.getByRole('group', { name: 'I’m processing…' });
  const liveStatus = page.locator('.conversation .live-status');
  await expect(liveStatus).toHaveAttribute('aria-live', 'polite');
  await expect(liveStatus).toHaveText(/In progress$/);
  await expect(thinking).toBeVisible();
  chat.releaseProgressFinish();
  await expect(liveStatus).toHaveText(/Complete$/);

  chat.releaseReply();
  await composer.fill('Check progress again');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(liveStatus).toHaveText(/In progress$/);
  chat.releaseProgressFinish();
  await expect(liveStatus).toHaveText(/Complete$/);
  chat.releaseReply();
});

test('overlapping progress returns the visible summary to the earlier active phase', async ({ page }) => {
  const usage = { duration_ms: 1000, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 100, output_tokens: 10 }] };
  const chat = await routeReadyChat(page, { holdProgressFinish: true, holdReply: true, usage });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Check progress');
  await page.getByRole('button', { name: 'Send' }).click();

  const thinking = page.getByRole('group', { name: 'I’m processing…' });
  const current = thinking.locator('.summary .step-copy');
  await expect(current).toContainText(/Admin prepares your request to send to me/);
  chat.sendProgressEvent({
    type: 'progress', seq: 2, origin: 'team', phase: 'team-context', state: 'started',
  });
  await expect(current).toContainText(/I gather the context I need for your request/);
  chat.sendProgressEvent({
    type: 'progress', seq: 3, origin: 'team', phase: 'team-context', state: 'finished', elapsed_ms: 9,
  });
  await expect(current).toContainText(/Admin prepares your request to send to me/);

  chat.sendProgressEvent({
    type: 'progress', seq: 4, origin: 'admin', phase: 'admin-preparation',
    state: 'finished', elapsed_ms: 20,
  });
  await expect(current).toHaveText('Waiting for execution');
  chat.releaseReply();
  // The receipt lists only Team's steps, its one measured step and the rest of its clock; Admin's run outside it.
  await expect(page.locator('.receipt summary')).toHaveAccessibleName(/Execution stages recorded: 2$/);
});

test('shows a pending chat state before any server progress frame', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdProgressStart: true, holdReply: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Check progress');
  await page.getByRole('button', { name: 'Send' }).click();

  const thinking = page.getByRole('group', { name: 'I’m processing…' });
  await expect(thinking).toBeVisible();
  const liveStatus = page.locator('.conversation .live-status');
  await expect(liveStatus).toHaveAttribute('aria-live', 'polite');
  await expect(liveStatus).toHaveText('I’m processing…');
  await expect(composer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect.poll(() => chat.chatFrames().length).toBe(1);

  chat.releaseProgressStart();
  await expect(liveStatus).toHaveText(/Complete$/);
  chat.releaseReply();
  await expect(composer).toBeEnabled();
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
});

test('the composer sends 16,000 emoji and shows a reply longer than 60,000 UTF-16 units', async ({ page }) => {
  // Team and Admin bound chat text by Unicode code points; each emoji is two UTF-16 units.
  const message = '😀'.repeat(16_000);
  const chat = await routeReadyChat(page, { reply: `Accepted ${'😀'.repeat(30_001)}` });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await sendMessage(page, message);

  await expect.poll(() => chat.chatFrames().length).toBe(1);
  expect(chat.chatFrames()[0].message).toBe(message);
  await expect(page.getByText(/^Accepted 😀/)).toBeVisible();
  await expect(composer).toBeEnabled();
});

test('rejects an out-of-order first chat progress frame', async ({ page }) => {
  const chat = await routeReadyChat(page, { invalidProgressSequence: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  const synced = chat.syncFrames();
  await composer.fill('Check progress');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect(page.getByText('The secure chat response was invalid.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  await expect(page.getByText('Rendered answer', { exact: true })).toHaveCount(0);
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  // The channel attaches again on its own, so the person can send without reloading.
  await expect.poll(() => chat.syncFrames()).toBeGreaterThan(synced);
  await expect(composer).toBeEnabled();
  await composer.fill('Check progress again');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

// Every transition of the recall is proved in tests/prompt-history.test.js; each engine proves the composer applies a
// recall in place of the arrow key's own caret move and leaves a draft of the person's own alone.
test('recalls sent prompts from an empty Chat composer with ArrowUp and ArrowDown @browser-sensitive', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect.poll(() => chat.syncFrames()).toBeGreaterThan(0);
  await expect(composer).toBeEnabled();
  await composer.fill('First prompt');
  await send.click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEnabled();

  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');

  await composer.fill('Manual draft');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Manual draft');
});

test('restores durable Team history, terminal Assistant cards and older prompts after reload', async ({ page }) => {
  const firstTurn = 'a'.repeat(32);
  const secondTurn = 'b'.repeat(32);
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${secondTurn}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'List my Cloudflare DNS zones' },
        {
          id: `${secondTurn}:install`,
          created_at: HISTORY_AT,
          kind: 'assistant-install',
          state: 'installed',
          assistants: [{
            id: 'shimpz-cloudflare',
            name: 'Shimpz Cloudflare',
            summary: 'Safely manage Cloudflare DNS records through OAuth.',
            creator: '@shimpz',
            version: '0.4.5',
            providers: ['cloudflare'],
            provenance: 'local',
            status: 'installed',
          }],
        },
        {
          id: `${secondTurn}:reply`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'assistant',
          text: 'Your zone is example.com.',
          author: 'Marketing',
        },
      ],
      before: cursor,
    },
    olderHistory: {
      entries: [
        { id: `${firstTurn}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Install Cloudflare' },
        {
          id: `${firstTurn}:reply`,
          created_at: HISTORY_AT,
          kind: 'message',
          role: 'assistant',
          text: 'I will install the required Assistant.',
          author: 'Marketing',
        },
      ],
      before: null,
    },
  });

  await page.goto('/chat/');
  const task = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(task).toHaveCount(1);
  await expect(task).toHaveAttribute('data-state', 'complete');
  await expect(task).toContainText('Shimpz Cloudflare');
  await expect(page.getByText('Installed', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Your zone is example.com.', { exact: true })).toBeVisible();
  const turns = page.locator('.turns');
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByText('Install Cloudflare', { exact: true })).toBeAttached();
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);

  await page.reload();
  await expect(task).toHaveCount(1);
  await expect(page.getByText('Your zone is example.com.', { exact: true })).toBeVisible();
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByText('Install Cloudflare', { exact: true })).toBeAttached();
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor, null, cursor]);

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('List my Cloudflare DNS zones');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Install Cloudflare');
});

function longHistory(prefix, count, before, { detail = true } = {}) {
  const label = { d: 'Oldest', e: 'Earlier' }[prefix] ?? 'Recent';
  return {
    entries: Array.from({ length: count }, (_, index) => {
      const id = `${prefix}${String(index).padStart(31, '0')}`;
      return [
        { id: `${id}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: `${label} question ${index + 1}` },
        { id: `${id}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant',
          text: detail ? `${label} answer ${index + 1}\n\n${'Detail line. '.repeat(20).trim()}` : `${label} answer ${index + 1}`,
          author: 'Marketing' },
      ];
    }).flat(),
    before,
  };
}

test('loads earlier history only when the transcript is scrolled to its top', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 12, cursor),
    olderHistory: longHistory('e', 12, null),
  });
  await page.goto('/chat/');
  const turns = page.locator('.turns');
  await expect(page.getByText('Recent answer 12', { exact: false })).toBeInViewport();
  await expect(page.getByText('Recent question 1', { exact: true })).not.toBeInViewport();
  await page.waitForTimeout(300);
  await expect.poll(() => chat.historyRequests()).toEqual([null]);
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  await expect(turns).toHaveAccessibleDescription('Scroll up to load earlier messages.');

  await turns.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  // The prepended page keeps the message the reader was looking at in place.
  await expect(page.getByText('Recent question 1', { exact: true })).toBeInViewport();
  await expect(turns).not.toHaveAttribute('aria-describedby');
});

test('earlier history that arrives keeps an unrelated chat error on screen', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 12, cursor),
    olderHistory: longHistory('e', 12, null),
    terminalError: true,
  });
  await page.goto('/chat/');
  await expect(page.getByText('Recent answer 12', { exact: false })).toBeInViewport();
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Run the report');
  await composer.press('Enter');
  const failure = page.getByRole('alert').filter({ hasText: 'synthetic runtime failure' });
  await expect(failure).toBeVisible();

  await page.locator('.turns').evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  await expect(failure).toBeVisible();
});

test('keeps the message at the top of the transcript where it was once earlier history arrives @browser-sensitive', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  await routeReadyChat(page, {
    history: longHistory('f', 12, cursor),
    olderHistory: longHistory('e', 12, null),
  });
  let releaseOlder;
  const olderHeld = new Promise((resolve) => { releaseOlder = resolve; });
  await routeRead(page, 'history.page', async (params) => {
    if ('before' in params) await olderHeld;
    return undefined;
  });
  // A reader who asked for reduced motion gets every layout change at once, so it is measured with that setting.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/chat/');
  const turns = page.locator('.turns');
  await expect(page.getByText('Recent answer 12', { exact: false })).toBeInViewport();
  // The reader scrolls the transcript to its top with the wheel, as they reach earlier history; an engine may move
  // less than one gesture asks, so the reader keeps scrolling until the transcript is at its top, where the earlier
  // page is requested.
  const loading = page.getByRole('status').filter({ hasText: 'Loading earlier messages…' });
  // The recent page overflows the transcript, so only the reader's own scroll reaches the earlier page.
  expect(await turns.evaluate((element) => element.scrollHeight > element.clientHeight + 1000)).toBe(true);
  await expect(loading).toHaveCount(0);
  await turns.hover();
  await expect(async () => {
    await page.mouse.wheel(0, -((await turns.evaluate((element) => element.scrollTop)) + 1000));
    expect(await turns.evaluate((element) => element.scrollTop)).toBe(0);
  }).toPass();
  await expect(loading).toBeAttached();
  const reading = page.getByText('Recent question 1', { exact: true });
  const shownAt = async () => (await reading.boundingBox()).y;
  const before = await shownAt();
  releaseOlder();
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The reader's place is the message they were reading, not just any part of the screen.
  expect(Math.abs((await shownAt()) - before)).toBeLessThanOrEqual(2);
});

test('keeps the reader in place when they scroll while earlier history is loading', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 12, cursor),
    olderHistory: longHistory('e', 12, null),
  });
  let releaseOlder;
  const olderHeld = new Promise((resolve) => { releaseOlder = resolve; });
  await routeRead(page, 'history.page', async (params) => {
    if ('before' in params) await olderHeld;
    return undefined;
  });
  await page.goto('/chat/');
  const turns = page.locator('.turns');
  await expect(page.getByText('Recent answer 12', { exact: false })).toBeInViewport();

  const olderRequest = waitForRead(page, 'history.page', (params) => 'before' in params);
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await olderRequest;
  await expect(page.getByRole('status').filter({ hasText: 'Loading earlier messages…' })).toBeAttached();
  const reading = page.getByText('Recent question 6', { exact: true });
  await reading.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(reading).toBeInViewport();
  releaseOlder();
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  await expect(reading).toBeInViewport();
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
});

test('fills a short transcript through consecutive earlier pages', async ({ page }) => {
  const first = 'AAAAAAAAAAI';
  const second = 'AAAAAAAAABA';
  const chat = await routeReadyChat(page, { history: longHistory('f', 1, first, { detail: false }) });
  const pages = {
    [first]: longHistory('e', 1, second, { detail: false }),
    [second]: longHistory('d', 1, null, { detail: false }),
  };
  await routeRead(page, 'history.page', (params) => (params.before ? ok(pages[params.before]) : undefined));
  await page.goto('/chat/');
  await expect(page.getByText('Oldest question 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier question 1', { exact: true })).toBeVisible();
  await expect.poll(async () => (await readsOf(page, 'history.page')).map((params) => params.before ?? null))
    .toEqual([null, first, second]);
  await expect(page.locator('.turns')).not.toHaveAttribute('aria-describedby');
  await expect.poll(() => chat.historyRequests()).toEqual([null]);
});

test('offers a retry only after automatic earlier history fails', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 1, cursor),
    olderHistory: longHistory('e', 1, null),
  });
  let olderAttempts = 0;
  await routeRead(page, 'history.page', (params) => {
    if (!('before' in params)) return undefined;
    olderAttempts += 1;
    return olderAttempts > 2 ? undefined : ok({ detail: 'offline' }, 503);
  });
  await page.goto('/chat/');
  const retry = page.getByRole('button', { name: 'Load older messages' });
  await expect(retry).toBeVisible();
  await page.waitForTimeout(300);
  expect(olderAttempts).toBe(1);
  await expect(page.locator('.turns')).not.toHaveAttribute('aria-describedby');

  // The Retry leaves while the page is read: a read that fails again offers a new Retry, which takes the focus back.
  await retry.click();
  await expect.poll(() => olderAttempts).toBe(2);
  await expect(retry).toBeFocused();
  // One that succeeds gives the focus to the composer.
  await retry.click();
  await expect(page.getByText('Earlier question 1', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
  expect(olderAttempts).toBe(3);
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
});

test('an earlier-history retry gives nothing the focus once the person pressed elsewhere while it was read', async ({ page }) => {
  await routeReadyChat(page, { history: longHistory('f', 1, 'AAAAAAAAAAI'), olderHistory: longHistory('e', 1, null) });
  // The automatic read fails; each retry waits until the test releases it, and only the second one succeeds.
  let olderAttempts = 0;
  let release = () => {};
  await routeRead(page, 'history.page', async (params) => {
    if (!('before' in params)) return undefined;
    olderAttempts += 1;
    if (olderAttempts > 1) await new Promise((resolve) => { release = resolve; });
    return olderAttempts > 2 ? undefined : ok({ detail: 'offline' }, 503);
  });
  await page.goto('/chat/');
  const retry = page.getByRole('button', { name: 'Load older messages' });
  await expect(retry).toBeVisible();
  const onDocument = async () => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => document.activeElement === document.body);
  };

  // A press on the Admin version, which nothing focuses, leaves the focus on the document, as the person chose: the
  // new Retry of a read that fails again does not take it.
  await retry.click();
  await expect.poll(() => olderAttempts).toBe(2);
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(retry).toBeVisible();
  expect(await onDocument()).toBe(true);
  // Nor does the composer once a read succeeds.
  await retry.click();
  await expect.poll(() => olderAttempts).toBe(3);
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(page.getByText('Earlier question 1', { exact: true })).toBeVisible();
  expect(await onDocument()).toBe(true);
});

test("an earlier-history retry that fails once the person went back to another Team gives that Team's Retry no focus", async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  await routeReadyChat(page, { secondTeam: true, history: longHistory('f', 1, cursor), olderHistory: longHistory('e', 1, null) });
  // Neither Team's earlier history can be read, and Support's model selection cannot be read either, so its composer
  // never takes the focus; Marketing's second earlier read waits.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let marketingOlder = 0;
  let answered = false;
  await routeRead(page, 'history.page', async (params) => {
    if (params.team_id === 'support') {
      return 'before' in params ? ok({ detail: 'offline' }, 503) : ok(longHistory('c', 1, cursor));
    }
    if (!('before' in params)) return undefined;
    marketingOlder += 1;
    if (marketingOlder === 2) {
      await held;
      answered = true;
    }
    return ok({ detail: 'offline' }, 503);
  });
  await routeRead(page, 'inference.read', ({ team_id: teamId }) => (
    teamId === 'support' ? ok({ detail: 'unavailable' }, 503) : undefined
  ));
  await page.goto('/chat/?team=support');
  const retry = page.getByRole('button', { name: 'Load older messages' });
  await expect(retry).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Marketing', exact: true }).click();
  await expect(page).toHaveURL(/team=marketing/);
  await expect.poll(() => marketingOlder).toBe(1);
  await retry.click();
  await expect.poll(() => marketingOlder).toBe(2);
  // Going back to Support is nobody's move on the page; Marketing's discarded retry then gives Support's Retry nothing.
  await page.goBack();
  await expect(page).toHaveURL(/team=support/);
  await expect(retry).toBeVisible();
  release();
  await expect.poll(() => answered).toBe(true);
  // The session socket delivers in order: once the page reads what a later change asks for, it has Marketing's answer.
  const decisionReads = async () => (await readsOf(page, 'decision.read')).length;
  const before = await decisionReads();
  await raiseTopic(page, 'space/decision');
  await expect.poll(decisionReads).toBeGreaterThan(before);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(retry).not.toBeFocused();
});

test('stops automatic earlier history when a page does not advance its cursor', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 1, cursor),
    olderHistory: longHistory('e', 1, cursor),
  });
  await page.goto('/chat/');
  await expect(page.getByRole('button', { name: 'Load older messages' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
  await expect(page.getByText('Earlier question 1', { exact: true })).toHaveCount(0);
});

test('keeps focus on a message link when older history arrives @browser-sensitive', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const recent = 'c'.repeat(32);
  const earlier = 'd'.repeat(32);
  const chat = await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${recent}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Show the current status' },
        { id: `${recent}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant',
          text: 'Read the [current status](https://example.com/current).', author: 'Marketing' },
      ],
      before: cursor,
    },
    olderHistory: {
      entries: [
        { id: `${earlier}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Show the earlier status' },
        { id: `${earlier}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant',
          text: 'Earlier status is ready.', author: 'Marketing' },
      ],
      before: null,
    },
  });
  let releaseOlder;
  const olderHeld = new Promise((resolve) => { releaseOlder = resolve; });
  await routeRead(page, 'history.page', async (params) => {
    if ('before' in params) await olderHeld;
    return undefined;
  });

  const olderRequest = waitForRead(page, 'history.page', (params) => 'before' in params);
  await page.goto('/chat/');
  const link = page.getByRole('link', { name: 'current status' });
  await expect(link).toBeVisible();
  await olderRequest;
  await link.focus();
  await expect(link).toBeFocused();
  releaseOlder();
  await expect(page.getByText('Earlier status is ready.')).toBeVisible();
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
  await expect(link).toBeFocused();
});

test('restores the installed Assistant card after a successful OAuth return @browser-sensitive', async ({ page, baseURL }) => {
  const turnId = 'c'.repeat(32);
  const callbackPath = `/api/oauth/cloudflare/callback?state=${'s'.repeat(43)}&claim=${'c'.repeat(64)}`;
  let callbackObserved = false;
  const callbackServer = createServer((request, response) => {
    callbackObserved = request.url === callbackPath;
    response.writeHead(303, {
      'Cache-Control': 'no-store',
      Location: new URL('/chat', baseURL).href,
    });
    response.end();
  });
  await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const callbackAddress = callbackServer.address();
  if (!callbackAddress || typeof callbackAddress === 'string') {
    throw new Error('OAuth return test server did not bind a TCP address');
  }
  const chat = await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${turnId}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'List my Cloudflare DNS zones' },
        {
          id: `${turnId}:install`,
          created_at: HISTORY_AT,
          kind: 'assistant-install',
          state: 'installed',
          assistants: [{
            id: 'shimpz-cloudflare',
            name: 'Shimpz Cloudflare',
            summary: 'Safely manage Cloudflare DNS records through OAuth.',
            creator: '@shimpz',
            version: '0.4.5',
            providers: ['cloudflare'],
            provenance: 'local',
            status: 'installed',
          }],
        },
      ],
      before: null,
    },
  });
  await page.unroute('**/api/**');

  try {
    await page.goto(`http://127.0.0.1:${callbackAddress.port}${callbackPath}`);

    expect(callbackObserved).toBe(true);
    await expect(page).toHaveURL(/\/chat$/);
    const task = page.locator('.assistant-install-plan [data-slot="chat-task"]');
    await expect(task).toHaveCount(1);
    await expect(task).toHaveAttribute('data-state', 'complete');
    await expect(task).toContainText('Shimpz Cloudflare');
    await expect(page.getByText('Installed', { exact: true })).toHaveCount(1);
    await expect.poll(() => chat.historyRequests()).toEqual([null]);

    await page.reload();
    await expect(task).toHaveCount(1);
    await expect(task).toHaveAttribute('data-state', 'complete');
    await expect(page.getByText('Installed', { exact: true })).toHaveCount(1);
    await expect.poll(() => chat.historyRequests()).toEqual([null, null]);
  } finally {
    await new Promise((resolve, reject) => callbackServer.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test('restores an already-installed Assistant result from durable history', async ({ page }) => {
  const turnId = 'a'.repeat(32);
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${turnId}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Install Cloudflare' },
        {
          id: `${turnId}:install`,
          created_at: HISTORY_AT,
          kind: 'assistant-install',
          state: 'installed',
          outcome: 'already-installed',
          assistants: [{
            id: 'shimpz-cloudflare',
            name: 'Shimpz Cloudflare',
            summary: 'Safely manage Cloudflare DNS records through OAuth.',
            creator: '@shimpz',
            version: '0.4.5',
            providers: [],
            provenance: 'local',
            status: 'installed',
          }],
        },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');

  const task = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(task).toContainText('Already installed');
  await page.reload();
  await expect(task).toContainText('Already installed');
});

test('settles a failed Local install plan icon as unavailable instead of loading', async ({ page }) => {
  const turnId = 'b'.repeat(32);
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${turnId}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Install Cloudflare' },
        {
          id: `${turnId}:install`,
          created_at: HISTORY_AT,
          kind: 'assistant-install',
          state: 'failed',
          status: 503,
          assistants: [{
            id: 'shimpz-cloudflare',
            name: 'Shimpz Cloudflare',
            summary: 'Safely manage Cloudflare DNS records through OAuth.',
            creator: '@shimpz',
            version: '0.4.5',
            providers: [],
            provenance: 'local',
            status: 'failed',
          }],
        },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');

  const icon = page.locator('.assistant-install-plan .shimpz-assistant-icon');
  await expect(icon).toHaveAttribute('data-state', 'failed');
  await expect(icon.locator('img')).toHaveCount(0);
});

test('keeps chat available when durable history cannot be loaded', async ({ page }) => {
  await routeReadyChat(page, { historyStatus: 503, reply: 'The live chat still works.' });
  await page.goto('/chat/');

  const notice = page.locator('[data-slot="notice"].shimpz-notice--error');
  await expect(notice).toContainText('Local chat data is unavailable.');
  await expect(notice).toContainText('Synthetic history failure.');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Continue without restored history');
  await composer.press('Enter');
  await expect(page.getByText('The live chat still works.', { exact: true })).toBeVisible();
});

test('keeps the chat controls inert until durable history is ready', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdHistory: true });
  await page.goto('/chat/');

  const conversation = page.locator('.conversation');
  await expect(conversation).toHaveAttribute('inert', '');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeDisabled();
  chat.releaseHistory();
  await expect(conversation).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
});

test('restores the terminal uninstall outcome from durable history', async ({ page }) => {
  const turnId = 'c'.repeat(32);
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${turnId}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Uninstall Cloudflare' },
        {
          id: `${turnId}:uninstall`,
          created_at: HISTORY_AT,
          kind: 'assistant-uninstall',
          state: 'uninstalled',
          assistant: {
            id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1', creator: '@shimpz', provenance: 'local',
          },
          uninstalled: true,
        },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');

  const outcome = 'Shimpz Cloudflare v0.4.1 was uninstalled from Team Marketing.';
  const outcomeText = page.getByText(outcome, { exact: true });
  await expect(outcomeText).toBeVisible();
  await page.reload();
  await expect(outcomeText).toBeVisible();
  // An uninstalled Assistant has no icon left to fetch, so its frame settles as unavailable.
  const icon = page.locator('.assistant-lifecycle-task .shimpz-assistant-icon');
  await expect(icon).toHaveAttribute('data-state', 'failed');
});

test('installs a composed Assistant plan automatically and continues the original task', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    holdAssistantPlan: true,
    holdStop: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Configure my Cloudflare domain and send the result on WhatsApp');
  await composer.press('Enter');

  const tasks = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toContainText('Shimpz Cloudflare');
  await expect(tasks.nth(0)).toHaveAttribute('data-state', 'working');
  await expect(tasks.nth(1)).toContainText('WhatsApp');
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'pending');
  await expect(tasks.nth(0).locator('img')).toHaveCount(0);
  // Beside each name: Local only for a staged build, then the Creator and version Admin sent for it.
  const meta = tasks.locator('[data-slot="chat-task-meta"]');
  await expect(meta.nth(0)).toHaveText(/^Local.*@shimpz.*v0\.4\.5$/);
  await expect(meta.nth(1)).toHaveText(/^@meta.*v2\.1\.0$/);
  await expect(tasks.nth(1).locator('img')).toHaveAttribute(
    'src',
    '/api/assistants/whatsapp/catalog-icon',
  );
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  await expect(page.getByText(/confirmation required/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const installPlan = page.getByRole('group', { name: 'Assistant installation' });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeFocused();
  expect(await installPlan.getAttribute('tabindex')).toBeNull();
  expect(await installPlan.evaluate((element) => element.matches(':focus-visible'))).toBe(false);

  await stop.click();
  await expect(stop).toBeDisabled();
  await expect(page.locator('body')).toBeFocused();
  chat.advanceAssistantPlan();
  await expect(stop).toBeFocused();
  await expect(tasks.nth(0)).toHaveAttribute('data-state', 'complete');
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'working');
  chat.completeAssistantPlan();
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'complete');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeFocused();
  expect(await installPlan.evaluate((element) => element.matches(':focus-visible'))).toBe(false);
  chat.releaseAssistantPlan();
  await expect(tasks.nth(0).locator('img')).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  await expect(tasks.nth(1).locator('img')).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/whatsapp/icon',
  );
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  expect(chat.chatFrames()[0].message).toBe(
    'Configure my Cloudflare domain and send the result on WhatsApp',
  );
});

test('ends an explicit Assistant installation at the installed plan', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    assistantPlanContinuation: 'none',
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Install Cloudflare and WhatsApp');
  await composer.press('Enter');

  const tasks = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toHaveAttribute('data-state', 'complete');
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'complete');
  await expect(page.locator('.assistant-install-plan').locator('xpath=ancestor::article').locator('.markdown')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await expect(page.getByText('Rendered answer', { exact: true })).toHaveCount(0);

  await composer.fill('Please install it');
  await composer.press('Enter');
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect.poll(() => chat.chatFrames()).toHaveLength(2);
  expect(chat.chatFrames()[1].type).toBe('chat');
});

test('reports a repeated exact Assistant install from authoritative current state', async ({ page }) => {
  const chat = await routeReadyChat(page, { alreadyInstalledResult: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'instala o cloudflare');
  await composer.press('Enter');

  const task = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(task).toHaveCount(1);
  await expect(task).toHaveAttribute('data-state', 'complete');
  await expect(task).toContainText('Shimpz Cloudflare');
  await expect(task).toContainText('Already installed');
  await expect(page.getByText('Rendered answer', { exact: true })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
});

test('continues the requested task after confirming an explicitly named Assistant is running', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    alreadyInstalledResult: true,
    alreadyInstalledContinuation: 'dispatch',
    reply: 'Here are today\'s zones.',
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'instala o cloudflare e lista minhas zonas');
  await composer.press('Enter');

  const task = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('Already installed');
  await expect(page.getByText('Here are today\'s zones.', { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
});

test('installs a named Assistant, asks for its saved key just in time, and completes the task', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    storedInputAfterPlan: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'install Cloudflare and WhatsApp and list my zones');
  await composer.press('Enter');

  const tasks = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'complete');
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toBeVisible();
  await expect(composer).toBeDisabled();
  await dialog.getByLabel('Cloudflare API secret').fill('saved-third-party-secret');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  await expect.poll(() => chat.humanResponses()).toHaveLength(1);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('saved-third-party-secret');
});

test('recovers a just-in-time request from a just-installed Assistant after a same-Team reconnect', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    assistantPlan: true,
    storedInputAfterPlan: true,
    humanKind: 'input:password',
    humanAssistantId: 'whatsapp',
    omitPlannedWhatsappFromInventory: true,
    disconnectHumanResponse: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'install Cloudflare and WhatsApp and send the summary');
  await composer.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await dialog.getByLabel('Cloudflare API secret').fill('saved-third-party-secret');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => contract.humanResponses().length).toBe(1);
  await expect(dialog).toBeHidden();
  const syncsBeforeReconnect = contract.syncFrames();

  contract.disconnectHumanSocket();
  await expect.poll(() => contract.syncFrames()).toBeGreaterThan(syncsBeforeReconnect);
  await expect(page.getByRole('dialog', { name: 'Shimpz Cloudflare' })).toBeVisible();
  await expect(page.getByText('The secure chat response was invalid.')).toHaveCount(0);
});

test('admits a just-in-time request from an Assistant the refreshed Team inventory proves installed', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    storedInputAfterPlan: true,
    multipleIntegrations: true,
    humanAssistantId: 'shimpz-slack',
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'install Cloudflare and WhatsApp and post the summary in Slack');
  await composer.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('The secure chat response was invalid.')).toHaveCount(0);
  await dialog.getByLabel('Cloudflare API secret').fill('saved-third-party-secret');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect.poll(() => chat.humanResponses()).toHaveLength(1);
});

test('discards an inventory-pending just-in-time request after the turn stops', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    storedInputAfterPlan: true,
    multipleIntegrations: true,
    humanAssistantId: 'shimpz-slack',
    holdPostInstallInventory: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'install Cloudflare and WhatsApp and post the summary in Slack');
  await composer.press('Enter');
  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"]').nth(1)).toHaveAttribute(
    'data-state',
    'complete',
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(composer).toBeEnabled();
  chat.releaseAssistantInventory();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('The secure chat response was invalid.')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  expect(chat.humanResponses()).toHaveLength(0);
});

test('a message after an install waits for the Team inventory and names the installed Assistants', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    assistantPlanContinuation: 'none',
    holdPostInstallInventory: true,
  });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Install Cloudflare and WhatsApp');
  await composer.press('Enter');
  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"]').nth(1)).toHaveAttribute(
    'data-state',
    'complete',
  );
  await expect(composer).toBeEnabled();
  await composer.fill('List my zones');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await composer.press('Enter');
  expect(chat.chatFrames()).toHaveLength(1);

  chat.releaseAssistantInventory();
  await expect(send).toBeEnabled();
  await composer.press('Enter');
  await expect.poll(() => chat.chatFrames()).toHaveLength(2);
  expect(chat.chatFrames()[1]).toMatchObject({
    message: 'List my zones',
    assistant_ids: ['shimpz-cloudflare', 'whatsapp'],
  });
});

test('an install and the inventory read it causes never report the person\'s activity', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantPlan: true, assistantPlanContinuation: 'none' });
  await page.goto('/chat/');
  await sendUntrusted(page, 'Install Cloudflare and WhatsApp');
  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"]').nth(1)).toHaveAttribute(
    'data-state',
    'complete',
  );
  await expect.poll(async () => (await readsOf(page, 'assistants.list')).length).toBeGreaterThan(1);
  expect(chat.chatFrames()).toHaveLength(1);
  expect(await activityReports(page)).toBe(0);
});

test('an uninstall and the reads it causes never report the person\'s activity', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true });
  const reads = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/icon')) reads.push(path);
  });
  await page.goto('/chat/');
  await expect.poll(() => chat.syncFrames()).toBeGreaterThan(0);
  await sendUntrusted(page, 'Uninstall the Cloudflare Assistant');
  const task = page.locator('[data-slot="chat-task"]');
  const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();
  await uninstall.dispatchEvent('click');
  await expect(task).toHaveAttribute('data-state', 'complete');
  await expect.poll(() => reads.filter((path) => path.endsWith('/icon')).length).toBeGreaterThan(0);
  await expect.poll(async () => (await readsOf(page, 'assistants.list')).length).toBeGreaterThan(1);
  expect(await activityReports(page)).toBe(0);
});

test('a chat socket that opens and is closed again keeps backing off and says once that Admin cannot be reached', async ({ page }) => {
  await routeScenario(page, 'ready');
  // Admin accepts the socket and closes it after the page's first frame, as when it cannot check the session.
  let connections = 0;
  let syncs = 0;
  await routeChat(page, 'marketing', (socket) => {
    connections += 1;
    socket.onMessage(() => {
      syncs += 1;
      socket.close({ code: 1013, reason: 'Synthetic unavailable session check' });
    });
  });
  await freezeClock(page);
  await page.goto('/chat/?team=marketing');
  const reconnecting = page.getByText(messages.en.shell.reconnecting);
  const unreachable = page.getByText(messages.en.shell.reconnectFailed);
  // Each step waits until the page saw the close, then runs its clock past the longest backoff.
  for (let step = 0; step < 40; step += 1) {
    await expect.poll(() => syncs).toBe(connections);
    await expect(reconnecting.or(unreachable)).toBeVisible();
    if (await unreachable.isVisible()) break;
    const before = connections;
    await page.clock.runFor(30_000);
    await expect.poll(() => connections).toBeGreaterThan(before);
  }
  await expect(unreachable).toBeVisible();
  // The backoff kept the retries few, the chat said nothing of its own, and the socket keeps trying.
  expect(connections).toBeLessThan(25);
  await expect(page.getByText(messages.en.chatPage.connectionFailed)).toHaveCount(0);
  const before = connections;
  await page.clock.runFor(30_000);
  await expect.poll(() => connections).toBeGreaterThan(before);
});

test('a protocol violation ends the install it interrupts like a dropped connection', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantPlan: true, holdAssistantPlan: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Install Cloudflare and WhatsApp');
  await composer.press('Enter');
  const installing = page.locator('.assistant-install-plan [data-slot="chat-task"]').first();
  await expect(installing).toHaveAttribute('data-state', 'working');

  chat.sendProgressEvent({ type: 'unexpected' });
  await expect(page.getByText('The secure chat response was invalid.')).toBeVisible();
  await expect(installing).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"][data-state="working"]')).toHaveCount(0);
});

test('a Team that could not be created leaves the chat able to send to the selected Team', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await routeRead(page, 'teams.create', () => ok({ detail: 'Team is unavailable' }, 503));
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await page.locator('.shell-sidebar').getByRole('button', { name: 'New Team' }).click();
  const create = page.getByRole('dialog', { name: 'Create a Team' });
  await create.getByLabel('Team name').fill('Growth');
  await create.getByRole('button', { name: 'Create Team' }).click();
  await expect(create.getByText('The Team could not be created.')).toBeVisible();
  // The refusal gives the name field the request disabled its focus back.
  await expect(create.getByLabel('Team name')).toBeFocused();
  await create.getByRole('button', { name: 'Cancel' }).click();

  await fillWhenReady(page, composer, 'List my zones');
  await composer.press('Enter');
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  expect(chat.chatFrames()[0].assistant_ids).toEqual(['shimpz-cloudflare']);
});

test('shows the continued task execution stages after an explicit install', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantPlan: true, progressAfterPlan: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'install Cloudflare and WhatsApp and list my zones');
  await composer.press('Enter');

  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"]').nth(1)).toHaveAttribute(
    'data-state',
    'complete',
  );
  const thinking = page.getByRole('group', { name: 'I’m processing…' });
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('I work out how to handle your request');
  chat.releaseReply();
  await expect(page.getByText('Continued task complete.')).toBeVisible();
  await expect(thinking).toHaveCount(0);
});

test('does not trust an install-only plan for a later request from an Assistant missing in the inventory', async ({ page }) => {
  await routeReadyChat(page, {
    assistantPlan: true,
    assistantPlanContinuation: 'none',
    humanKind: 'approval',
    humanAssistantId: 'whatsapp',
    omitPlannedWhatsappFromInventory: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Install Cloudflare and WhatsApp');
  await composer.press('Enter');
  await expect(page.locator('.assistant-install-plan [data-slot="chat-task"]').nth(1)).toHaveAttribute(
    'data-state',
    'complete',
  );
  await expect(composer).toBeEnabled();
  await composer.fill('Send the WhatsApp summary');
  await composer.press('Enter');

  await expect(page.getByText('The secure chat response was invalid.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps reconnecting while Admin restarts for a release and recovers without a refresh', { tag: '@slow' }, async ({ page }) => {
  // Each refused upgrade really fails in the browser; the app's own reconnect delays run on the virtual clock.
  test.slow();
  await page.clock.install();
  // Six refused upgrades in a row, as a Local release swap causes.
  // Admin's own session check is unreachable for the first half of the outage and answers once Admin is back.
  const chat = await routeReadyChat(page, {
    disconnectFirstChat: true,
    refusedReconnects: 6,
    adminDownRefusals: 3,
    reply: 'Task complete.',
  });
  await page.goto('/chat/');

  await sendMessage(page, 'List my DNS zones');
  // One condition, one message: the shell says that Admin reconnects, and the chat adds no notice of its own.
  const reconnecting = page.getByText(messages.en.shell.reconnecting);
  await expect(reconnecting).toBeVisible();
  await expect(page.getByText(messages.en.chatPage.disconnected)).toHaveCount(0);

  // Each probe advances virtual time one second through the app's growing reconnect delays (about 22 s over six
  // refusals); probing every 100 ms of real time, instead of backing off to a second between probes, lets those
  // virtual seconds pass in a few real ones.
  const advanced = (probe) => async () => {
    await page.clock.runFor(1_000);
    return probe();
  };
  await expect.poll(advanced(() => chat.refusedConnections()), { timeout: 30_000, intervals: [100] }).toBe(6);
  await expect.poll(advanced(() => reconnecting.isVisible()), { timeout: 30_000, intervals: [100] }).toBe(false);
  await expect(page.getByText('The secure chat connection could not be established.', { exact: false })).toHaveCount(0);

  await sendMessage(page, 'List my DNS zones');
  await expect(page.getByText('Task complete.')).toBeVisible();
});

test('a session that expired while disconnected returns to sign-in instead of reconnecting', async ({ page }) => {
  await page.clock.install();
  const chat = await routeReadyChat(page, {
    disconnectFirstChat: true,
    refusedReconnects: Number.MAX_SAFE_INTEGER,
    expireSessionOnDisconnect: true,
  });
  await page.goto('/chat/');

  await sendMessage(page, 'List my DNS zones');
  // A dropped socket first asks Admin about the session (ADR-0114): signed out, it returns to sign-in at once and
  // never tries to reconnect.
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.clock.runFor(160_000);
  expect(chat.refusedConnections()).toBe(0);
  expect(chat.chatConnections()).toBe(1);
});

test('an expired session ends the chat connection instead of reconnecting', async ({ page }) => {
  await page.clock.install();
  const chat = await routeReadyChat(page, { expireSessionOnFirstChat: true });
  await page.goto('/chat/');

  await sendMessage(page, 'List my DNS zones');
  // Admin closing the socket as signed out (4401) returns to sign-in and clears what the session showed.
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toHaveCount(0);
  const connections = chat.chatConnections();
  await page.clock.runFor(60_000);
  expect(chat.chatConnections()).toBe(connections);
});

test('resumes one prior capability objective after reconnect and installs its Assistant', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    disconnectFirstChat: true,
    reply: 'Task complete.',
  });
  // The reconnect waits on the page's clock, held still until the test moves it, so the interruption stays shown
  // however slowly this runner looks for it.
  await freezeClock(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Lista minhas zonas DNS no Cloudflare');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(messages.en.shell.reconnecting)).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(composer).toBeEnabled();

  await composer.fill('Você mesmo consegue habilitar?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Task complete.')).toBeVisible();
  const resumed = page.locator('.resumed-task');
  await expect(resumed).toContainText('Resuming this task');
  await expect(resumed).toContainText('Lista minhas zonas DNS no Cloudflare');

  await expect.poll(() => chat.chatFrames()).toHaveLength(2);
  expect(chat.chatFrames()[1]).toEqual({
    type: 'resume-task',
    message: 'Você mesmo consegue habilitar?',
    objective: 'Lista minhas zonas DNS no Cloudflare',
    files: [],
    assistant_ids: [],
    objective_assistant_ids: [],
    locale: 'en',
    timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  const persistedBrowserState = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(persistedBrowserState).not.toContain('Lista minhas zonas DNS no Cloudflare');
  expect(persistedBrowserState).not.toContain('Você mesmo consegue habilitar?');
});

// The page renders every Assistant guidance code the same way (its reply, escaped); tests/local-chat.test.js admits
// exactly the known codes, so one code proves the rendering.
for (const [code, message, question] of [
  [
    'assistant-lifecycle-ambiguous',
    'mude o Assistant',
    ':error[Você quer instalar ou desinstalar um Assistant?]',
  ],
]) {
  test(`renders the ${code} lifecycle question`, async ({ page }) => {
    const chat = await routeReadyChat(page, {
      assistantGuidanceCode: code,
      assistantGuidanceReply: question,
    });
    await page.goto('/chat/');

    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await expect(composer).toBeEnabled();
    await composer.fill(message);
    await composer.press('Enter');

    await expect(page.getByText(question, { exact: true })).toBeVisible();
    await expect(page.locator('[data-slot="chat-task"]')).toHaveCount(0);
    await expect(page.locator('.chat-error')).toHaveCount(0);
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();

    await composer.fill('ok');
    await composer.press('Enter');
    await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
    expect(chat.chatFrames().map((frame) => frame.type)).toEqual(['chat', 'chat']);
  });
}

test('keeps target-required guidance valid when Stop races its response', async ({ page }) => {
  await routeReadyChat(page, {
    assistantGuidanceCode: 'assistant-uninstall-target-required',
    assistantGuidanceReply: 'Which installed Assistant do you want to uninstall?',
    holdTargetlessUninstallGuidance: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'desinstale');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  await expect(page.getByText(
    'Which installed Assistant do you want to uninstall?',
    { exact: true },
  )).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await expect(page.getByText('The secure chat response was invalid.', { exact: true })).toHaveCount(0);
});

test('a failed uninstall decision shows its error', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true, failUninstallDecision: true });
  await page.goto('/chat/');
  await sendMessage(page, 'Uninstall the Cloudflare Assistant');
  const uninstall = page.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();
  await uninstall.click();

  await expect(page.getByRole('alert').filter({ hasText: 'chat history is unavailable' })).toBeVisible();
  expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant', 'yes']);
});

test('a typed uninstall decision that fails shows its error', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true, failUninstallDecision: true });
  await page.goto('/chat/');
  await sendMessage(page, 'Uninstall the Cloudflare Assistant');
  await expect(page.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' })).toBeEnabled();
  await sendMessage(page, 'no');

  await expect(page.getByRole('alert').filter({ hasText: 'chat history is unavailable' })).toBeVisible();
  expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant', 'no']);
});

test('uninstalls an Assistant from the inline proposal and confirms Team absence', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantUninstall: true,
    holdAssistantIcon: true,
    holdAssistantUninstall: true,
    holdAssistantInventoryRefresh: true,
  });
  // The page's own clock decides when an icon snapshot gives up (2 s), never how fast this runner acts.
  await freezeClock(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect.poll(() => chat.syncFrames()).toBeGreaterThan(0);
  await expect(composer).toBeEnabled();
  await composer.fill('Uninstall the Cloudflare Assistant');
  await page.getByRole('button', { name: 'Send' }).click();

  const task = page.locator('[data-slot="chat-task"]');
  await expect(task).toHaveAttribute('data-state', 'pending');
  await expect(page.getByText(
    'Shimpz Cloudflare is installed in this Team. I can uninstall it after you authorize it.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(
    'Shimpz Cloudflare is installed. Should I uninstall it from this Team?',
    { exact: true },
  )).toHaveCount(0);
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  await expect(task).toContainText('Assistant uninstall');
  await expect(task).toContainText('Confirmation required');
  await expect(task).toContainText(
    'The Assistant leaves this Team, along with the accounts connected to it and any tasks in progress.',
  );
  await expect(task.locator('[data-slot="chat-task-meta"]')).toHaveText(/^Local.*@shimpz.*v0\.4\.1$/);
  // The proposal's decision is its two actions alone.
  await expect(task.locator('[data-slot="chat-task-details"]')).toHaveText(/^\s*Cancel\s*Uninstall\s*$/);
  const icon = task.locator('img');
  await expect(icon).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  await expect(task.getByRole('button', { name: 'Cancel uninstalling Shimpz Cloudflare' }))
    .toBeEnabled();
  const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();

  // The snapshot started with the proposal gives up; approving starts a new one that the decision waits for.
  await page.clock.runFor(2100);
  await uninstall.click();
  await expect(task).toHaveAttribute('data-state', 'pending');
  await expect.poll(() => chat.chatFrames()).toHaveLength(1);
  chat.releaseAssistantIcon();
  await expect(page.getByText('yes', { exact: true })).toHaveCount(0);
  await expect(task).toHaveAttribute('data-state', 'working');
  await expect(task).toBeFocused();
  chat.releaseAssistantUninstall();

  await expect(task).toHaveAttribute('data-state', 'complete');
  await expect(task).toContainText('Uninstalled');
  await expect(page.getByText(
    'Shimpz Cloudflare v0.4.1 was uninstalled from Team Marketing.',
    { exact: true },
  )).toHaveCount(0);
  chat.releaseAssistantInventory();
  await expect(task.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  const completedIcon = await task.locator('img').getAttribute('src');
  expect(await page.evaluate(async () => (
    await fetch('/api/teams/marketing/assistants/shimpz-cloudflare/icon')
  ).status)).toBe(404);
  await expect(task.locator('img')).toHaveAttribute('src', completedIcon);
  await expect(task.getByRole('button')).toHaveCount(0);
  const outcome = page.locator('.shimpz-message--assistant').last();
  await expect(outcome).toContainText(
    'Shimpz Cloudflare v0.4.1 was uninstalled from Team Marketing.',
  );
  await expect(outcome).toContainText(
    'A published release can be installed again. For a Local build, its snapshot remains staged and can be installed again.',
  );
  await expect(outcome).not.toContainText('docker image rm');
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  expect(chat.assistantIconRequests().some((url) => url.includes('/catalog-icon'))).toBe(false);

  await composer.fill('What can this Team do now?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  expect(chat.chatFrames().at(-1).assistant_ids).toEqual([]);
});

// An approval waits for the uninstall icon snapshot; it answers only the proposal it was given for, on the connection
// that proposed it, so an expiry, a reconnect, or a Team change during that wait sends nothing.
for (const [interruption, interrupt] of [
  ['the proposal expires', async (page) => {
    await page.clock.runFor(2100);
    await expect(page.locator('[data-slot="chat-task"]')).toHaveAttribute('data-state', 'cancelled');
  }],
  ['the connection drops', async (page, chat) => {
    chat.closeChatSocket();
    // The page asks Admin about its session before it reconnects; the paused clock moves until the channel is back.
    await expect.poll(async () => {
      await page.clock.runFor(100);
      return chat.syncFrames();
    }).toBe(2);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    await page.clock.runFor(2100);
    await expect(page.locator('[data-slot="chat-task"]')).toHaveAttribute('data-state', 'cancelled');
  }],
  ['the Team changes', async (page, chat) => {
    await page.locator('.shell-sidebar').getByRole('link', { name: 'Support', exact: true }).click();
    // The page's paused clock moves in short steps, well inside the snapshot's two seconds, while Support opens.
    await expect.poll(async () => {
      await page.clock.runFor(20);
      return chat.supportFrames().some((frame) => frame.type === 'sync');
    }).toBe(true);
    await expect(page).toHaveURL(/team=support/);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  }],
]) {
  test(`an uninstall approval sends nothing when ${interruption} while its icon is captured`, async ({ page }) => {
    const chat = await routeReadyChat(page, { assistantUninstall: true, holdAssistantIcon: true, secondTeam: true });
    await freezeClock(page);
    await page.goto('/chat/');
    await expect.poll(() => chat.syncFrames()).toBe(1);
    await sendMessage(page, 'Uninstall the Cloudflare Assistant');
    const task = page.locator('[data-slot="chat-task"]');
    const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
    await expect(uninstall).toBeEnabled();
    // The snapshot started with the proposal gives up, and the proposal (120 s) nears its expiry.
    await page.clock.runFor(2100);
    await page.clock.runFor(116_000);
    await uninstall.click();
    await interrupt(page, chat);
    chat.releaseAssistantIcon();

    await page.clock.runFor(1000);
    expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant']);
    expect(chat.supportFrames().filter((frame) => frame.type !== 'sync')).toEqual([]);
  });
}

test('a Stop that crosses an uninstall proposal leaves the proposal to answer', async ({ page }) => {
  // Admin answers nothing to a Stop that finds the turn already ended by its proposal.
  const chat = await routeReadyChat(page, { assistantUninstall: true, holdUninstallProposal: true, holdStop: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Uninstall the Cloudflare Assistant');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  chat.releaseUninstallProposal();

  const task = page.locator('[data-slot="chat-task"]');
  const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();
  await expect(page.getByText('The secure chat response was invalid.')).toHaveCount(0);
  await uninstall.click();
  await expect(task).toHaveAttribute('data-state', 'complete');
  expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant', 'yes']);
  expect(chat.chatConnections()).toBe(1);
});

test('an uninstall whose inventory could not be confirmed completes once the chat reads it again', async ({ page }) => {
  await routeReadyChat(page, { assistantUninstall: true });
  let failInventory = false;
  // A refused read, not an outage, which would only be read again until it answers.
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (
    failInventory && teamId === 'marketing' ? ok({ assistants: 'unreadable' }) : undefined
  ));
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Uninstall the Cloudflare Assistant');
  await composer.press('Enter');
  const task = page.locator('[data-slot="chat-task"]');
  failInventory = true;
  await task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' }).click();
  const unconfirmed = page.getByText(
    'The Assistant uninstall completed, but its absence from the Team inventory could not be confirmed.',
  );
  await expect(unconfirmed).toBeVisible();
  const outcome = page.getByText('Shimpz Cloudflare v0.4.1 was uninstalled from Team Marketing.', { exact: true });
  await expect(outcome).toHaveCount(0);

  // A keyboard user retries while the read keeps failing: the focus stays on the Retry each time.
  const retry = page.getByRole('button', { name: 'Retry local data' });
  await retry.focus();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.keyboard.press('Enter');
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    await expect(unconfirmed).toBeVisible();
  }
  failInventory = false;
  await page.keyboard.press('Enter');
  await expect(outcome).toBeVisible();
  await expect(unconfirmed).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await expect(outcome).toHaveCount(1);
});

test('never falls back to the Store icon when model context leaves an uninstall card', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantUninstall: true,
    holdInferenceWrite: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Uninstall the Cloudflare Assistant');
  await page.getByRole('button', { name: 'Send' }).click();
  const task = page.locator('[data-slot="chat-task"]');
  await expect(task.locator('img')).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );

  await page.getByRole('button', { name: 'Brain: GPT-6.1 Sol' }).click();
  await page.getByRole('dialog', { name: 'Brain settings' }).getByRole('button', { name: /GPT-6 Luna/ }).click();
  await expect.poll(chat.inferenceWrites).toBe(1);
  await expect.poll(
    () => chat.assistantIconRequests().some((url) => url.includes('/catalog-icon')),
  ).toBe(false);

  chat.releaseInferenceWrite();
});

test('cancels an Assistant uninstall without projecting a confirmation reply', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Uninstall the Cloudflare Assistant');
  await page.getByRole('button', { name: 'Send' }).click();
  const task = page.locator('[data-slot="chat-task"]');
  await task.getByRole('button', { name: 'Cancel uninstalling Shimpz Cloudflare' }).click();

  await expect(page.getByText('no', { exact: true })).toHaveCount(0);
  await expect(task).toHaveAttribute('data-state', 'cancelled');
  await expect(task).toContainText('Cancelled');
  await expect(task.getByRole('button')).toHaveCount(0);
  await expect(composer).toBeFocused();

  await composer.fill('pode instalar');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The Team could not complete this turn.')).toBeVisible();
  expect(chat.chatFrames().at(-1).type).toBe('chat');
});

test('renders and clears a persistent Action input without exposing its value', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    whatsappInstalled: true,
    storedInputStatus: 'stored',
  });
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const storedInputs = drawer.getByRole('region', { name: 'Stored Action inputs' });
  await expect(storedInputs.getByText('WhatsApp', { exact: true })).toBeVisible();
  await expect(storedInputs.getByText('whatsapp-token', { exact: true })).toBeVisible();
  const rowIcon = storedInputs.locator('.stored-input-row .shimpz-assistant-icon img');
  await expect(rowIcon).toHaveAttribute('src', '/api/teams/marketing/assistants/whatsapp/icon');
  await expect(storedInputs.getByText('Stored securely. Future Actions reuse it.', { exact: true }))
    .toBeVisible();
  await expect(drawer).not.toContainText('must-not-cross');

  await storedInputs.getByRole('button', { name: 'Clear', exact: true }).click();

  await expect(storedInputs.getByText('Requested just in time on first use.', { exact: true }))
    .toBeVisible();
  await expect(storedInputs.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
  expect(chat.storedInputClears()).toBe(1);
  // The Clear pressed left with the input it cleared; with no other input to clear, the drawer's Close takes the focus.
  await expect(drawer.getByRole('button', { name: 'Close integrations' })).toBeFocused();
});

test('a Stored Input cleared after the person pressed elsewhere gives nothing the focus', async ({ page }) => {
  await routeReadyChat(page, { whatsappInstalled: true, storedInputStatus: 'stored' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await routeRead(page, 'stored_inputs.clear', async () => {
    await held;
    return undefined;
  });
  await page.goto('/chat/');
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const storedInputs = drawer.getByRole('region', { name: 'Stored Action inputs' });
  await storedInputs.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(storedInputs.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
  // A press on the Admin version, which nothing focuses, leaves the focus on the document, as the person chose.
  await page.getByText(/^Admin (?:dev|v\d)/).click();
  release();
  await expect(storedInputs.getByText('Requested just in time on first use.', { exact: true })).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('a Stored Input that could not be cleared keeps its Clear, which takes the focus back', async ({ page }) => {
  await routeReadyChat(page, { whatsappInstalled: true, storedInputStatus: 'stored' });
  await routeRead(page, 'stored_inputs.clear', () => ok({ detail: 'unavailable' }, 503));
  await page.goto('/chat/');
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const clear = drawer.getByRole('region', { name: 'Stored Action inputs' }).getByRole('button', { name: 'Clear', exact: true });
  await clear.click();
  await expect(page.getByText('The stored Action input could not be cleared.').first()).toBeVisible();
  await expect(clear).toBeFocused();
});

test('a cleared Stored Input shows what Admin reads afterwards, never the clear\'s own answer', async ({ page }) => {
  await routeReadyChat(page, { whatsappInstalled: true, storedInputStatus: 'stored' });
  // Admin answers the clear but still holds the input when the drawer reads it again.
  await routeRead(page, 'stored_inputs.clear', () => ok({ cleared: true }));
  await page.goto('/chat/');
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const storedInputs = drawer.getByRole('region', { name: 'Stored Action inputs' });
  await expect(storedInputs.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();
  const reads = (await readsOf(page, 'stored_inputs.list')).length;
  await storedInputs.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect.poll(async () => (await readsOf(page, 'stored_inputs.list')).length).toBeGreaterThan(reads);
  await expect(storedInputs.getByText('Stored securely. Future Actions reuse it.', { exact: true })).toBeVisible();
  await expect(storedInputs.getByRole('button', { name: 'Clear', exact: true })).toBeEnabled();
});

test('toggles an Assistant integration through its unavailable icon', async ({ page }) => {
  await routeReadyChat(page);
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare/icon', (route) => route.fulfill({ status: 404 }));
  await page.goto('/chat/');
  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const icon = drawer.locator('.assistant-group .shimpz-assistant-icon');
  await expect(icon).toHaveAttribute('data-state', 'failed');
  await expect(icon.locator('img')).toBeHidden();

  const toggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-cloudflare"]');
  const iconBox = await icon.boundingBox();
  expect(iconBox).not.toBeNull();
  await page.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('opens and closes an Assistant integration from the whole card header', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const toggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-cloudflare"]');
  const cardHeader = drawer.locator('.assistant-group > [data-slot="card-header"]').first();
  const cardHeaderBox = await cardHeader.boundingBox();
  expect(cardHeaderBox).not.toBeNull();

  await cardHeader.click({ position: { x: 24, y: cardHeaderBox.height / 2 } });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await cardHeader.click({ position: { x: cardHeaderBox.width * 0.6, y: cardHeaderBox.height / 2 } });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('keeps only one Assistant integration card expanded', async ({ page }) => {
  await routeReadyChat(page, { multipleIntegrations: true });
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  const cloudflareToggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-cloudflare"]');
  const slackToggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-slack"]');
  await expect(drawer.getByText('v0.1.0', { exact: true })).toBeVisible();

  await cloudflareToggle.click();
  await expect(cloudflareToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(slackToggle).toHaveAttribute('aria-expanded', 'false');

  await slackToggle.click();
  await expect(cloudflareToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(slackToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByText('Inspect Cloudflare zones and safely manage common DNS records through OAuth.')).toBeHidden();
  await expect(drawer.getByText('Send reviewed messages to Slack.')).toBeVisible();
});

test('shows an expanded Assistant summary only in the interface language', async ({ page }) => {
  await routeReadyChat(page, { multipleIntegrations: true });
  const summaryLocales = async () => (await readsOf(page, 'assistants.summary')).map((params) => params.locale);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.locator('#assistant-integrations-drawer');
  const cloudflareToggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-cloudflare"]');
  const slackToggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-slack"]');
  await cloudflareToggle.click();
  await expect(drawer.getByText(INSTALLED_SUMMARIES['shimpz-cloudflare'].en)).toBeVisible();

  // The language changes while the drawer stays open; on a phone the open drawer covers the menu, so use the keyboard.
  await page.getByRole('button', { name: 'Language: English' }).press('Enter');
  await page.getByRole('menuitemradio', { name: 'Português' }).press('Enter');
  await expect(drawer.getByText(INSTALLED_SUMMARIES['shimpz-cloudflare'].pt)).toBeVisible();
  await expect(drawer.getByText(INSTALLED_SUMMARIES['shimpz-cloudflare'].en)).toHaveCount(0);

  // A summary Team cannot read in this language stays empty instead of falling back to English.
  await slackToggle.click();
  await expect(slackToggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(summaryLocales).toEqual(['en', 'pt', 'pt']);
  await expect(drawer.getByText(INSTALLED_SUMMARIES['shimpz-slack'].en)).toHaveCount(0);
  await expect(drawer.locator('#assistant-integration-group-shimpz-slack p')).toHaveCount(0);
});

test('presents individual authorization controls for every pending Integration', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeOpen = window.open;
    window.open = function captureAuthorizationState(...args) {
      const buttons = [...document.querySelectorAll('dialog[open] button')];
      const authorizeButton = buttons.find((button) => button.textContent?.includes('Opening'));
      window.authorizationStateAtOpen = {
        disabled: authorizeButton?.disabled ?? false,
        text: authorizeButton?.textContent?.trim() ?? '',
      };
      return nativeOpen.apply(this, args);
    };
  });
  await routeReadyChat(page, {
    integrationChallenge: true,
    oauthCompletionMode: 'code',
    whatsappInstalled: true,
    integrationRequirements: [
      {
        assistant_id: 'shimpz-cloudflare',
        assistant_name: 'Shimpz Cloudflare',
        integration_id: 'cloudflare-zones',
        provider: 'cloudflare',
        name: 'Cloudflare zones',
        scopes: ['zone.read'],
        actions: [{ id: 'list-zones' }],
      },
      {
        assistant_id: 'whatsapp',
        assistant_name: 'WhatsApp',
        integration_id: 'whatsapp-messages',
        provider: 'whatsapp',
        name: 'WhatsApp messages',
        scopes: ['messages.write'],
        actions: [{ id: 'send-message' }],
      },
    ],
  });
  // The authorization stays unanswered: the popup has opened on the click before Admin answers anything.
  let authorizeParams;
  await routeRead(page, 'integrations.authorize', (params) => {
    authorizeParams = params;
    return new Promise(() => {});
  });
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Review my DNS');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a required account' });
  await expect(dialog.getByText('zone.read', { exact: true })).toBeVisible();
  await expect(dialog.getByText('messages.write', { exact: true })).toBeVisible();
  const zoneAuthorize = dialog.getByRole('button', { name: 'Authorize on Cloudflare — Cloudflare zones' });
  const messageAuthorize = dialog.getByRole('button', { name: 'Authorize on WhatsApp — WhatsApp messages' });
  await expect(zoneAuthorize).toBeEnabled();
  await expect(messageAuthorize).toBeEnabled();
  const popupPromise = page.waitForEvent('popup');
  await messageAuthorize.click();
  const popup = await popupPromise;
  expect(await page.evaluate(() => window.authorizationStateAtOpen)).toEqual({
    disabled: true,
    text: 'Opening WhatsApp…',
  });
  await expect(messageAuthorize).toBeDisabled();
  await expect(zoneAuthorize).toBeDisabled();
  await expect.poll(() => Boolean(authorizeParams)).toBe(true);
  expect(authorizeParams.body).toEqual({
    assistant_id: 'whatsapp',
    integration_id: 'whatsapp-messages',
  });
  await popup.close();
});

// Each pending Integration explains its provider in the Supervisor's language; Team's English provider text never
// reaches the browser, so a row in English or without an explanation fails.
for (const [language, send, title, copy] of [
  ['pt', 'Enviar', 'Conecte uma conta necessária', (provider) => (
    `Conecte sua conta ${provider} para que este assistente use apenas as permissões revisadas do ${provider}.`
  )],
  ['ar', 'إرسال', 'اربط حسابًا مطلوبًا', (provider) => (
    `اربط حسابك على ${provider} ليستخدم هذا المساعد صلاحيات ${provider} المراجعة فقط.`
  )],
]) {
  test(`the ${language} multi-Integration consent explains every provider in the interface language`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('shimpz_lang', lang), language);
    await routeReadyChat(page, {
      integrationChallenge: true,
      whatsappInstalled: true,
      integrationRequirements: [
        {
          assistant_id: 'shimpz-cloudflare',
          assistant_name: 'Shimpz Cloudflare',
          integration_id: 'cloudflare-zones',
          provider: 'cloudflare',
          name: 'Cloudflare zones',
          scopes: ['zone.read'],
          actions: [{ id: 'list-zones' }],
        },
        {
          assistant_id: 'whatsapp',
          assistant_name: 'WhatsApp',
          integration_id: 'whatsapp-messages',
          provider: 'whatsapp',
          name: 'WhatsApp messages',
          scopes: ['messages.write'],
          actions: [{ id: 'send-message' }],
        },
      ],
    });
    await page.goto('/chat/');
    await page.getByRole('textbox', { name: send, exact: true }).fill('Review my DNS');
    await page.getByRole('button', { name: send, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog.getByText(copy('Cloudflare'), { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy('WhatsApp'), { exact: true })).toBeVisible();
  });
}

// Informed authorization: the consent names the requesting Action, Assistant, version, and scopes in the
// Supervisor's language, so a dialog attributing the grant to the wrong Assistant or Action fails.
for (const [language, route, expected] of [
  ['en', { integrationChallenge: true }, {
    send: 'Send', dialog: 'Connect your Cloudflare account', identity: ['list-zones', 'Shimpz Cloudflare', 'v0.4.1'],
    scope: 'dns.read', authorize: /Cloudflare/,
  }],
  ['pt', {
    integrationChallenge: true,
    integrationRequirements: [{
      assistant_id: 'shimpz-cloudflare',
      assistant_name: 'Social Publisher',
      integration_id: 'x-integration',
      provider: 'x',
      name: 'X',
      scopes: ['tweet.read', 'tweet.write'],
      actions: [{ id: 'publish-post' }],
    }],
  }, {
    send: 'Enviar', dialog: 'Conecte sua conta X', identity: ['publish-post', 'Social Publisher', 'v0.4.1'],
    scope: 'tweet.write', authorize: /X/,
  }],
]) {
  test(`the ${language} Integration consent names the requesting Action, Assistant, and version`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('shimpz_lang', lang), language);
    await routeReadyChat(page, route);
    await page.goto('/chat/');
    await page.getByRole('textbox', { name: expected.send, exact: true }).fill('List the zones');
    await page.getByRole('button', { name: expected.send, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: expected.dialog });
    for (const identity of expected.identity) await expect(dialog).toContainText(identity);
    await expect(dialog.getByText(expected.scope, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: expected.authorize }).first()).toBeEnabled();
  });
}

test('uses the automatic Local OAuth handoff without opening a blank tab', async ({ page }) => {
  const challengeId = 'b'.repeat(32);
  const authorizationUrl = `http://127.0.0.1:4173/api/oauth/cloudflare/start?handoff=${'a'.repeat(64)}`;
  let popupCount = 0;
  page.on('popup', () => { popupCount += 1; });
  await routeReadyChat(page, { integrationChallenge: true, oauthCompletionMode: 'automatic' });
  await routeRead(page, 'integrations.authorize', (params) => (params.challenge_id === challengeId
    ? ok({ authorization_url: authorizationUrl, completion_mode: 'automatic' })
    : undefined));
  await page.route(authorizationUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Automatic Cloudflare OAuth handoff</title>',
  }));
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await Promise.all([
    page.waitForURL(authorizationUrl),
    dialog.getByRole('button', { name: 'Authorize on Cloudflare' }).click(),
  ]);

  await expect(page).toHaveTitle('Automatic Cloudflare OAuth handoff');
  expect(popupCount).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
});

test('cancels an authorization response that disagrees with the projected session mode', async ({ page }) => {
  const challengeId = 'b'.repeat(32);
  const authorizationUrl = 'https://shimpz.com/api/oauth/cloudflare/start?'
    + `state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`
    + '&scope=dns.read+dns.write+offline_access+zone.read&callback=out-of-band';
  let canceled = false;
  let popupCount = 0;
  page.on('popup', () => { popupCount += 1; });
  await routeReadyChat(page, { integrationChallenge: true, oauthCompletionMode: 'automatic' });
  await routeRead(page, 'integrations.authorize', (params) => (params.challenge_id === challengeId
    ? ok({ authorization_url: authorizationUrl, completion_mode: 'code' })
    : undefined));
  await routeRead(page, 'integrations.cancel', (params) => {
    if (params.challenge_id !== challengeId) return undefined;
    canceled = true;
    return ok({}, 204);
  });
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await dialog.getByRole('button', { name: 'Authorize on Cloudflare' }).click();

  await expect.poll(() => canceled).toBe(true);
  await expect(dialog).toContainText('The secure authorization could not start.');
  expect(popupCount).toBe(0);
  expect(page.context().pages()).toHaveLength(1);
});

test('opens the built Local app code flow in a separate tab', async ({ page }) => {
  const challengeId = 'b'.repeat(32);
  const authorizationUrl = 'https://shimpz.com/api/oauth/cloudflare/start?'
    + `state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`
    + '&scope=dns.read+dns.write+offline_access+zone.read&callback=out-of-band';
  await routeReadyChat(page, { integrationChallenge: true, oauthCompletionMode: 'code' });
  await routeRead(page, 'integrations.authorize', (params) => (params.challenge_id === challengeId
    ? ok({ authorization_url: authorizationUrl, completion_mode: 'code' })
    : undefined));
  await page.context().route(authorizationUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Cloudflare OAuth authorization</title>',
  }));
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await expect(dialog.getByText('dns.write', { exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Authorize on Cloudflare' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(authorizationUrl);
  await expect(popup).toHaveTitle('Cloudflare OAuth authorization');
  const completion = page.getByRole('dialog', { name: 'Paste the completion code' });
  await expect(completion).toBeVisible();
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  // The code the provider shows goes in the field that replaced the Authorize pressed, which has the focus.
  const code = completion.getByLabel('One-time completion code');
  await expect(code).toBeFocused();

  // A code Admin refuses keeps the dialog, and its field takes the focus back for another code.
  await routeRead(page, 'integrations.complete', () => ok({ detail: 'refused' }, 400));
  await code.fill('completion-code-1');
  await completion.getByRole('button', { name: 'Finish connection' }).click();
  await expect(completion).toContainText('The secure authorization could not finish.');
  await expect(code).toBeFocused();
});

test('cancels code-mode OAuth when the browser blocks its separate tab', async ({ page }) => {
  const challengeId = 'b'.repeat(32);
  const authorizationUrl = 'https://shimpz.com/api/oauth/cloudflare/start?'
    + `state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`
    + '&scope=dns.read+dns.write+offline_access+zone.read&callback=out-of-band';
  let canceled = false;
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await routeReadyChat(page, { integrationChallenge: true, oauthCompletionMode: 'code' });
  await routeRead(page, 'integrations.authorize', (params) => (params.challenge_id === challengeId
    ? ok({ authorization_url: authorizationUrl, completion_mode: 'code' })
    : undefined));
  await routeRead(page, 'integrations.cancel', (params) => {
    if (params.challenge_id !== challengeId) return undefined;
    canceled = true;
    return ok({}, 204);
  });
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await dialog.getByRole('button', { name: 'Authorize on Cloudflare' }).click();
  await expect.poll(() => canceled).toBe(true);
  await expect(dialog).toContainText('The secure authorization could not start.');
  // The authorization disabled the button pressed, which takes the focus back for another try.
  await expect(dialog.getByRole('button', { name: 'Authorize on Cloudflare' })).toBeFocused();
});

// The exact value each kind submits.
const humanValues = {
  'input:textarea': 'Reviewed value',
  'input:phone': '+1 415 555 0123',
  'input:select': 'safe',
  'input:choices': ['safe'],
  'auth:password': 'supervisor-password',
};

// Approval and input:choice are completed in localized-requests.spec.js, input:text by the code-point bound test below,
// and input:password, always a Stored Input, by the Stored Input request tests.
const humanPresentations = [
  ['input:textarea', 'Provide the missing Action context'],
  ['input:phone', 'Provide the missing Action context'],
  ['input:select', 'Provide the missing Action context'],
  ['input:choices', 'Provide the missing Action context'],
  ['auth:password', 'Confirm with your Supervisor password'],
];

for (const [kind, title] of humanPresentations) {
  test(`completes the ${kind} Action request with its exact value`, async ({ page }) => {
    await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
    const contract = await routeReadyChat(page, { humanKind: kind });
    await page.goto('/chat/');
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await composer.fill('Continue with the reviewed Action');
    await page.getByRole('button', { name: 'Send' }).click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    // Beside its Creator-authored title, the request names the reviewed Assistant and the exact version it authorizes.
    await expect(dialog).toContainText('Shimpz Cloudflare · v0.4.1');
    // A secret is never typed into a visible field.
    if (kind === 'auth:password') {
      await expect(dialog.getByLabel('Supervisor password')).toHaveAttribute('type', 'password');
    }

    if (kind === 'input:textarea') {
      await dialog.getByLabel(/Response/).fill('Reviewed value');
    } else if (kind === 'input:phone') {
      await dialog.getByLabel(/Contact phone/).fill('+1 415 555 0123');
    } else if (kind === 'input:select') {
      await dialog.getByRole('combobox').selectOption('safe');
    } else if (kind === 'input:choices') {
      await dialog.getByRole('checkbox', { name: /Safe mode/ }).check();
    } else if (kind === 'auth:password') {
      await dialog.getByLabel('Supervisor password').fill('supervisor-password');
    }
    await dialog.getByRole('button', { name: kind.startsWith('auth:') ? 'Confirm authorization' : 'Send' }).click();
    await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
    await expect.poll(() => contract.humanResponses()).toHaveLength(1);
    expect(contract.humanResponses()[0]).toMatchObject({
      type: 'human-response',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      decision: 'submit',
      ...(kind in humanValues ? { value: humanValues[kind] } : {}),
    });
  });
}

test('bounds a human text response in Unicode code points like the Admin backend', async ({ page }) => {
  const contract = await routeReadyChat(page, { humanKind: 'input:text' });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Continue with the reviewed Action');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Provide the missing Action context' });
  await expect(dialog).toContainText('Shimpz Cloudflare · v0.4.1');
  const field = dialog.getByLabel(/Response/);
  const send = dialog.getByRole('button', { name: 'Send' });
  // The fixture bounds input:text to 64 code points; each emoji is two UTF-16 code units.
  const atLimit = '😀'.repeat(humanRequest('input:text').max_length);

  await field.fill(`${atLimit}😀`);
  await expect(field).toHaveValue(`${atLimit}😀`);
  await send.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(contract.humanResponses()).toHaveLength(0);

  await field.fill(atLimit);
  await expect(field).toHaveValue(atLimit);
  await send.click();
  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect.poll(() => contract.humanResponses()).toHaveLength(1);
  expect(contract.humanResponses()[0]).toMatchObject({ decision: 'submit', value: atLimit });
});

test('updates the Action human request countdown without a page refresh', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  await routeReadyChat(page, { humanKind: 'approval' });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 5:00');
  await page.clock.fastForward(1_000);
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 4:59');
  await page.clock.fastForward(2_000);
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 4:57');
});

test('the elapsed time of a turn keeps counting across an Action request it waited on', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  await routeReadyChat(page, { humanKind: 'approval', holdHumanResponse: true });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog).toBeVisible();
  await page.clock.runFor(7_000);
  await dialog.getByRole('button', { name: 'Approve action' }).click();

  const thinking = page.getByRole('group', { name: 'I’m processing…' });
  const elapsed = thinking.getByTitle('Elapsed time');
  await expect(elapsed).toHaveText(/^7 s\b/);
  await page.clock.runFor(1_000);
  await expect(elapsed).toHaveText(/^8 s\b/);
});

test('closes and reconciles an expired Action human request', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  const contract = await routeReadyChat(page, { humanKind: 'approval', humanExpiresIn: 3 });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 0:03');
  await page.clock.fastForward(1_000);
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 0:02');
  await page.clock.fastForward(2_000);

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('The Action request expired. Send the message again to retry.')).toBeVisible();
  await expect.poll(() => contract.syncFrames()).toBe(2);
  expect(contract.humanResponses()).toEqual([]);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
});

test('waits for in-flight Supervisor validation before reconciling expiry', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  const contract = await routeReadyChat(page, {
    holdHumanResponse: true,
    humanKind: 'auth:password',
    humanExpiresIn: 3,
    humanRejections: [{
      type: 'human-response-rejected',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: 'authentication-denied',
      attempts_remaining: 2,
      retry_after: 0,
    }],
  });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Supervisor password').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await page.clock.fastForward(3_000);

  await expect(dialog).toHaveCount(0);
  expect(contract.syncFrames()).toBe(1);
  contract.releaseHumanResponse();
  await expect.poll(() => contract.syncFrames()).toBe(2);
  await expect(page.getByText('The Action request expired. Send the message again to retry.')).toBeVisible();
  await expect(page.getByText('The local chat stream was invalid.')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  expect(contract.syncFrames()).toBe(2);
});

test('reopens a server-authoritative human request redelivered after local expiry', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  const contract = await routeReadyChat(page, {
    humanKind: 'approval',
    humanExpiresIn: 3,
    redeliverExpiredHuman: true,
  });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 0:03');
  await page.clock.fastForward(3_000);

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('timer')).toHaveText('Expires in 0:02');
  await expect(page.getByText('The Action request expired. Send the message again to retry.')).toHaveCount(0);
  expect(contract.humanResponses()).toEqual([]);
  expect(contract.syncFrames()).toBe(2);
  await expect(composer).toBeDisabled();
});

test('treats dismissing a human request as a terminal denial', async ({ page }) => {
  const contract = await routeReadyChat(page, { humanKind: 'approval' });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => contract.humanResponses()).toEqual([{
    type: 'human-response',
    challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    decision: 'deny',
  }]);
});

test('restores Supervisor password authorization as a focused validation modal', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    holdHumanResponse: true,
    humanKind: 'auth:password',
    humanLocale: 'pt',
    humanRejections: [{
      type: 'human-response-rejected',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: 'authentication-denied',
      attempts_remaining: 2,
      retry_after: 0,
    }],
  });
  await page.goto('/chat/');
  await switchLanguage(page, 'en', 'pt');
  await page.getByRole('textbox', { name: 'Enviar', exact: true }).fill('Crie o registro DNS revisado');
  await page.getByRole('button', { name: 'Enviar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  const originalDialog = await dialog.elementHandle();
  expect(originalDialog).not.toBeNull();
  await dialog.getByLabel('Senha do Supervisor').fill('senha-incorreta');
  await dialog.getByRole('button', { name: 'Confirmar autorização' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirmando a senha do Supervisor…');
  await expect(dialog.getByLabel('Senha do Supervisor')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Confirmar autorização' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Estou processando...' })).toHaveCount(0);
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  contract.releaseHumanResponse();

  const validation = page.getByRole('dialog', { name: 'Senha do Supervisor não confirmada' });
  await expect(validation).toBeVisible();
  await expect.poll(() => originalDialog?.evaluate((element) => element.isConnected)).toBe(true);
  await expect(validation).toContainText('Restam 2 tentativas antes de um bloqueio temporário.');
  await expect(validation.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled();
  await expect.poll(() => validation.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(page.getByText(/Detalhe técnico/)).toHaveCount(0);
  await expect.poll(() => contract.humanResponses()).toHaveLength(1);

  await validation.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
});

test('blocks Supervisor password retry behind the server countdown', async ({ page }) => {
  await freezeClock(page, new Date('2026-08-09T12:00:00Z'));
  await routeReadyChat(page, {
    humanKind: 'auth:password',
    humanRejections: [{
      type: 'human-response-rejected',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: 'authentication-locked',
      attempts_remaining: 0,
      retry_after: 60,
    }],
  });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Create the reviewed DNS record');
  await page.getByRole('button', { name: 'Send' }).click();
  const request = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await request.getByLabel('Supervisor password').fill('incorrect-password');
  await request.getByRole('button', { name: 'Confirm authorization' }).click();

  const locked = page.getByRole('dialog', { name: 'Password attempts temporarily blocked' });
  await expect(locked).toBeVisible();
  await expect(locked.getByRole('button', { name: 'Try again in 60 s' })).toBeDisabled();
  await expect(locked).toContainText('may expire before password confirmation is completed');
});

test('keeps authorization modal until Team progress proves password continuation', async ({ page }) => {
  const contract = await routeReadyChat(page, { humanKind: 'auth:password', holdHumanResponse: true });
  await page.goto('/chat/');
  await sendMessage(page, 'Create the reviewed DNS record');
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Supervisor password').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await expect(dialog.getByLabel('Supervisor password')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  contract.releaseHumanResponse();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toBeVisible();
  await expect.poll(() => contract.humanResponses()).toHaveLength(1);
});

test('reopens the Team-owned human request when reconnect sync proves it is still pending', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    disconnectHumanResponse: true,
    humanKind: 'auth:password',
  });
  await page.goto('/chat/');
  await sendMessage(page, 'Create the reviewed DNS record');
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Supervisor password').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  contract.disconnectHumanSocket();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
  await expect.poll(() => contract.humanResponses()).toHaveLength(1);
});

test('keeps an intentional Stop silent after the turn ends', async ({ page }) => {
  await routeReadyChat(page, { holdReply: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('group', { name: 'I’m processing…' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  await expect(page.getByText('The active turn was stopped.')).toHaveCount(0);
  await expect(page.locator('[data-slot="notice"].shimpz-notice--error')).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
});

test('Send becomes Stop in place while a turn runs and is Send again once the reply arrives', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdReply: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await expect(stop).toHaveCount(0);
  await send.click();

  await expect(stop).toBeEnabled();
  await expect(send).toHaveCount(0);
  chat.releaseReply();

  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  // A done frame that reports no usage shows no usage line.
  await expect(page.getByRole('article', { name: 'Marketing' })).not.toContainText('tokens');
  await expect(stop).toHaveCount(0);
  await expect(send).toBeVisible();
  await composer.fill('And the records?');
  await expect(send).toBeEnabled();
});

test('a reply shows what its task used only when its done frame reports usage', async ({ page }) => {
  const usage = {
    duration_ms: 6240,
    models: [
      { provider: 'anthropic', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 200 },
      { provider: 'openai', model: 'gpt-6-luna', input_tokens: 11900, output_tokens: 580 },
    ],
  };
  const chat = await routeReadyChat(page, { usage, holdReply: true });
  await page.goto('/chat/');
  await sendMessage(page, 'List my DNS zones');
  // Admin's own step comes first, as the mock sends it when the chat frame arrives.
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  chat.sendProgressEvent({ type: 'progress', seq: 2, origin: 'team', phase: 'model', state: 'started' });
  chat.sendProgressEvent({ type: 'progress', seq: 3, origin: 'team', phase: 'model', state: 'finished', elapsed_ms: 1240 });
  chat.releaseReply();
  const reply = page.getByRole('article', { name: 'Marketing' });
  await expect(reply).toContainText('Rendered answer');
  await expect(reply).toContainText('$0.0095');
  await expect(reply).toContainText('13,680 tokens');
  await expect(reply.getByTitle(/GPT-6 Luna: 11,900 input · 580 output/)).toHaveCount(1);
  // With recorded steps the usage line is the one control that opens them, and it still announces their count.
  const receipt = reply.locator('.receipt summary');
  await expect(receipt).toHaveAccessibleName('≈ $0.0095 · 13,680 tokens · 6.2 s · Execution stages recorded: 2');
  await receipt.click();
  // Team's measured step, then the rest of Team's clock: together exactly the reply's 6,240 ms.
  const rows = reply.locator('.receipt ol li time');
  await expect(rows).toHaveText(['1.2 s', '5.0 s']);
});

test('a reply whose only observed steps are Admin\'s keeps its usage line', async ({ page }) => {
  const usage = { duration_ms: 6240, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 11900, output_tokens: 580 }] };
  await routeReadyChat(page, { usage });
  await page.goto('/chat/');
  await sendMessage(page, 'List my DNS zones');
  const reply = page.getByRole('article', { name: 'Marketing' });
  await expect(reply).toContainText('Rendered answer');
  await expect(reply).toContainText('12,480 tokens');
  await expect(reply.getByTitle(/GPT-6 Luna: 11,900 input · 580 output/)).toHaveCount(1);
});

test('a reply restored from history shows its usage line, and one stored without usage shows none', async ({ page }) => {
  const [first, second] = ['d'.repeat(32), 'e'.repeat(32)];
  const usage = {
    duration_ms: 6240,
    models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 11900, output_tokens: 580 }],
  };
  await routeReadyChat(page, {
    history: {
      entries: [
        { id: `${first}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'List my DNS zones' },
        { id: `${first}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant', text: 'Two zones.', author: 'Marketing', usage },
        { id: `${second}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'And the records?' },
        { id: `${second}:reply`, created_at: HISTORY_AT, kind: 'message', role: 'assistant', text: 'Four records.', author: 'Marketing' },
      ],
      before: null,
    },
  });
  await page.goto('/chat/');
  const replies = page.getByRole('article', { name: 'Marketing' });
  await expect(replies).toHaveCount(2);
  await expect(replies.first()).toContainText('Two zones.');
  await expect(replies.first()).toContainText('12,480 tokens');
  await expect(replies.first().getByTitle(/GPT-6 Luna: 11,900 input · 580 output/)).toHaveCount(1);
  await expect(replies.nth(1)).toContainText('Four records.');
  await expect(replies.nth(1)).not.toContainText('tokens');
});

test('a reloaded reply opens the same recorded steps from its usage line', async ({ page }) => {
  await routeScenario(page, 'chat-receipt');
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'List my DNS zones');
  const reply = page.getByRole('article', { name: 'Marketing' });
  await expect(reply).toHaveCount(1);
  // Team's four steps and the rest of its clock; Admin's own steps are not among them.
  const steps = async () => {
    await reply.locator('.receipt summary').click();
    const rows = reply.locator('.receipt ol li');
    await expect(rows).toHaveCount(5);
    return rows.allTextContents();
  };
  const live = await steps();
  await page.reload();
  await expect(reply).toHaveCount(1);
  expect(await steps()).toEqual(live);
});

test('a done frame with malformed usage is refused and shows no reply', async ({ page }) => {
  await routeReadyChat(page, { usage: { duration_ms: 1, models: [] } });
  await page.goto('/chat/');
  await sendMessage(page, 'List my DNS zones');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Rendered answer', { exact: true })).toHaveCount(0);
});

test('keeps an unexpected terminal error visible after silent Stop handling', async ({ page }) => {
  await routeReadyChat(page, { terminalError: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();

  const notice = page.locator('[data-slot="notice"].shimpz-notice--error');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('The local chat runtime is unavailable.');
  await expect(notice).toContainText('HTTP 503 · synthetic runtime failure');
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
});

test('keeps long Chat transcripts keyboard-scrollable', async ({ page }) => {
  const longReply = Array.from({ length: 60 }, (_, index) => `Result ${index + 1}: validated DNS record.`).join('\n\n');
  const chat = await routeReadyChat(page, { reply: longReply });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect.poll(() => chat.syncFrames()).toBeGreaterThan(0);
  await expect(composer).toBeEnabled();
  await composer.fill('Return the complete DNS inventory');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Result 60: validated DNS record.')).toBeVisible();
  const turns = page.locator('.turns');
  await expect(turns).toHaveAttribute('tabindex', '0');
  const dimensions = await turns.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await turns.focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => turns.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test('deletes a Team with its exact confirmation and reports the deletion', { tag: '@mobile' }, async ({ page }) => {
  await routeReadyChat(page);
  let deleted = false;
  let deletionBody;
  await routeRead(page, 'teams.list', () => ok({
      teams: deleted
        ? [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }]
        : [
            { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
            { team_id: 'support', team_name: 'Support', status: 'running' },
          ],
    }));
  let refusals = 1;
  await routeRead(page, 'teams.delete', ({ team_id: teamId, body }) => {
    if (teamId !== 'support') return undefined;
    if (refusals-- > 0) return ok({ detail: 'Team is unavailable' }, 503);
    deletionBody = body;
    deleted = true;
    return ok({
      team_id: 'support',
      destroyed: true,
      assistants_removed: 0,
      residue_absent: localTeamResidues,
      storage_removed: true,
    });
  });

  await page.goto('/chat/');
  const navigation = await openTeamNavigation(page);
  await navigation.getByRole('button', { name: 'Actions for Support' }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Team' });
  await deleteDialog.getByLabel('Confirm Team name').fill('Support');
  const password = deleteDialog.getByLabel('Supervisor password');
  await password.fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();
  // A refused deletion clears the password and gives its field the focus to type it again.
  await expect(password).toHaveValue('');
  await expect(password).toBeFocused();
  await password.fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();

  await expect(deleteDialog).toBeHidden();
  expect(deletionBody).toEqual({ team_name: 'Support', password: 'private-password' });
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Team deleted');
  await expect(toast).toContainText('Support and all of its data were securely deleted.');
});

test('a Team name of 80 emoji can be typed to rename and to confirm its deletion', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
  // Team bounds names by Unicode code points; each emoji is two UTF-16 units, so 80 of them fill 160 units.
  const longest = '😀'.repeat(80);
  await routeReadyChat(page);
  let deleted = false;
  const renames = [];
  let deletionBody;
  await routeRead(page, 'teams.list', () => ok({
      teams: [
        { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
        ...(deleted ? [] : [{ team_id: 'support', team_name: renames.length ? longest : 'Support', status: 'running' }]),
      ],
    }));
  await routeRead(page, 'teams.rename', ({ team_id: teamId, body }) => {
    if (teamId !== 'support') return undefined;
    renames.push(body);
    return ok({ team_id: 'support', team_name: body.team_name });
  });
  await routeRead(page, 'teams.delete', ({ team_id: teamId, body }) => {
    if (teamId !== 'support') return undefined;
    deletionBody = body;
    deleted = true;
    return ok({
      team_id: 'support',
      destroyed: true,
      assistants_removed: 0,
      residue_absent: localTeamResidues,
      storage_removed: true,
    });
  });

  await page.goto('/chat/');
  const navigation = await openTeamNavigation(page);
  await navigation.getByRole('button', { name: 'Actions for Support' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await navigation.getByRole('textbox', { name: 'Name for Support' }).fill(longest);
  await page.keyboard.press('Enter');
  await expect(navigation.getByRole('link', { name: longest, exact: true })).toBeFocused();
  await expect.poll(() => renames).toEqual([{ team_name: longest }]);

  await navigation.getByRole('button', { name: `Actions for ${longest}` }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Team' });
  await deleteDialog.getByLabel('Confirm Team name').fill(longest);
  await deleteDialog.getByLabel('Supervisor password').fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();

  await expect(deleteDialog).toBeHidden();
  expect(deletionBody).toEqual({ team_name: longest, password: 'private-password' });
});

test('reports an already-absent Store uninstall and keeps Chat usable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
  await routeReadyChat(page);
  await routeAssistantStoreUninstall(page);
  await routeRead(page, 'assistants.uninstall', (params) => (
    params.team_id === 'marketing' && params.assistant_id === 'shimpz-cloudflare'
      ? ok({ assistant: 'shimpz-cloudflare', uninstalled: false })
      : undefined
  ));

  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Shimpz Cloudflare is no longer installed in Marketing.');
  await (await openTeamNavigation(page)).getByRole('link', { name: 'Marketing', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/?\?team=marketing$/);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
});

test('reports a committed uninstall when the Team inventory cannot refresh', async ({ page }) => {
  await routeReadyChat(page);
  await routeAssistantStoreUninstall(page);
  let committed = false;
  await routeRead(page, 'assistants.uninstall', (params) => {
    if (params.team_id !== 'marketing' || params.assistant_id !== 'shimpz-cloudflare') return undefined;
    committed = true;
    return ok({ assistant: 'shimpz-cloudflare', uninstalled: true });
  });
  // The inventory read after it is refused; an outage would only be read again until it answers.
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (
    committed && teamId === 'marketing' ? ok({ assistants: 'unreadable' }) : undefined
  ));

  await page.goto('/assistants/shimpz-cloudflare?team=marketing');
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();

  await expect(dialog).toBeHidden();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Assistant inventory needs refresh');
  await expect(toast).toContainText(
    'Shimpz Cloudflare is no longer installed in Marketing, but the current Team inventory could not be refreshed.',
  );
  await expect(toast).toContainText('Reload this page to confirm the Assistant list.');
});

test('keeps a first Store install ready while local display metadata catches up', { tag: '@mobile' }, async ({ page }, testInfo) => {
  let installed = false;
  let catalogReads = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession()),
  }));
  await routeRead(page, 'teams.list', () => ok({
      teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    }));
  await routeRead(page, 'assistants.registry', () => {
    catalogReads += 1;
    return ok({ assistants: installed ? [{ id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare' }] : [] });
  });
  const installs = [];
  await routeRead(page, 'assistants.install', ({ team_id: teamId, body }) => {
    if (teamId !== 'marketing') return undefined;
    installs.push(body);
    installed = true;
    return ok({ assistant: 'shimpz-cloudflare', installed: true });
  });
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'marketing' ? ok({
    assistants: installed
      ? [{ assistant: 'shimpz-cloudflare', assistant_version: '0.1.0', status: 'running', provenance: 'published' }]
      : [],
  }) : undefined));
  await routeRead(page, 'store.catalog', ({ locale }) => (locale === 'en' ? { status: 200, json: {
      version: 1, next: null, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.1.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'4'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
        ...structuredClone(PAGE_COPY),
      }],
    } } : undefined));
  await routeRead(page, 'snapshots.list', () => ({ status: 200, json: { assistants: [], trace_id: 'c'.repeat(32) } }));
  await page.route('**/api/assistants/shimpz-cloudflare/catalog-icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));

  await routeRead(page, 'assistants.details', (params) => (
    params.team_id === 'marketing' && params.assistant_id === 'shimpz-cloudflare' && params.locale === 'en'
      ? ok(assistantDetails({ assistant_version: '0.1.0' }))
      : undefined
  ));

  await page.goto('/assistants/');
  await page.getByRole('link', { name: /^Shimpz Cloudflare/ }).click();
  const install = page.getByRole('button', { name: 'Install', exact: true });
  if (testInfo.project.use.hasTouch) await install.tap();
  else await install.click();
  const dialog = page.getByRole('dialog', { name: 'Install this Assistant?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm install' }).click();

  await expect(page.locator('[data-slot="toast"]')).toContainText(
    'Shimpz Cloudflare is ready in Marketing.',
  );
  await expect(page.getByText('The installed Assistant inventory is invalid.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Uninstall', exact: true })).toBeVisible();
  expect(installs).toEqual([{ assistant_id: 'shimpz-cloudflare', source_digest: `sha256:${'4'.repeat(64)}` }]);
  expect(catalogReads).toBeGreaterThanOrEqual(2);
});

test('the ready Chat passes its accessibility scan and the Brain chooser works by keyboard', { tag: '@mobile' }, async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  // The Chat screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);

  const brainTrigger = page.getByRole('button', { name: /^Brain: / });
  await expect(brainTrigger).toHaveAccessibleName('Brain: GPT-6.1 Sol');
  await brainTrigger.click();
  const brainPanel = page.getByRole('dialog', { name: 'Brain settings' });
  await expect(brainPanel).toBeVisible();
  const models = brainPanel.getByRole('group', { name: 'Model' });
  await expect(models.getByRole('button', { name: /GPT-6.1 Sol/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(models.getByRole('button', { name: /GPT-6.1 Sol/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(brainPanel).toBeHidden();
  await expect(brainTrigger).toBeFocused();


  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'You' })).toContainText('Show the rendered response');
});

test('opens a Team chat from the Team list and its Store from the row icon', { tag: '@mobile' }, async ({ page }) => {
  await routeReadyChat(page);
  await routeRead(page, 'teams.list', () => ok({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
      { team_id: 'support', team_name: 'Support', status: 'running' },
    ] }));
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => (teamId === 'support' ? { status: 200, json: { assistants: [] } } : undefined));
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();

  let navigation = await openTeamNavigation(page);
  await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toHaveAttribute('aria-current', 'page');

  const supportLink = navigation.getByRole('link', { name: 'Support', exact: true });
  const supportStore = navigation.getByRole('link', { name: 'Open the Store for Support' });
  await supportLink.focus();
  await page.keyboard.press('Tab');
  await expect(supportStore).toBeFocused();
  await navigation.getByRole('link', { name: 'Support', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/?\?team=support$/);
  navigation = await openTeamNavigation(page);
  await expect(navigation.getByRole('link', { name: 'Support', exact: true })).toHaveAttribute('aria-current', 'page');
  await navigation.getByRole('link', { name: 'Open the Store for Support' }).click();
  await expect(page).toHaveURL(/\/assistants\/?\?team=support$/);
  await expect(page.getByRole('region', { name: 'Shimpz Assistant Store' })).toBeVisible();
  navigation = await openTeamNavigation(page);
  await expect(navigation.getByRole('link', { name: 'Open the Store for Support' })).toHaveAttribute('aria-current', 'page');
  await navigation.getByRole('link', { name: 'Open the Store for Marketing' }).click();
  await expect(page).toHaveURL(/\/assistants\/?\?team=marketing$/);

  navigation = await openTeamNavigation(page);
  const actions = navigation.getByRole('button', { name: 'Actions for Support' });
  await actions.focus();
  await page.keyboard.press('Enter');
  // A Local Team menu opens on Rename, and a Team without Routines offers no Routines item.
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Routines' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeHidden();
  await expect(actions).toBeFocused();
});

test('opens the mobile Team list as a modal drawer and restores focus', { tag: '@mobile' }, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile drawer contract');
  await routeReadyChat(page);
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();

  const trigger = page.getByRole('button', { name: 'Open the Team list' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Teams' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'New Team' })).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Marketing', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await drawer.getByRole('button', { name: 'Close the Team list' }).click();
  await expect(drawer).toBeHidden();
});

test('a Brain change closed with Escape while it saves gives its trigger the focus once it is saved', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdInferenceWrite: true });
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  await chooseBrainModel(page, 'GPT-6 Luna');
  await expect.poll(chat.inferenceWrites).toBe(1);
  // The panel that held the focus closes, leaving it on the document while the trigger stays disabled.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Brain settings' })).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  chat.releaseInferenceWrite();
  await expect(page.getByRole('button', { name: /^Brain: / })).toBeFocused();
});

test('holds Send while a Brain change is saving so the turn uses the saved selection', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdInferenceWrite: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Use the new model');
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled();

  await chooseBrainModel(page, 'GPT-6 Luna');
  await expect.poll(chat.inferenceWrites).toBe(1);
  await expect(send).toBeDisabled();
  await expect(composer).toBeEnabled();
  await page.keyboard.press('Escape');
  await composer.press('Enter');
  expect(chat.chatFrames()).toHaveLength(0);

  chat.releaseInferenceWrite();
  await expect(send).toBeEnabled();
  // Focus the user moved to the composer is never pulled back to the Brain trigger.
  await expect(composer).toBeFocused();
  await send.click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect.poll(() => chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6-luna' }]);
});


// When the notices these journeys store were written.
const NOTICE_AT = '2026-10-01T12:01:07Z';

// A held run's card as Team opens it (ADR-0092 section 7, ADR-0101): the call, its recorded failure (a Cloudflare
// account out of credits), and exactly Rodar and Excluir.
const CREDITS_MESSAGE = "Client error '402 Payment Required' for url 'https://api.cloudflare.com/client/v4/zones/[REDACTED]'";

function recoveryCard(runId, { tag = 'f'.repeat(64), action = 'replace-dns-record', failure = {} } = {}) {
  return {
    team_id: 'marketing',
    run_id: runId,
    assistant_id: 'shimpz-cloudflare',
    action,
    position: 2,
    steps: 3,
    evidence: 'recorded',
    diagnostic: diagnostic({
      action,
      recorded_at: '2026-10-01T12:01:05Z',
      failure: httpFailure({ message: CREDITS_MESSAGE, http_status: 402, ...failure }),
    }),
    tag,
  };
}

// An unresolved incident that holds a run of `routine` for recovery (ADR-0092); it shares the run's id.
function heldIncident(id, routine = ROUTINE_VIEW) {
  return {
    run_id: id,
    routine_id: routine.routine_id,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
    position: 2,
    steps: 3,
  };
}

// A held run of `routine` as Team lists it: its step is named only by its incident.
function heldRun(id, routine = ROUTINE_VIEW) {
  return { run_id: id, routine_id: routine.routine_id, status: 'held', request_kind: null, assistant_id: null, action: null };
}

// A run of `routine` frozen for the person's answer.
function frozenRun(id, requestKind, routine = ROUTINE_VIEW) {
  return {
    run_id: id,
    routine_id: routine.routine_id,
    status: 'frozen',
    request_kind: requestKind,
    assistant_id: 'shimpz-cloudflare',
    action: 'replace-dns-record',
  };
}

// Admin's deletion ceremony (ADR-0051): the Supervisor password first, then one six-digit code; `000000` is wrong.
const SUPERVISOR_PASSWORD = 'correct supervisor passphrase';

// Opens a Routine's panel the way a person reaches it: the Team's Routines button, then the Routine in its list. The
// chat shows only each Routine's creation, so this is the one way to a Routine's runs.
async function openRoutinePanel(page, name = ROUTINE_VIEW.name, locale = 'en') {
  const copy = messages[locale];
  const button = copy.teamNavigation.routines.replace('{team}', 'Marketing');
  // A phone keeps its Team drawer open behind a Routine panel it closed.
  const drawer = page.getByRole('dialog', { name: 'Teams' });
  const navigation = await drawer.isVisible() ? drawer : await openTeamNavigation(page);
  await navigation.getByRole('button', { name: new RegExp(`^${RegExp.escape(button)}`) }).click();
  await page.getByRole('dialog', { name: copy.routine.list.title.replace('{team}', 'Marketing') })
    .getByRole('group', { name: copy.routine.list.open })
    .getByRole('button', { name: new RegExp(`^${RegExp.escape(name)}`) }).click();
  return page.getByRole('dialog', { name, exact: true });
}

async function routeRoutines(
  page,
  {
    others = [],
    listFailsAfterDelete = false,
    runEnding = false,
    held = true,
    heldCall = true,
    lockAfter = 0,
    passkey = false,
  } = {},
) {
  const calls = { begins: [], deletes: [], resumes: [], pauses: [], answers: [] };
  let rejected = 0;
  // The Routine is paused, and unless told otherwise an earlier run of it is held for recovery (ADR-0092), at a call
  // its incident names; a run held before it sealed a plan names none.
  let routines = [{ ...ROUTINE_VIEW, state: 'paused' }, ...others];
  let runs = [];
  const incident = heldIncident('b'.repeat(32));
  let incidents = held
    ? [heldCall ? incident : { ...incident, assistant_id: null, action: null, position: null, steps: null }]
    : [];
  // Every listed Routine's current revision projects the same plan, read page by page.
  await routeRead(page, 'routines.plan_steps', ({ team_id: teamId, routine_id: routineId, offset }) => {
    if (teamId !== 'marketing') return undefined;
    const routine = routines.find((item) => item.routine_id === routineId);
    return ok(planPage(routineId, routine.plan, ROUTINE_PLAN, Number(offset)));
  });
  await routeRead(page, 'routines.list', (params) => {
    if (params.team_id !== 'marketing') return undefined;
    if (listFailsAfterDelete && calls.deletes.length > 0 && !calls.failedAfterDelete) {
      calls.failedAfterDelete = true;
      return ok({ code: 'team-unavailable' }, 503);
    }
    return ok({ team_id: 'marketing', routines, runs, incidents });
  });
  // Each Routine change goes over the session socket (ADR-0114); every call names the Marketing Team.
  await routeRead(page, 'routines.resume', ({ routine_id: routineId }) => {
    calls.resumes.push(routineId);
    routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, state: 'active' } : routine));
    return ok({ team_id: 'marketing', routine_id: routineId, paused: false });
  });
  await routeRead(page, 'routines.pause', ({ routine_id: routineId }) => {
    calls.pauses.push(routineId);
    routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, state: 'paused' } : routine));
    return ok({ team_id: 'marketing', routine_id: routineId, paused: true });
  });
  await routeRead(page, 'routines.deletion', ({ routine_id: routineId, body: { password } }) => {
    calls.begins.push(routineId);
    if (password === SUPERVISOR_PASSWORD && !(lockAfter && rejected >= lockAfter)) {
      const offer = passkey ? { methods: ['totp', 'passkey'], passkey_options: { challenge: 'Y2hhbGxlbmdl', allowCredentials: [], rpId: 'localhost', timeout: 180000, userVerification: 'required' } } : { methods: ['totp'] };
      return ok(offer, 202);
    }
    rejected += password === SUPERVISOR_PASSWORD ? 0 : 1;
    if (lockAfter && rejected >= lockAfter) return ok({ code: 'authentication-locked', retry_after: 42 }, 429);
    return ok({ code: 'password-incorrect' }, 401);
  });
  await routeRead(page, 'routines.delete', ({ routine_id: routineId, body: proof }) => {
    calls.deletes.push(proof);
    if (proof.code === '000000') return ok({ code: 'code-incorrect' }, 401);
    // While a run is still ending, Team keeps the Routine as deleting and answers false.
    routines = runEnding
      ? routines.map((routine) => (routine.routine_id === routineId ? { ...routine, deleting: true } : routine))
      : routines.filter((routine) => routine.routine_id !== routineId);
    // Deleting a Routine sets its held runs aside (ADR-0092).
    incidents = incidents.filter((item) => item.routine_id !== routineId);
    return ok({ team_id: 'marketing', routine_id: routineId, deleted: !runEnding });
  });
  // The held run's card. Rodar sets the run aside and lifts the pause.
  await routeRead(page, 'routines.card', ({ run_id: runId }) => ok(recoveryCard(runId)));
  await routeRead(page, 'routines.card_answer', ({ run_id: runId, body: answer }) => {
    calls.answers.push(answer);
    incidents = incidents.filter((item) => item.run_id !== runId);
    routines = routines.map((routine) => ({ ...routine, state: 'active' }));
    return ok({ team_id: 'marketing', run_id: runId });
  });
  return calls;
}

test('a Local Team is renamed in place: Enter saves by id, Escape keeps the name, a refusal keeps editing', { tag: '@mobile' }, async ({ page }) => {
  await routeScenario(page, 'ready');
  const renames = [];
  let refuse = false;
  // Each rename reaches the scenario's Team list, which the page reads after it; a refusal changes nothing.
  await routeRead(page, 'teams.rename', ({ team_id: teamId, body }) => {
    if (teamId !== 'marketing') return undefined;
    renames.push(body);
    if (refuse) return ok({ detail: 'Another Team already has this name.' }, 409);
    return undefined;
  });
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const navigation = await openTeamNavigation(page);

  await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = navigation.getByRole('textbox', { name: 'Name for Marketing' });
  await expect(field).toBeFocused();
  await field.fill('Growth');
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toBeFocused();
  expect(renames).toEqual([]);

  await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await field.fill('  Growth Marketing  ');
  await page.keyboard.press('Enter');
  const renamed = navigation.getByRole('link', { name: 'Growth Marketing', exact: true });
  await expect(renamed).toBeFocused();
  await expect.poll(() => renames).toEqual([{ team_name: 'Growth Marketing' }]);

  refuse = true;
  let releaseRefusal;
  const refusalHeld = new Promise((resolve) => { releaseRefusal = resolve; });
  await routeRead(page, 'teams.rename', async () => {
    await refusalHeld;
    return undefined;
  });
  await navigation.getByRole('button', { name: 'Actions for Growth Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const again = navigation.getByRole('textbox', { name: 'Name for Growth Marketing' });
  await again.fill('Sales');
  await page.keyboard.press('Enter');
  // While the name is saving, the field keeps focus but cannot be edited, so no later draft is silently lost.
  await expect(again).toHaveAttribute('readonly', '');
  releaseRefusal();
  await expect(page.getByText('The Team could not be renamed.')).toBeVisible();
  await expect(again).not.toHaveAttribute('readonly', '');
  await expect(again).toBeFocused();
  await expect(again).toHaveValue('Sales');
});

test('a Team name saved once the focus fell from its field to the document gives the Team link the focus', async ({ page }) => {
  await routeScenario(page, 'ready');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await routeRead(page, 'teams.rename', async ({ team_id: teamId }) => {
    if (teamId === 'marketing') await held;
    return undefined;
  });
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const navigation = page.locator('.shell-sidebar');
  await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = navigation.getByRole('textbox', { name: 'Name for Marketing' });
  await field.fill('Growth');
  await page.keyboard.press('Enter');
  await expect(field).toHaveAttribute('readonly', '');
  // While the name saves, the field loses the focus to the document, which is nobody's move.
  await field.evaluate((element) => element.blur());
  release();
  await expect(navigation.getByRole('link', { name: 'Growth', exact: true })).toBeFocused();
});

test('a Team name that cannot be saved is explained in the interface language and stays to be corrected', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routeScenario(page, 'ready');
  const renames = [];
  await routeRead(page, 'teams.rename', ({ team_id: teamId, body }) => {
    if (teamId !== 'marketing') return undefined;
    renames.push(body);
    return ok({ detail: 'team name has no usable characters' }, 400);
  });
  const copy = messages.pt.teamNavigation;
  await page.goto('/chat/?team=marketing');
  const navigation = page.locator('.shell-sidebar');
  await navigation.getByRole('button', { name: copy.actions.replace('{team}', 'Marketing') }).click();
  await page.getByRole('menuitem', { name: copy.rename }).click();
  const field = navigation.getByRole('textbox', { name: copy.renameLabel.replace('{team}', 'Marketing') });
  // Team counts a name in code points, at most 80.
  await field.fill('x'.repeat(81));
  await page.keyboard.press('Enter');
  const notice = page.locator('.admin-toast');
  await expect(notice).toContainText(copy.renameInvalid);
  await expect(field).toBeFocused();
  expect(renames).toEqual([]);

  await field.fill('Vendas');
  await page.keyboard.press('Enter');
  await expect(notice).toContainText(copy.renameFailed);
  await expect(notice).not.toContainText('team name has no usable characters');
  expect(renames).toEqual([{ team_name: 'Vendas' }]);
});

test('a Team name is shown exactly as written in every label that names it', async ({ page }) => {
  await routeScenario(page, 'ready');
  await page.goto('/chat/?team=marketing');
  const navigation = page.locator('.shell-sidebar');
  await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  // Replacement patterns and placeholder names are ordinary characters of a name.
  const name = 'Cash $& {total} Co';
  await navigation.getByRole('textbox', { name: 'Name for Marketing' }).fill(name);
  await page.keyboard.press('Enter');
  await expect(navigation.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: `Actions for ${name}`, exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: `Open the Store for ${name}`, exact: true })).toBeVisible();
});

test('a chat that keeps reconnecting never takes the focus from a Team name being edited', async ({ page }) => {
  await routeScenario(page, 'ready');
  const renames = [];
  await routeRead(page, 'teams.rename', ({ team_id: teamId, body }) => {
    if (teamId !== 'neo') return undefined;
    renames.push(body);
    return ok({ team_id: 'neo', team_name: body.team_name });
  });
  // Neo's chat channel attaches, and while `dropping` its session socket closes the moment the channel synchronizes, so
  // the composer turns busy and idle again while the name is typed. A channel that synchronizes once Admin is reachable
  // again stays, and says so.
  let connections = 0;
  let dropping = true;
  let settled = false;
  await routeChat(page, 'neo', (socket) => {
    connections += 1;
    socket.onMessage((message) => {
      if (JSON.parse(message).type !== 'sync') return;
      if (dropping) socket.close({ code: 1011, reason: 'Synthetic interrupted connection' });
      else settled = true;
    });
  });
  await page.goto('/chat/?team=neo');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  const navigation = page.locator('.shell-sidebar');
  await navigation.getByRole('button', { name: 'Actions for Neo' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = navigation.getByRole('textbox', { name: 'Name for Neo' });
  await expect(field).toBeFocused();
  await field.fill('Ne');
  const typed = connections;
  await expect.poll(() => connections).toBeGreaterThan(typed + 1);
  await page.keyboard.type('w name');

  await expect(field).toBeFocused();
  await expect(field).toHaveValue('New name');
  expect(renames).toEqual([]);
  // Once Admin is reachable again, the name is saved. The browser coming online retries at once, without waiting out a
  // backoff the repeated drops grew.
  dropping = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => settled, { timeout: 30_000 }).toBe(true);
  await expect(page.getByText(messages.en.shell.reconnecting)).toHaveCount(0);
  await expect(field).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => renames).toEqual([{ team_name: 'New name' }]);
});

test('a Team that fails to open leaves the chat on the previous Team and later Teams still open', async ({ page }) => {
  await routeScenario(page, 'ready');
  const inventoryReads = [];
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => {
    inventoryReads.push(teamId);
    return teamId === 'neo' ? ok({ detail: 'Team not found' }, 404) : undefined;
  });
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
  const navigation = page.locator('.shell-sidebar');

  await navigation.getByRole('link', { name: 'Neo', exact: true }).click();
  await expect.poll(() => inventoryReads).toContain('neo');
  await expect(page).toHaveURL(/team=marketing/);
  await navigation.getByRole('link', { name: 'Trinity', exact: true }).click();
  await expect(page).toHaveURL(/team=trinity/);
  await expect(navigation.getByRole('link', { name: 'Trinity', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(inventoryReads).toContain('trinity');
  // The failed Team was asked for once, not again while the address returned.
  expect(inventoryReads.filter((teamId) => teamId === 'neo')).toHaveLength(1);
});

test('a Team inventory that could not be read holds sending until it is read again', async ({ page }) => {
  await routeScenario(page, 'ready');
  let failInventory = false;
  // Neo refuses to open, and Marketing's inventory is refused while `failInventory` holds; an outage would only be
  // read again until it answers.
  await routeRead(page, 'assistants.list', ({ team_id: teamId }) => {
    if (teamId === 'neo') return ok({ detail: 'Team not found' }, 404);
    return failInventory && teamId === 'marketing' ? ok({ assistants: 'unreadable' }) : undefined;
  });
  await page.goto('/chat/?team=marketing');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  // A Team that failed to open leaves the previous Team selected, without the inventory a message names.
  await page.locator('.shell-sidebar').getByRole('link', { name: 'Neo', exact: true }).click();
  await expect(page).toHaveURL(/team=marketing/);
  const retry = page.getByRole('button', { name: 'Retry local data' });
  await expect(retry).toBeVisible();
  await composer.fill('Hello');
  await expect(send).toBeDisabled();

  // The Retry leaves while the inventory is read; a read that fails again returns the focus to it, and one that
  // succeeds hands the focus to the composer.
  failInventory = true;
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  await expect(send).toBeDisabled();
  failInventory = false;
  await page.keyboard.press('Enter');
  await expect(retry).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(composer).toBeFocused();
});

test.describe('Team order', () => {
  const READY_ORDER = ['Marketing', 'Trinity', 'Cypher', 'Morpheus', 'Neo', 'Smith'];
  const ID = (name) => name.toLowerCase();

  function teamNames(navigation) {
    return navigation.getByRole('navigation', { name: 'Teams' }).locator('[data-team-link] .name').allTextContents();
  }

  async function openOrder(page, scenario = 'ready', team = 'marketing') {
    await routeScenario(page, scenario);
    const orders = [];
    await routeRead(page, 'teams.reorder', ({ body }) => {
      orders.push(body);
      return undefined;
    });
    await page.goto(`/chat/?team=${team}`);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
    const navigation = await openTeamNavigation(page);
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    return { navigation, orders };
  }

  // Presses a Team's name, moves past the drag threshold onto the target row's upper half, and optionally cancels.
  async function mouseDrag(page, navigation, name, target, { escape = false } = {}) {
    const source = await navigation.getByRole('link', { name, exact: true }).boundingBox();
    const goal = await navigation.getByRole('link', { name: target, exact: true }).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, goal.y + 4, { steps: 8 });
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.up();
  }

  test('dragging a Team by its name reorders it, saves the exact order, and keeps it across a reload', { tag: '@mobile' }, async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    await mouseDrag(page, navigation, 'Smith', 'Trinity');
    const moved = ['Marketing', 'Smith', 'Trinity', 'Cypher', 'Morpheus', 'Neo'];
    await expect.poll(() => teamNames(navigation)).toEqual(moved);
    await expect.poll(() => orders).toEqual([{ team_ids: moved.map(ID) }]);
    // The drop never doubles as a click: the selected Team and page stay the same.
    await expect(page).toHaveURL(/\/chat\/?\?team=marketing$/);

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
    const reloaded = await openTeamNavigation(page);
    await expect.poll(() => teamNames(reloaded)).toEqual(moved);

    // A press on the name that never moves is a click: it opens the Team and saves no order.
    await reloaded.getByRole('link', { name: 'Neo', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/?\?team=neo$/);
    expect(orders).toHaveLength(1);
  });

  test('Escape cancels a drag without saving, and a touch on a name scrolls or opens the Team instead of dragging it', { tag: '@mobile' }, async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    await mouseDrag(page, navigation, 'Neo', 'Trinity', { escape: true });
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    // Escape ended only the drag; on a phone the Team drawer stays open.
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toBeVisible();
    expect(orders).toEqual([]);
    // A drag cancelled and released on the name it started from never opens that Team.
    const neo = await navigation.getByRole('link', { name: 'Neo', exact: true }).boundingBox();
    await page.mouse.move(neo.x + neo.width / 2, neo.y + neo.height / 2);
    await page.mouse.down();
    await page.mouse.move(neo.x + neo.width / 2, neo.y + neo.height / 2 + 10, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page).toHaveURL(/\/chat\/?\?team=marketing$/);
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toBeVisible();
    expect(orders).toEqual([]);

    const cdp = await page.context().newCDPSession(page);
    const source = await navigation.getByRole('link', { name: 'Cypher', exact: true }).boundingBox();
    const goal = await navigation.getByRole('link', { name: 'Trinity', exact: true }).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step += 1) {
      const point = { x, y: y + (goal.y + 4 - y) * (step / 8) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    expect(orders).toEqual([]);

    // A tap on the name opens that Team.
    const tap = await navigation.getByRole('link', { name: 'Cypher', exact: true }).boundingBox();
    const point = { x: tap.x + tap.width / 2, y: tap.y + tap.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page).toHaveURL(/\/chat\/?\?team=cypher$/);
    expect(orders).toEqual([]);
  });

  test('Alt+ArrowUp and Alt+ArrowDown on a Team name reorder it, announce the place, and keep focus on the name', { tag: '@mobile' }, async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    const neo = navigation.getByRole('link', { name: 'Neo', exact: true });
    await neo.focus();
    await page.keyboard.press('Alt+ArrowUp');

    const moved = ['Marketing', 'Trinity', 'Cypher', 'Neo', 'Morpheus', 'Smith'];
    await expect.poll(() => teamNames(navigation)).toEqual(moved);
    await expect(neo).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Neo moved to position 4 of 6' })).toHaveCount(1);
    await expect.poll(() => orders).toEqual([{ team_ids: moved.map(ID) }]);

    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    await expect(neo).toBeFocused();
    await expect.poll(() => orders.length).toBe(2);

    // The boundaries cannot move further.
    await navigation.getByRole('link', { name: 'Marketing', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await navigation.getByRole('link', { name: 'Smith', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    expect(orders).toHaveLength(2);
  });

  test('a refused save restores only the order and keeps the selected Team', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const { navigation, orders } = await openOrder(page, 'reorder-unavailable', 'neo');
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toHaveAttribute('aria-current', 'page');
    const smith = navigation.getByRole('link', { name: 'Smith', exact: true });
    await smith.focus();
    await page.keyboard.press('Alt+ArrowUp');

    await expect(page.getByText('The Team order could not be saved. The previous order is back.')).toBeVisible();
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    await expect.poll(() => orders).toEqual([{ team_ids: ['marketing', 'trinity', 'cypher', 'morpheus', 'smith', 'neo'] }]);
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toHaveAttribute('aria-current', 'page');

    // The next save goes through.
    await smith.focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => orders.length).toBe(2);
    await expect.poll(() => teamNames(navigation)).toEqual(['Marketing', 'Trinity', 'Cypher', 'Morpheus', 'Smith', 'Neo']);
  });

  test('a save refused because the Teams changed reloads the list', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const { navigation, orders } = await openOrder(page, 'reorder-conflict');
    await mouseDrag(page, navigation, 'Smith', 'Trinity');
    await expect(page.getByText('The Teams changed while you were reordering. The list was reloaded; try again.')).toBeVisible();
    await expect.poll(() => teamNames(navigation)).toEqual(['Oracle', ...READY_ORDER]);
    await expect.poll(() => orders).toHaveLength(1);
    await expect(navigation.getByRole('link', { name: 'Marketing', exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('a drag whose navigation is swapped out by a layout change ends and saves nothing', async ({ page }) => {
    test.skip(page.viewportSize().width <= 820, 'starts from the desktop sidebar');
    // Counts animation frames requested by the page, so a drag loop left running is observable.
    await page.addInitScript(() => {
      const request = window.requestAnimationFrame.bind(window);
      window.__frames = 0;
      window.requestAnimationFrame = (callback) => {
        window.__frames += 1;
        return request(callback);
      };
    });
    const { navigation, orders } = await openOrder(page);
    const source = await navigation.getByRole('link', { name: 'Neo', exact: true }).boundingBox();
    const x = source.x + source.width / 2;
    const y = source.y + source.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 20, { steps: 4 });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Open the Team list' })).toBeVisible();
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => window.__frames);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__frames)).toBe(frames);
    await page.mouse.up();
    expect(orders).toEqual([]);
  });
});

test.describe('Team Routines', () => {
  test.use({ timezoneId: 'America/Sao_Paulo' });

  // A recording turn's reply carries the card of the Routine that repeats it (ADR-0101): exactly two buttons, and
  // nothing is created until the person confirms.
  async function recordRoutine(page, scenario = 'routine-card') {
    const routed = await routeScenario(page, scenario);
    await page.goto('/chat/?team=marketing');
    await sendMessage(page, ROUTINE_TEXT.en.request);
    return routed;
  }

  // The card's answers the page sent over its session socket (ADR-0114), in order.
  async function proposalCalls(page) {
    return (await readsOf(page, 'routines.proposal_confirm')).map(() => 'confirm')
      .concat((await readsOf(page, 'routines.proposal_revoke')).map(() => 'revoke'));
  }

  // The card Team recorded, as its Edit offers it to change: its work, then its schedule, zone, and output.
  const CARD = { ...CARD_SETTINGS, description: ROUTINE_TEXT.en.cardDescription };
  const CARD_REQUEST = proposalRequest(CARD, messages.en.routine, 'en');

  test('a Routine card is confirmed with its Create button, which creates the Routine its notice then names', async ({ page }) => {
    const scenario = await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await expect(card.getByRole('heading')).toBeVisible();
    await expect(card).toContainText(ROUTINE_TEXT.en.cardDescription);
    // The person confirms Team's own schedule, zone, and output, also once the transcript is read again.
    for (let reads = 0; reads < 2; reads += 1) {
      await expect(card.getByRole('definition')).toHaveText([
        proposalWhen(CARD, messages.en.routine, 'en'),
        outputChoiceWords(CARD.output, messages.en.routine.proposal.questions),
      ]);
      if (reads === 0) await page.reload();
    }
    await expect(card.getByRole('button')).toHaveCount(3);
    for (const name of ['Cancel', 'Edit', 'Create']) {
      await expect(card.getByRole('button', { name, exact: true })).toBeEnabled();
    }
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(scenario.call('routines.list', { team_id: 'marketing' }).json.routines).toEqual([]);

    await card.getByRole('button', { name: 'Create', exact: true }).click();
    // Once created, the card is gone and nothing is left to answer; the composer takes the focus its button had.
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
    await expect.poll(() => proposalCalls(page)).toEqual(['confirm']);
    const [routine] = scenario.call('routines.list', { team_id: 'marketing' }).json.routines;
    expect(routine.name).toBe(ROUTINE_TEXT.en.card);

    // One message names the Routine it created, live and after a reload, and the answered card never returns.
    const created = page.locator('.routine-run');
    await expect(created).toHaveAccessibleName(ROUTINE_TEXT.en.card);
    await page.reload();
    await expect(created).toHaveAccessibleName(ROUTINE_TEXT.en.card);
    await expect(page.getByRole('region', { name: messages.en.routine.proposal.title })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
    expect(scenario.call('routines.list', { team_id: 'marketing' }).json.routines).toHaveLength(1);
  });

  test('a Routine card edited with its Edit button revokes it and sends the edited prompt as the next message', async ({ page }) => {
    const scenario = await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const prompt = card.getByRole('textbox', { name: messages.en.routine.proposal.prompt });
    // The prompt takes the keyboard at once, holding the card's work, schedule, zone, and output to change.
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(CARD_REQUEST);
    await expect(card.getByRole('button')).toHaveCount(2);
    await page.keyboard.type(' Tell me only when something changed.');
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => proposalCalls(page)).toEqual(['revoke']);
    const sent = () => scenario.chatFrames().filter((frame) => frame.type === 'chat').map((frame) => frame.message);
    await expect.poll(() => sent().at(-1)).toBe(`${CARD_REQUEST} Tell me only when something changed.`);
    expect(scenario.call('routines.list', { team_id: 'marketing' }).json.routines).toEqual([]);
  });

  test('a Routine card that leaves with its answer before its result returns still hands the focus to the composer', async ({ page }) => {
    const scenario = await recordRoutine(page, 'routine-question');
    const words = messages.en.routine.proposal.questions.schedule;
    await page.getByRole('radiogroup', { name: words.question }).getByRole('radio', { name: 'Every hour' }).check();
    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await expect(card).toBeVisible();
    // Admin keeps the answer in the transcript before Team's result returns, so the history read first already holds
    // it: the card, whose reply has no text, leaves the chat before its result arrives.
    await routeRead(page, 'routines.proposal_confirm', async (params) => {
      const answer = scenario.call('routines.proposal_confirm', params);
      await routineNotice(page);
      await expect(card).toHaveCount(0);
      return answer;
    });
    await card.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.routine-run')).toHaveAccessibleName(ROUTINE_TEXT.en.card);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
  });

  test('a Routine card whose editor is canceled shows the card again, with focus on its Edit button', async ({ page }) => {
    await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    const edit = card.getByRole('button', { name: 'Edit', exact: true });
    await edit.click();
    await page.keyboard.type(' Tell me only when something changed.');
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card).toContainText(ROUTINE_TEXT.en.cardDescription);
    await expect(edit).toBeFocused();
    expect(await proposalCalls(page)).toEqual([]);
  });

  test('a refused Create or Cancel keeps the Routine card, says why, and gives the focus back to the button pressed', async ({ page }) => {
    await recordRoutine(page);
    await routeRead(page, 'routines.proposal_confirm', () => ok({ code: 'routine-limit' }, 409));
    await routeRead(page, 'routines.proposal_revoke', () => ok({ code: 'routine-state-unavailable' }, 503));
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    // Each refusal says its own words, so the second is told apart from the first.
    for (const [name, words] of [['Create', messages.en.routine.errors.full], ['Cancel', messages.en.routine.errors.unavailable]]) {
      const button = card.getByRole('button', { name, exact: true });
      await button.click();
      await expect(card.getByRole('alert')).toHaveText(words);
      await expect(button).toBeFocused();
    }
    expect(await proposalCalls(page)).toEqual(['confirm', 'revoke']);
  });

  test('a refusal that arrives after the person moved the focus to the composer leaves it there', async ({ page }) => {
    await recordRoutine(page);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let asked = false;
    await routeRead(page, 'routines.proposal_confirm', async () => {
      asked = true;
      await held;
      return ok({ code: 'routine-limit' }, 409);
    });
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Create', exact: true }).click();
    await expect.poll(() => asked).toBe(true);
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await composer.focus();
    release();
    await expect(card.getByRole('alert')).toHaveText(messages.en.routine.errors.full);
    await expect(composer).toBeFocused();
  });

  test('an edited Routine card whose text is too long for one message keeps its editor and gives the focus back to Send', async ({ page }) => {
    const scenario = await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const prompt = card.getByRole('textbox', { name: messages.en.routine.proposal.prompt });
    // One character more than a chat message holds.
    const text = 'a'.repeat(16_001);
    await prompt.fill(text);
    const send = card.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    await expect(card.getByRole('alert')).toHaveText(messages.en.routine.proposal.rewriteUnsent);
    await expect(prompt).toHaveValue(text);
    await expect(send).toBeFocused();
    const sent = scenario.chatFrames().filter((frame) => frame.type === 'chat').map((frame) => frame.message);
    expect(sent).toEqual([ROUTINE_TEXT.en.request]);
  });

  test('a refused revocation of an edited Routine card keeps its editor, sends nothing, and gives the focus back to Send', async ({ page }) => {
    const scenario = await recordRoutine(page);
    await routeRead(page, 'routines.proposal_revoke', () => ok({ code: 'routine-state-unavailable' }, 503));
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const send = card.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    await expect(card.getByRole('alert')).toHaveText(messages.en.routine.errors.unavailable);
    await expect(card.getByRole('textbox', { name: messages.en.routine.proposal.prompt })).toHaveValue(CARD_REQUEST);
    await expect(send).toBeFocused();
    const sent = scenario.chatFrames().filter((frame) => frame.type === 'chat').map((frame) => frame.message);
    expect(sent).toEqual([ROUTINE_TEXT.en.request]);
  });

  test('an edited Routine card already confirmed elsewhere leaves without sending its text, and the composer takes the focus', async ({ page }) => {
    const scenario = await recordRoutine(page);
    // The card was confirmed meanwhile, so its revocation answers with the Routine that confirmation created.
    await routeRead(page, 'routines.proposal_revoke', (params) => scenario.call('routines.proposal_confirm', params));
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.keyboard.type(' Tell me only when something changed.');
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
    const sent = scenario.chatFrames().filter((frame) => frame.type === 'chat').map((frame) => frame.message);
    expect(sent).toEqual([ROUTINE_TEXT.en.request]);
    expect(await proposalCalls(page)).toEqual(['revoke']);
  });

  // The card's revocation waits until the test lets it answer; `answered()` says its answer went to the page.
  async function holdRevocation(page) {
    let release;
    let answered = false;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await routeRead(page, 'routines.proposal_revoke', async () => {
      await held;
      queueMicrotask(() => {
        answered = true;
      });
      return undefined;
    });
    release.answered = () => answered;
    return release;
  }

  test('an edited prompt never reaches another Team the page moved to while its card was being revoked', async ({ page }) => {
    const release = await holdRevocation(page);
    const scenario = await recordRoutine(page, 'routine-card-teams');
    // Neo's chat attaches and answers like any Team's, so only the card's own Team binding keeps the text out of it.
    const neoFrames = [];
    await routeChat(page, 'neo', (channel) => {
      channel.onMessage((message) => {
        const frame = JSON.parse(message);
        neoFrames.push(frame);
        for (const reply of scenario.chat.message(frame, 'neo')) channel.send(reply);
      });
    });
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.shell-sidebar').getByRole('link', { name: 'Neo', exact: true }).click();
    await expect(page).toHaveURL(/team=neo/u);
    await expect.poll(() => neoFrames.length).toBeGreaterThan(0);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    release();
    await expect.poll(() => release.answered()).toBe(true);
    // The page's own completion runs in the same turn as the answer it reads; a margin covers the frame's delivery.
    await page.waitForTimeout(500);
    expect(await proposalCalls(page)).toEqual(['revoke']);
    const sent = (frames) => frames.filter((frame) => frame.type === 'chat').map((frame) => frame.message);
    expect(sent(neoFrames)).toEqual([]);
    expect(sent(scenario.chatFrames())).toEqual([ROUTINE_TEXT.en.request]);
  });

  // A card revoked for an edit whose text the chat could not take yet, so the text stays in the card's editor; `held()`
  // answers the person's own next message, which kept the chat busy.
  async function unsentEdit(page) {
    const release = await holdRevocation(page);
    const scenario = await routeScenario(page, 'routine-card');
    // The person's own next message is answered only when the test says, so the chat is busy when the text would go.
    let turns = 0;
    let held = null;
    const frames = [];
    await routeChat(page, 'marketing', (channel) => {
      channel.onMessage((message) => {
        const frame = JSON.parse(message);
        frames.push(frame);
        if (frame.type === 'chat' && turns++ === 1) {
          held = () => {
            for (const reply of scenario.chat.message(frame, 'marketing')) channel.send(reply);
          };
          return;
        }
        for (const reply of scenario.chat.message(frame, 'marketing')) channel.send(reply);
      });
    });
    await page.goto('/chat/?team=marketing');
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await sendMessage(page, ROUTINE_TEXT.en.request);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title }).first();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await composer.fill('Something else first');
    await composer.press('Enter');
    await expect.poll(() => held !== null).toBe(true);
    release();
    await expect(card.getByRole('alert')).toHaveText(messages.en.routine.proposal.rewriteUnsent);
    return { composer, card, frames, held };
  }

  test('an edited prompt the chat cannot take yet stays in its field, past the card’s lifetime, to send again', async ({ page }) => {
    await page.clock.install();
    const { composer, card, frames, held } = await unsentEdit(page);
    const prompt = card.getByRole('textbox', { name: messages.en.routine.proposal.prompt });
    await expect(prompt).toHaveValue(CARD_REQUEST);
    // The card's lifetime ends, and the text is still there to send.
    await page.clock.runFor(16 * 60 * 1000);
    await expect(prompt).toHaveValue(CARD_REQUEST);
    held();
    await expect(composer).toBeEnabled();
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => frames.filter((frame) => frame.type === 'chat').map((frame) => frame.message))
      .toContain(CARD_REQUEST);
    // The card was revoked once; sending again sent only the text.
    expect(await proposalCalls(page)).toEqual(['revoke']);
  });

  test('an editor whose card was revoked for text that never went out leaves on Cancel, and the composer takes the focus', async ({ page }) => {
    const { composer, card, frames, held } = await unsentEdit(page);
    held();
    // The chat is free again, and its composer took back the focus its busy turn had dropped.
    await expect(composer).toBeFocused();
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: messages.en.routine.proposal.revoked })).toBeVisible();
    await expect(composer).toBeFocused();
    expect(frames.filter((frame) => frame.type === 'chat').map((frame) => frame.message)).not.toContain(CARD_REQUEST);
    expect(await proposalCalls(page)).toEqual(['revoke']);
  });

  test('each step of a Routine card names its Assistant with a link to that Assistant’s page', async ({ page }) => {
    await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    const links = card.getByRole('link', { name: 'Cloudflare', exact: true });
    // The steps stay closed until the person opens them; the card's buttons work either way.
    await expect(links).toHaveCount(0);
    await card.getByText(messages.en.routine.proposal.steps).click();
    await expect(links).toHaveCount(2);
    for (const name of ['Cancel', 'Edit', 'Create']) {
      await expect(card.getByRole('button', { name, exact: true })).toBeEnabled();
    }
    await links.first().click();
    await expect(page).toHaveURL(/\/assistants\/shimpz-cloudflare\?team=marketing$/u);
  });

  test('a Routine card canceled with its Cancel button revokes it and creates nothing', async ({ page }) => {
    const scenario = await recordRoutine(page);
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Once canceled, the card is gone and nothing is left to answer; the composer takes the focus its button had.
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeFocused();
    await expect.poll(() => proposalCalls(page)).toEqual(['revoke']);
    expect(scenario.call('routines.list', { team_id: 'marketing' }).json.routines).toEqual([]);
    await expect(page.locator('.routine-run')).toHaveCount(0);
  });

  test('a recording that cannot become a Routine says no Routine was created and offers nothing to confirm', async ({ page }) => {
    await recordRoutine(page, 'routine-refusal');
    const note = page.getByRole('note').filter({ hasText: 'No Routine was created' });
    await expect(note).toHaveText(messages.en.routine.proposal.refusals.secret);
    await expect(page.getByRole('region', { name: messages.en.routine.proposal.title })).toHaveCount(0);
  });

  // What Team asks before a card is answered in the chat (ADR-0101): no answer is preselected, the answer is the next
  // send, and its reply carries the card.
  function sentMessages(scenario) {
    return scenario.call('history.page', { team_id: 'marketing' }).json.entries
      .filter((entry) => entry.role === 'user')
      .map((entry) => entry.text);
  }

  test('a schedule question is answered with one choice and its reply carries the Routine card', async ({ page }) => {
    const scenario = await recordRoutine(page, 'routine-question');
    const words = messages.en.routine.proposal.questions.schedule;
    const question = page.getByRole('radiogroup', { name: words.question });
    await expect(question).toBeVisible();
    const answer = page.getByRole('button', { name: 'Answer', exact: true });
    await expect(answer).toBeDisabled();
    for (const label of words.answers) await expect(question.getByRole('radio', { name: label })).not.toBeChecked();
    expect(await accessibilityViolations(page)).toEqual([]);
    await question.getByRole('radio', { name: 'Every hour' }).check();
    await answer.click();
    await expect(page.getByRole('region', { name: messages.en.routine.proposal.title })).toBeVisible();
    await expect(question).toHaveCount(0);
    // Once answered, the question is gone from the reply that asked it; only the person's message keeps it.
    await expect(page.getByRole('article', { name: 'Marketing' }).filter({ hasText: words.question })).toHaveCount(0);
    const sent = sentMessages(scenario);
    expect(sent.at(-1)).toBe(`${ROUTINE_TEXT.en.request}\n\nQuestion: ${words.question}\nAnswer: Every hour`);
    // A reload keeps the question answered and the card under its answer's reply.
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: words.question })).toHaveCount(0);
    await expect(page.getByRole('region', { name: messages.en.routine.proposal.title })).toHaveCount(1);
  });

  test("what to do with each run's result is answered with one of Team's choices, which the card then carries", async ({ page }) => {
    const scenario = await recordRoutine(page, 'routine-output');
    const words = messages.en.routine.proposal.questions.output;
    const question = page.getByRole('radiogroup', { name: words.question });
    // Exactly Team's four choices are offered, and none is chosen for the person.
    for (const label of words.answers) await expect(question.getByRole('radio', { name: label, exact: true })).not.toBeChecked();
    await question.getByRole('radio', { name: 'Show only when it changes', exact: true }).check();
    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    const card = page.getByRole('region', { name: messages.en.routine.proposal.title });
    await expect(card).toBeVisible();
    expect(sentMessages(scenario).at(-1).split('\n').at(-1)).toBe('Answer: Show only when it changes');
  });

  test('a string and an integer of the same digits stay two targets, and the chosen one reaches Team exactly', async ({ page }) => {
    const digits = '12345678901234567890';
    // The scenario answers with a card only for an option's exact JSON text, as Team matches it.
    for (const [index, sent] of [[0, `"${digits}"`], [1, digits]]) {
      const scenario = await recordRoutine(page, 'routine-exact-target');
      const words = messages.en.routine.proposal.questions.ambiguous;
      const question = page.getByRole('radiogroup', { name: words.question });
      await expect(question.getByRole('radio', { name: digits, exact: true })).toHaveCount(2);
      await question.getByRole('radio', { name: digits, exact: true }).nth(index).check();
      await page.getByRole('button', { name: 'Answer', exact: true }).click();
      await expect(page.getByRole('region', { name: messages.en.routine.proposal.title })).toBeVisible();
      // Every digit of the integer survives, and the string keeps its quotes, so Team tells them apart.
      expect(sentMessages(scenario).at(-1).split('\n').at(-1)).toBe(`Answer: ${sent}`);
    }
  });

  test("the chat shows only each Routine's creation: its runs and later outcomes stay out of it, also after a reload", async ({ page }) => {
    await routeScenario(page, 'routine-lifecycle');
    await page.goto('/chat/?team=marketing');
    const created = routineLifecycleStart('en').history.filter((entry) => entry.outcome === 'created');
    expect(created.length).toBeGreaterThan(0);
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      const notices = page.locator('.routine-run');
      await expect(notices).toHaveCount(created.length);
      // Each is the creation Team froze its name into, and opens nothing: no run is reached from the chat.
      for (const [index, entry] of created.entries()) await expect(notices.nth(index)).toHaveAccessibleName(entry.name);
      await expect(notices.getByRole('button')).toHaveCount(0);
    }
    // The chat reads its own view of the history, never a Routine's.
    const requested = (await readsOf(page, 'history.page')).map((params) => params.routine ?? null);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((routine) => routine === null)).toBe(true);
  });

  test('a Team\'s own Routines button opens its list in a modal from pointer or keyboard and says when one needs attention', { tag: '@mobile' }, async ({ page }) => {
    await routeReadyChat(page);
    // A paused Routine with a held run: the button's name says a Routine needs the person.
    await routeRoutines(page);
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    const button = navigation.getByRole('button', { name: 'Routines for Marketing: one needs your attention' });
    // The modal's title names the Team the Routines belong to.
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(list).toHaveCount(0);
    await button.click();
    // Each choice names the Routine, says when it runs, and in words why it needs the person; focus starts on it.
    const item = list.getByRole('group', { name: 'Routines' }).getByRole('button', { name: ROUTINE_VIEW.name });
    await expect(item).toHaveAccessibleDescription(/Every day at 09:00.*Failed/);
    await expect(item).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);
    // Escape and Close each leave the list with focus back on the button, and the keyboard opens it again.
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(item).toBeFocused();
    await list.getByRole('button', { name: 'Close' }).click();
    await expect(list).toHaveCount(0);
    await expect(button).toBeFocused();
    // The Team's actions menu offers the same list.
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await page.getByRole('menuitem', { name: 'Routines' }).click();
    await expect(item).toBeFocused();
  });

  test('a Team whose Routines are all running needs no attention, and a Team without Routines has no Routines button', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: /needs your attention/ })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: /^Routines for (?!Marketing)/ })).toHaveCount(0);
  });

  test("a Team whose Routines could not be loaded keeps its Routines button, whose list says so and reads them again", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    let available = false;
    let held = Promise.resolve();
    // Team refuses the listing: no outage, which the list would read again on its own, but a refusal it shows.
    await routeRead(page, 'routines.list', async (params) => {
      if (params.team_id !== 'marketing') return undefined;
      await held;
      return available
        ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] })
        : ok({ code: 'routine-listing-refused' }, 409);
    });
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    // A failed listing is never a Team without Routines: the button stays and its name says the list failed.
    const button = navigation.getByRole('button', { name: 'Routines for Marketing: they could not be loaded' });
    await button.click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    await expect(list.getByRole('alert')).toBeVisible();
    const retry = list.getByRole('button', { name: messages.en.routine.list.retry });
    await expect(retry).toBeFocused();
    // A retry that fails again keeps the list open with its error, and the Retry it disabled takes the focus back.
    let release;
    held = new Promise((resolve) => { release = resolve; });
    await retry.click();
    await expect(retry).toBeDisabled();
    release();
    await expect(retry).toBeEnabled();
    await expect(list.getByRole('alert')).toBeVisible();
    await expect(retry).toBeFocused();
    // Once Team answers, the error and its Retry leave and the Routine is listed, with the focus.
    available = true;
    await retry.click();
    await expect(list.getByRole('alert')).toHaveCount(0);
    await expect(list.getByRole('group', { name: 'Routines' }).getByRole('button', { name: ROUTINE_VIEW.name })).toBeFocused();
    await list.getByRole('button', { name: 'Close' }).click();
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing', exact: true })).toBeVisible();
  });

  test('a Routine opens in a panel from the keyboard: it resumes, pauses, shows its runs, and is deleted after a confirmation', { tag: ['@slow', '@mobile'] }, async ({ page }) => {
    const failed = 'c'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [noticeRow(failed, ROUTINE_VIEW, 'failed', { code: 'assistant-rpc-failed' }, { at: NOTICE_AT })],
        before: null,
      },
    });
    // The first read after the deletion finds Team briefly unavailable; the list is read again on its own, and the
    // deleted Routine leaves it with the read that succeeds.
    const calls = await routeRoutines(page, { listFailsAfterDelete: true, held: false });
    const diagnostics = [];
    await routeRead(page, 'routines.diagnostics', ({ run_id: runId }) => {
      diagnostics.push(runId);
      return ok({ team_id: 'marketing', run_id: failed, diagnostics: [] });
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    const item = list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) });
    await expect(item).toContainText('Every day at 09:00');
    await item.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await expect(panel).toContainText('Every day at 09:00');
    await expect(panel).toContainText('America/Sao_Paulo');
    expect(await accessibilityViolations(page)).toEqual([]);
    // Its pages are tabs: arrow keys, Home, and End move between them and select them.
    const summary = panel.getByRole('tab', { name: 'Summary' });
    await expect(summary).toHaveAttribute('aria-selected', 'true');
    await summary.focus();
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: 'Steps' })).toBeFocused();
    await expect(panel.getByRole('list', { name: 'Steps' })).toBeVisible();
    await page.keyboard.press('End');
    await expect(panel.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('list', { name: 'Runs' })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(summary).toBeFocused();
    await expect(panel).toContainText('Every day at 09:00');
    // Escape and Back each return to the Team's list, focused on the Routine the panel was opened from.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(item).toBeFocused();
    await item.click();
    await panel.getByRole('button', { name: 'Back to Routines' }).click();
    await expect(panel).toHaveCount(0);
    await expect(item).toBeFocused();
    await item.click();

    // Resume turns dispatch back on, and Pause turns it off again; focus stays on the button that replaced the one
    // pressed.
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeFocused();
    await expect.poll(() => calls.resumes).toEqual([ROUTINE_VIEW.routine_id]);
    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByRole('button', { name: 'Resume' })).toBeFocused();
    await expect.poll(() => calls.pauses).toEqual([ROUTINE_VIEW.routine_id]);

    // A recent run, on the Runs page, opens its execution details.
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('button', { name: 'Execution details' }).click();
    const details = page.getByRole('dialog', { name: 'Execution details' });
    await expect(details).toContainText('No failed attempts were recorded for this run.');
    await expect.poll(() => diagnostics).toEqual([failed]);
    await details.getByRole('button', { name: 'Close' }).click();
    await expect(details).toHaveCount(0);

    // Delete turns the whole panel into its confirmation: no pages and no other action, only Cancel and Delete.
    const trash = panel.getByRole('button', { name: 'Delete' });
    await trash.click();
    const confirm = page.getByRole('dialog', { name: `Delete “${ROUTINE_VIEW.name}”?` });
    await expect(confirm).toContainText('It will never run again, and a run in progress is stopped.');
    await expect(confirm.getByRole('tab')).toHaveCount(0);
    await expect(confirm.getByRole('button')).toHaveText(['Cancel', 'Delete']);
    const password = confirm.getByLabel('Supervisor password');
    const sixDigits = confirm.getByLabel('Six-digit code');
    await expect(password).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);
    // Cancel and Escape each return to the panel, focused on its Delete again; nothing was asked of Admin.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(trash).toBeFocused();
    await trash.click();
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(trash).toBeFocused();
    expect(calls.begins).toEqual([]);

    // A wrong password keeps the confirmation open with the error on the password, emptied and focused.
    await trash.click();
    await password.fill('not the passphrase');
    await sixDigits.fill('123456');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(password).toHaveAccessibleDescription('The Supervisor password is incorrect.');
    await expect(password).toHaveValue('');
    await expect(password).toBeFocused();
    expect(calls.deletes).toEqual([]);
    // A wrong code does the same for the code; the password stays for the next try.
    await password.fill(SUPERVISOR_PASSWORD);
    await sixDigits.fill('000000');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(sixDigits).toHaveAccessibleDescription(/That code was not accepted/);
    await expect(sixDigits).toHaveValue('');
    await expect(sixDigits).toBeFocused();
    await expect(password).toHaveValue(SUPERVISOR_PASSWORD);
    // The right password and code delete it, and the panel closes.
    await sixDigits.fill('123456');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(panel).toHaveCount(0);
    await expect(list).toHaveCount(0);
    await expect.poll(() => calls.begins).toEqual(Array(3).fill(ROUTINE_VIEW.routine_id));
    await expect.poll(() => calls.deletes).toEqual([{ code: '000000' }, { code: '123456' }]);
    // With no Routines left, focus returns to the Team's actions, whose menu no longer offers Routines.
    await expect(navigation.getByRole('button', { name: 'Actions for Marketing' })).toBeFocused();
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await expect(page.getByRole('menuitem', { name: 'Routines' })).toHaveCount(0);
  });

  // Deleted from its panel's own Delete, or from the decision of a held run, which the deletion sets aside.
  for (const held of [false, true]) {
    test(`a Routine whose run is still ending stays listed as being deleted (held run: ${held})`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
      await routeReadyChat(page);
      const calls = await routeRoutines(page, { runEnding: true, held });
      await page.goto('/chat/?team=marketing');
      await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
      await openRoutinePanel(page);
      // The deletion confirmation retitles the panel; it still names the Routine.
      const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
      await panel.getByRole('button', { name: 'Delete' }).click();
      await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
      await panel.getByLabel('Six-digit code').fill('123456');
      await panel.getByRole('button', { name: 'Delete' }).click();
      await expect(panel).toContainText('Being deleted');
      // Focus moves on to the page the panel shows again, never to the document.
      await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
      await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);
      await expect.poll(() => calls.deletes).toEqual([{ code: '123456' }]);
    });
  }

  test('a Routine deletion shows the shared sign-in lockout and deletes nothing', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const calls = await routeRoutines(page, { held: false, lockAfter: 2 });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    await openRoutinePanel(page);
    // The deletion confirmation retitles the panel; it still names the Routine.
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    const password = panel.getByLabel('Supervisor password');
    await panel.getByLabel('Six-digit code').fill('123456');
    await password.fill('not the passphrase');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(password).toHaveValue('');
    await password.fill('still not it');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Too many attempts. Try again in 42 seconds.');
    await password.fill(SUPERVISOR_PASSWORD);
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Too many attempts. Try again in 42 seconds.');
    // A refusal of the whole form gives the password field the request disabled its focus back.
    await expect(password).toBeFocused();
    expect(calls.deletes).toEqual([]);
  });

  test('a Routine deletion in flight cannot be dismissed, and a passkey the browser cancels deletes nothing', { tag: '@mobile' }, async ({ page }) => {
    await page.addInitScript(() => {
      navigator.credentials.get = () => Promise.reject(new DOMException('canceled', 'NotAllowedError'));
    });
    await routeReadyChat(page);
    const calls = await routeRoutines(page, { held: false, passkey: true });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await routeRead(page, 'routines.delete', async () => {
      await held;
      return undefined;
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    await openRoutinePanel(page);
    // The deletion confirmation retitles the panel; it still names the Routine.
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    // This address has a passkey, so it is offered beside the code; the code stays the default.
    const confirmWith = panel.getByRole('group', { name: 'Confirm with' });
    await expect(confirmWith.getByRole('radio', { name: 'Authenticator code' })).toBeChecked();
    await confirmWith.getByRole('radio', { name: 'Passkey' }).check();
    await expect(panel.getByLabel('Six-digit code')).toHaveCount(0);
    await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('alert')).toHaveText('The passkey request was canceled or timed out.');
    await expect.poll(() => calls.begins).toEqual([ROUTINE_VIEW.routine_id]);
    expect(calls.deletes).toEqual([]);

    // With the code, the deletion is sent; while it is in flight neither Escape nor Cancel leaves the confirmation.
    await confirmWith.getByRole('radio', { name: 'Authenticator code' }).check();
    await panel.getByLabel('Six-digit code').fill('123456');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(panel.getByRole('button', { name: 'Deleting…' })).toBeVisible();
    release();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => calls.deletes).toEqual([{ code: '123456' }]);
  });

  test('a passkey this address no longer has turns the deletion back to the code, whose field takes the focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    // The session listed a passkey, but the deletion's offer names none.
    const calls = await routeRoutines(page, { held: false });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    await openRoutinePanel(page);
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    await panel.getByRole('group', { name: 'Confirm with' }).getByRole('radio', { name: 'Passkey' }).check();
    await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('alert')).toHaveText(messages.en.security.passkeyMissing);
    await expect(panel.getByRole('group', { name: 'Confirm with' })).toHaveCount(0);
    await expect(panel.getByLabel('Six-digit code')).toBeFocused();
    expect(calls.deletes).toEqual([]);
  });

  test('a Routine deletion Team fails once it was asked empties what was typed, and focuses nothing the person pressed away from', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    await routeRoutines(page, { held: false });
    // Team cannot be reached once the proof is accepted; the second deletion waits until the test releases it.
    const deletes = [];
    let release = () => {};
    await routeRead(page, 'routines.delete', async ({ body: proof }) => {
      deletes.push(proof);
      if (deletes.length === 2) await new Promise((resolve) => { release = resolve; });
      return ok({ code: 'team-unavailable' }, 503);
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    await openRoutinePanel(page);
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    const password = panel.getByLabel('Supervisor password');
    const sixDigits = panel.getByLabel('Six-digit code');
    await password.fill(SUPERVISOR_PASSWORD);
    await sixDigits.fill('123456');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    // Team was asked with this proof, so it is spent: both fields are empty for the next try.
    await expect(password).toHaveValue('');
    await expect(sixDigits).toHaveValue('');
    await expect.poll(() => deletes).toEqual([{ code: '123456' }]);

    await password.fill(SUPERVISOR_PASSWORD);
    await sixDigits.fill('123456');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => deletes.length).toBe(2);
    // A press on the confirmation's text is the person's move; the focus it gave the dialog then falls to the document,
    // where the refusal must leave it.
    await panel.getByText(messages.en.routine.deletion.lead).click();
    await page.evaluate(() => document.activeElement.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    release();
    await expect(password).toBeEnabled();
    await expect(password).toHaveValue('');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  async function openHeldPanel(page, options = {}) {
    await routeReadyChat(page);
    const calls = await routeRoutines(page, options);
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    return { calls, panel: await openRoutinePanel(page) };
  }

  test('Delete in a decision opens the deletion confirmation, Cancel returns to the decision, and confirming deletes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const { calls, panel } = await openHeldPanel(page);
    // Until it is answered, nothing else is offered: no pages and no Routine actions besides Back, Close, and the
    // card's own.
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(4);
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete “${ROUTINE_VIEW.name}”?` });
    const password = confirm.getByLabel('Supervisor password');
    await expect(password).toBeFocused();
    await expect(confirm.getByRole('button')).toHaveText(['Cancel', 'Delete']);
    // Cancel returns to the decision, focused on the Delete it came from.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    const remove = panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' });
    await expect(remove).toBeFocused();
    expect(calls.answers).toEqual([]);
    await remove.click();
    await password.fill(SUPERVISOR_PASSWORD);
    await confirm.getByLabel('Six-digit code').fill('123456');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    // Excluir is the confirmed deletion itself, never a card answer.
    await expect.poll(() => calls.deletes).toEqual([{ code: '123456' }]);
    expect(calls.answers).toEqual([]);
  });

  test('a Routine waiting for an approval is that decision in its panel, and a run held after approval asks again', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    let runs = [frozenRun(run, 'human')];
    let incidents = [];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents }) : undefined));
    await routeRead(page, 'routines.challenge', () => ok(routineChallenge(run, localizedChallenge(humanRequest('approval')))));
    // Approving resumes the run, which Team then holds at a step whose effect is unknown.
    await routeRead(page, 'routines.human', (params) => {
      if (params.run_id !== run) return undefined;
      runs = [heldRun(run)];
      incidents = [heldIncident(run)];
      return ok({ team_id: 'marketing', run_id: run, status: 'held' });
    });
    await routeRead(page, 'routines.card', () => ok(recoveryCard(run, { tag: 'e'.repeat(64) })));
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const panel = await openRoutinePanel(page);
    await expect(panel).toContainText('Waiting for your approval of Replace DNS record');
    // Review is the one action besides going back to the list and closing the panel.
    await expect(panel.getByRole('button')).toHaveCount(3);
    await panel.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' }).getByRole('button', { name: 'Approve action' }).click();
    // The same run, now held, opens its recovery decision instead of leaving the panel without one.
    const choices = panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button');
    await expect.poll(() => choices.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
      .toEqual(['Run', 'Delete']);
    await expect(choices.first()).toBeFocused();
  });

  test('a held run listed before its incident keeps Retry in its panel until the card opens', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const runs = [heldRun(run)];
    let incidents = [];
    const openings = [];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents }) : undefined));
    await routeRead(page, 'routines.card', (params) => {
      openings.push(params.run_id);
      // Team has not indexed the incident at the first opening; it is listed from then on.
      if (openings.length === 1) {
        incidents = [heldIncident(run)];
        return ok({ code: 'routine-incident-unavailable' }, 404);
      }
      return ok(recoveryCard(run, { tag: 'e'.repeat(64) }));
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const panel = await openRoutinePanel(page);
    // The decision is not dismissed: it waits for the person to try again, never reopening on its own.
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button')).toHaveCount(2);
    expect(openings).toHaveLength(2);
    // The card it opened takes focus from the Retry it replaced.
    await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' })).toBeFocused();
  });

  // Whatever a refresh puts in place of what had focus, focus moves to what the person acts on next, never to the
  // document; focus the person placed elsewhere in the panel stays where it is.
  async function routeDecisions(page, state, card = (params) => ok(recoveryCard(params.run_id))) {
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing'
      ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: state.runs, incidents: state.incidents }) : undefined));
    await routeRead(page, 'routines.card', card);
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    return openRoutinePanel(page);
  }

  test('a held run that arrives while a tab has focus focuses its first choice', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const state = { runs: [], incidents: [] };
    const panel = await routeDecisions(page, state);
    await panel.getByRole('tab', { name: 'Summary' }).click();
    state.runs = [heldRun('d'.repeat(32))];
    state.incidents = [heldIncident('d'.repeat(32))];
    await raiseTopic(page, 'team/marketing/routines');
    await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' })).toBeFocused();
  });

  for (const view of ['view', 'execution details']) {
    test(`a held run that arrives while a run's ${view} is open focuses its first choice once it closes`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
      const failed = 'c'.repeat(32);
      await routeReadyChat(page, {
        history: { entries: [noticeRow(failed, ROUTINE_VIEW, 'failed', { code: 'assistant-rpc-failed' }, { at: NOTICE_AT })], before: null },
      });
      await routeRead(page, 'routines.diagnostics', (params) => ok({ team_id: 'marketing', run_id: params.run_id, diagnostics: [] }));
      const state = { runs: [], incidents: [] };
      const openings = [];
      const panel = await routeDecisions(page, state, (params) => {
        openings.push(params.run_id);
        return ok(recoveryCard(params.run_id));
      });
      await panel.getByRole('tab', { name: 'Runs' }).click();
      // The run's view is a second dialog named for the Routine, beside its panel.
      const opened = view === 'view'
        ? page.getByRole('dialog', { name: ROUTINE_VIEW.name })
        : page.getByRole('dialog', { name: 'Execution details' });
      const row = panel.getByRole('list', { name: 'Runs' }).getByRole('listitem');
      await (view === 'view' ? row.getByRole('button').first() : row.getByRole('button', { name: 'Execution details' })).click();
      await expect(opened).toHaveCount(view === 'view' ? 2 : 1);
      // The decision replaces the Runs page, and with it what opened the run.
      state.runs = [heldRun('d'.repeat(32))];
      state.incidents = [heldIncident('d'.repeat(32))];
      await raiseTopic(page, 'team/marketing/routines');
      await expect.poll(() => openings).toEqual(['d'.repeat(32)]);
      await page.keyboard.press('Escape');
      await expect(opened).toHaveCount(view === 'view' ? 1 : 0);
      await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' })).toBeFocused();
    });
  }

  test('a held run that arrives after one was held again leaves focus on Close', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const state = { runs: [frozenRun(run, 'integrations')], incidents: [] };
    await routeRead(page, 'routines.challenge', (params) => ok({ team_id: 'marketing', run_id: params.run_id, status: 'integrations-required' }));
    await routeRead(page, 'routines.integrations', (params) => {
      state.runs = [heldRun(params.run_id)];
      state.incidents = [heldIncident(params.run_id)];
      return ok({ team_id: 'marketing', run_id: params.run_id, status: 'held' });
    });
    await routeRead(page, 'routines.card_answer', (params) => {
      state.runs = [];
      state.incidents = [];
      return ok({ team_id: 'marketing', run_id: params.run_id });
    });
    const panel = await routeDecisions(page, state);
    await panel.getByRole('button', { name: 'Review' }).click();
    await panel.getByRole('button', { name: 'Continue the run' }).click();
    const choices = panel.getByRole('group', { name: 'Recovery choices' });
    await choices.getByRole('button', { name: 'Run' }).click();
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
    const close = panel.getByRole('button', { name: 'Close' });
    await close.focus();
    state.runs = [heldRun('e'.repeat(32))];
    state.incidents = [heldIncident('e'.repeat(32))];
    await raiseTopic(page, 'team/marketing/routines');
    await expect(choices.getByRole('button', { name: 'Run' })).toBeEnabled();
    await expect(close).toBeFocused();
  });

  test('an answer that settles after the person moved to Close leaves focus on Close', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const state = { runs: [heldRun(run)], incidents: [heldIncident(run)] };
    let release;
    const answered = new Promise((resolve) => { release = resolve; });
    await routeRead(page, 'routines.card_answer', async (params) => {
      await answered;
      state.runs = [];
      state.incidents = [];
      return ok({ team_id: 'marketing', run_id: params.run_id });
    });
    const panel = await routeDecisions(page, state);
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' }).click();
    const close = panel.getByRole('button', { name: 'Close' });
    await close.focus();
    release();
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(close).toBeFocused();
  });

  test('a retry Team answers with a settled run focuses the summary tab', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const state = { runs: [heldRun(run)], incidents: [heldIncident(run)] };
    let openings = 0;
    const panel = await routeDecisions(page, state, () => {
      openings += 1;
      if (openings === 1) return ok({ detail: 'unavailable' }, 503);
      // The run settled elsewhere before the retry.
      state.runs = [];
      state.incidents = [];
      return ok({ code: 'routine-incident-unavailable' }, 404);
    });
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
  });

  test('a run answered whose next run waits for approval focuses Review', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const state = { runs: [heldRun(run)], incidents: [heldIncident(run)] };
    await routeRead(page, 'routines.card_answer', (params) => {
      state.runs = [frozenRun('e'.repeat(32), 'human')];
      state.incidents = [];
      return ok({ team_id: 'marketing', run_id: params.run_id });
    });
    const panel = await routeDecisions(page, state);
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' }).click();
    await expect(panel.getByRole('button', { name: 'Review' })).toBeFocused();
  });

  // Team cannot open a card for a held run whose evidence it cannot verify or whose state it cannot read; its Routine
  // can still be deleted from the decision, which hides the panel's own Delete.
  for (const code of ['routine-incident-unverifiable', 'routine-state-unavailable']) {
    test(`a held run whose card fails with ${code} still offers its Routine's confirmed deletion`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
      await routeReadyChat(page);
      const weekly = { ...ROUTINE_VIEW, routine_id: 'c'.repeat(32), name: 'Certificate check' };
      const calls = await routeRoutines(page, { others: [weekly], heldCall: false });
      let openings = 0;
      await routeRead(page, 'routines.card', () => {
        openings += 1;
        return ok({ code }, 409);
      });
      await page.goto('/chat/?team=marketing');
      await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
      await openRoutinePanel(page);
      // The deletion confirmation retitles the panel; it still names the Routine.
      const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
      const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
      // A retry that fails again keeps focus on Retry.
      const retry = panel.getByRole('button', { name: 'Retry' });
      await retry.click();
      await expect.poll(() => openings).toBe(2);
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      const remove = panel.getByRole('button', { name: 'Delete' });
      await remove.click();
      // Cancel returns to the decision, focused on the Delete it came from.
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await expect(remove).toBeFocused();
      await remove.click();
      await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
      await panel.getByLabel('Six-digit code').fill('123456');
      await panel.getByRole('button', { name: 'Delete' }).click();
      await expect(list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) })).toHaveCount(0);
      expect(calls.deletes).toHaveLength(1);
    });
  }

  test('a decision and a plan the panel shows because a run changed in the background never report activity', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await page.clock.install();
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    let runs = [];
    let incidents = [];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents }) : undefined));
    // Team has no card for the run that was held: the panel reads the Routine list again on its own.
    const cards = [];
    await routeRead(page, 'routines.card', (params) => {
      cards.push(params.run_id);
      return ok({ code: 'routine-incident-unavailable' }, 404);
    });
    const steps = [];
    await routeRead(page, 'routines.plan_steps', (params) => {
      steps.push(params.offset);
      return undefined;
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Steps' }).click();
    await expect.poll(() => steps.length).toBe(1);
    // The person's clicks were reported once; then a minute passes with nobody at the page.
    await expect.poll(() => activityReports(page)).toBe(1);
    await page.clock.fastForward(61_000);

    // A run is held while nobody watches: the panel opens its decision on its own.
    runs = [heldRun(run)];
    await routineNotice(page);
    await expect.poll(() => cards.length).toBeGreaterThan(0);
    // The run ended on its own as well: the plan the person was reading shows again.
    runs = [];
    await routineNotice(page);
    await expect.poll(() => steps.length).toBeGreaterThan(1);
    // Nothing the panel did on its own kept the session alive.
    expect(await activityReports(page)).toBe(1);
  });

  test('an answer that arrives after its Routine moved on never dismisses the newer decision', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    let runs = [heldRun(run)];
    let incidents = [heldIncident(run)];
    let release;
    const answered = new Promise((resolve) => { release = resolve; });
    const openings = [];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents }) : undefined));
    await routeRead(page, 'routines.card', (params) => {
      openings.push(params.run_id);
      return ok(recoveryCard(run, { tag: 'e'.repeat(64) }));
    });
    // Rodar starts a fresh run, which freezes for an approval that the Team lists before the answer itself is
    // delivered.
    await routeRead(page, 'routines.card_answer', async () => {
      runs = [frozenRun(run, 'human')];
      incidents = [];
      await answered;
      return ok({ team_id: 'marketing', run_id: run });
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const panel = await openRoutinePanel(page);
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' }).click();
    await routineNotice(page);
    await expect(panel.getByRole('button', { name: 'Review' })).toBeVisible();
    release();
    // The late answer belonged to the held decision; the approval it led to stays in front of the person.
    await page.clock.fastForward(1_000);
    await expect(panel.getByRole('button', { name: 'Review' })).toBeVisible();
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    expect(openings).toHaveLength(1);
  });

  test('deleting one of several Routines returns to the Team\'s list of the others, which then returns focus to its button', { tag: '@mobile' }, async ({ page }) => {
    await routeReadyChat(page);
    const weekly = { ...ROUTINE_VIEW, routine_id: 'c'.repeat(32), name: 'Certificate check' };
    await routeRoutines(page, { others: [weekly], held: false });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    const button = navigation.getByRole('button', { name: /^Routines for Marketing/ });
    await button.click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    await list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await panel.getByLabel('Six-digit code').fill('123456');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) })).toHaveCount(0);
    await expect(list.getByRole('button', { name: /Certificate check/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('a Team\'s Routine list is searched by similar text and paged three at a time', { tag: '@mobile' }, async ({ page }) => {
    await routeReadyChat(page);
    const routine = (digit, name) => ({ ...ROUTINE_VIEW, routine_id: digit.repeat(32), name });
    await routeRoutines(page, {
      held: false,
      others: [routine('c', 'Certificate check'), routine('d', 'Monthly DNS cleanup'), routine('e', 'Weekly www update')],
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    const rows = list.getByRole('group', { name: 'Routines' }).getByRole('button');
    // Four Routines show three per page, with the page said in words.
    await expect(rows).toHaveCount(3);
    await expect(list.getByText('Page 1 of 2')).toBeVisible();
    await expect(list.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await list.getByRole('button', { name: 'Next' }).click();
    await expect(rows).toHaveCount(1);
    await expect(list.getByText('Page 2 of 2')).toBeVisible();
    await expect(list.getByRole('button', { name: 'Next' })).toBeDisabled();
    // A search with a typo still finds its Routine, from the first page; nothing similar says so.
    const search = list.getByRole('searchbox', { name: 'Search Routines' });
    await search.fill('certficate');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAccessibleName('Certificate check');
    await expect(list.getByRole('navigation', { name: 'Routine pages' })).toHaveCount(0);
    await search.fill('pizza delivery');
    await expect(rows).toHaveCount(0);
    await expect(list.getByRole('status')).toHaveText('No Routine looks like “pizza delivery”.');
    await search.fill('');
    await expect(rows).toHaveCount(3);
  });

  test("a Routine's runs never reach the chat, which shows its creation, and are listed in the Routine's history", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const entry = (id, outcome, detail, at = NOTICE_AT) => noticeRow(id, ROUTINE_VIEW, outcome, detail, { at });
    await routeReadyChat(page, {
      history: {
        entries: [
          entry('a'.repeat(32), 'created', {}, '2026-10-01T11:00:00Z'),
          entry('f'.repeat(32), 'skipped', { missed: 2 }, '2026-10-01T11:30:00Z'),
          entry('c'.repeat(32), 'failed', { code: 'assistant-rpc-failed' }),
          entry('d'.repeat(32), 'frozen', { request_kind: 'human' }),
          entry('b'.repeat(32), 'done', { plan: ROUTINE_VIEW.plan, output: null }),
        ],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    // The chat names the Routine once, where it was created, and offers nothing to open.
    const transcript = page.locator('.routine-run');
    await expect(transcript).toHaveCount(1);
    await expect(transcript).toHaveAccessibleName(ROUTINE_VIEW.name);
    await expect(transcript.getByRole('button')).toHaveCount(0);
    // Its runs are its own history, newest first, each with what it did.
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' }).getByRole('listitem');
    await expect(runs).toHaveCount(4);
    await expect(runs.nth(0).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await expect(runs.nth(1)).toContainText(messages.en.routine.panel.waitingApproval);
    await expect(runs.nth(2)).toContainText('assistant-rpc-failed');
    await expect(runs.nth(3)).toContainText('2 runs missed');
    await expect(runs.nth(3).getByRole('button')).toHaveCount(0);
  });

  test('a Routine run that shows its result opens it in full: its own step records and the result as escaped data', { tag: '@mobile' }, async ({ page, context }) => {
    // ADR-0092 amendment, 2026-10-05 (output): the run's zones with their nested account, a value Team redacted, and a
    // hostile value as text, opened from the Routine's history by the run's outcome.
    const text = (value) => ({ kind: 'text', value, cut: false });
    const account = { kind: 'fields', fields: [['id', text('023e105f4ecef8ad9ca31a8372d0c353')], ['name', text('Main account')]], omitted: 0 };
    const zone = (id, name, paused) => ({
      kind: 'fields',
      fields: [['account', account], ['id', text(id)], ['name', text(name)], ['paused', { kind: 'bool', value: paused }]],
      omitted: 0,
    });
    const shown = {
      step: 1,
      state: 'shown',
      value: {
        kind: 'fields',
        fields: [
          ['a-b', { kind: 'number', value: '0.0001' }],
          ['a_b', { kind: 'number', value: '12345678901234567890' }],
          ['cut', { kind: 'list', items: [{ kind: 'fields', fields: [['name', text('example.net')]], omitted: 3 }], omitted: 0 }],
          ['extra', { kind: 'fields', fields: [], omitted: 0 }],
          ['token', { kind: 'redacted' }],
          ['zones', {
            kind: 'list',
            items: [zone('9a7806061c88ada191ed06f989cc3dac', 'example.com', false), zone('4b2b5b3e9d0c4f0aa1b7c6d5e4f30211', '<img src=x onerror=alert(1)>.dev', true)],
            omitted: 7,
          }],
        ],
        omitted: 0,
      },
      truncated: true,
    };
    const entry = (id, detail) => noticeRow(id, ROUTINE_VIEW, 'done', detail, { at: NOTICE_AT });
    const run = 'b'.repeat(32);
    const other = 'd'.repeat(32);
    const plan = ROUTINE_VIEW.plan;
    const twoSteps = planSummary([...ROUTINE_PLAN, { ...ROUTINE_PLAN[0], position: 2, action: 'list-dns-records', inputs: [] }]);
    const unchanged = { step: 1, state: 'unchanged', value: null, truncated: false };
    const dialogs = [];
    page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await routeReadyChat(page, {
      history: {
        entries: [
          entry(run, { plan, output: shown }),
          entry('c'.repeat(32), { plan, output: unchanged }),
          entry(other, { plan: twoSteps, output: { ...shown, step: 2 } }),
        ],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    // Each run's own step records: the inputs its attempt was given, as Team's redacted previews.
    const record = (position, action, inputs) => ({
      position: position, status: 'done', assistant_id: 'shimpz-cloudflare', action, attempt: 1, duration_ms: 812, inputs,
    });
    const records = {
      [run]: [record(1, 'list-zones', [{ member: 'page', value: '1' }, { member: 'token', value: null }])],
      ['c'.repeat(32)]: [record(1, 'list-zones', [])],
      [other]: [record(1, 'list-zones', []), record(2, 'list-dns-records', null)],
    };
    await routeRead(page, 'routines.run_steps', ({ run_id: runId }) => (
      ok(runStepsPage(runId, ROUTINE_VIEW.routine_id, runId === other ? twoSteps : plan, records[runId]))
    ));
    const diagnostics = [];
    await routeRead(page, 'routines.diagnostics', ({ run_id: runId }) => {
      diagnostics.push(runId);
      return ok(
        {
          team_id: 'marketing',
          run_id: runId,
          diagnostics: [diagnostic({
            action: 'list-zones',
            position: 1,
            failure: httpFailure({
              message: "Client error '429 Too Many Requests' <b>escaped</b>",
              http_status: 429,
              truncated: true,
            }),
          })],
        },
      );
    });
    await page.goto('/chat/?team=marketing');
    // No run reaches the chat; each opens from its Routine's history, newest first.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' }).getByRole('listitem');
    await expect(runs).toHaveCount(3);
    // The history keeps the result out of its list: the run's outcome opens it.
    await expect(runs.nth(2).getByRole('table')).toHaveCount(0);
    const link = runs.nth(2).getByRole('button', { name: 'Done', exact: true });
    await link.click();
    const view = page.getByRole('dialog', { name: ROUTINE_VIEW.name })
      .filter({ has: page.getByRole('region', { name: 'Steps' }) });
    await expect(view).toBeVisible();
    // The view opens as its diagnostics request leaves; the request reaches the route a moment later.
    await expect.poll(() => diagnostics).toEqual([run]);

    // Its steps as the run recorded them: the Action, the inputs its attempt was given with a hidden one never shown,
    // and the failed attempt Team recorded.
    const steps = view.getByRole('region', { name: 'Steps' });
    await expect(steps.locator('ol > li')).toHaveCount(1);
    await expect(steps.getByRole('listitem').first()).toContainText('List zones');
    await expect(steps.locator('dd')).toHaveText(['1']);
    await expect(steps.getByTitle('Token: hidden')).toBeVisible();
    await expect(steps).toContainText("Client error '429 Too Many Requests' <b>escaped</b>");
    await expect(steps.locator('b')).toHaveCount(0);
    // Shortened evidence says it was shortened.
    await expect(steps).toContainText('This record was shortened.');

    // The result: the zones as a table whose nested account spreads into its own columns, values as text.
    const result = view.getByRole('region', { name: 'Response' });
    const table = result.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Account name', 'Account ID', 'Paused', 'ID']);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([
      'example.com', 'Main account', '023e105f4ecef8ad9ca31a8372d0c353', 'no', '9a7806061c88ada191ed06f989cc3dac',
    ]);
    await expect(table.getByRole('row').nth(2).getByRole('cell').first()).toHaveText('<img src=x onerror=alert(1)>.dev');
    await expect(result).toContainText('7 more');
    await expect(result).toContainText('hidden');
    // A field set with nothing in it says so.
    await expect(result.getByText('Nothing', { exact: true })).toBeVisible();
    await expect(view).toContainText('Showing part of the result.');
    // Nothing the run produced renders as markup: the view's one link is its step's Assistant, with that Assistant's icon.
    await expect(result.locator('img, a, script')).toHaveCount(0);
    await expect(view.locator('script')).toHaveCount(0);
    await expect(view.getByRole('link')).toHaveCount(1);
    await expect(view.getByRole('link')).toHaveAttribute('href', '/assistants/shimpz-cloudflare?team=marketing');
    // Two labels that would read alike stay as Team wrote them, and numbers read exactly, never rounded.
    await expect(result.getByText('a-b', { exact: true })).toBeVisible();
    await expect(result.getByText('a_b', { exact: true })).toBeVisible();
    await expect(result).toContainText('0.0001');
    await expect(result).toContainText('12345678901234567890');
    // A field set Team cut short keeps its own rows and says how many more it left out, never a table row.
    await expect(result.getByRole('table')).toHaveCount(1);
    await expect(result).toContainText('example.net');
    await expect(result).toContainText('3 more');
    // An identifier copies exactly the value Team projected.
    await table.getByRole('button', { name: 'Copy 9a7806061c88ada191ed06f989cc3dac' }).click();
    await expect(view.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('9a7806061c88ada191ed06f989cc3dac');
    expect(await accessibilityViolations(page)).toEqual([]);

    // Escape closes the view and returns focus to the outcome that opened it, in the Routine's panel.
    await page.keyboard.press('Escape');
    await expect(view).toHaveCount(0);
    await expect(link).toBeFocused();
    await expect(panel).toBeVisible();
    // The outcome opens the run from the keyboard as well.
    await page.keyboard.press('Enter');
    await expect(view).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(view).toHaveCount(0);
    await expect(link).toBeFocused();

    // A run whose result did not change opens without one.
    await runs.nth(1).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Steps' })).toBeVisible();
    await expect(view.getByRole('region', { name: 'Response' })).toHaveCount(0);
    await view.getByRole('button', { name: 'Close' }).click();
    await expect(view).toHaveCount(0);
    // Another run shows its own records, read for exactly that run.
    await runs.nth(0).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Steps' }).locator('ol > li')).toHaveCount(2);
    await expect(view.getByRole('region', { name: 'Steps' }).locator('dd')).toHaveCount(0);
    await view.getByRole('button', { name: 'Close' }).click();
    await expect(view).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test("a Routine plan whose step read failed resumes when the Routine list is read again", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const scenario = await routeScenario(page, 'routine-lifecycle');
    const [watch] = scenario.call('routines.list', { team_id: 'marketing' }).json.routines;
    let refusals = 1;
    await routeRead(page, 'routines.plan_steps', (params) => {
      if (params.routine_id !== watch.routine_id || refusals === 0) return undefined;
      refusals -= 1;
      return ok({ detail: 'unavailable' }, 503);
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page, watch.name);
    await panel.getByRole('tab', { name: 'Steps' }).click();
    const steps = panel.getByRole('list', { name: 'Steps' }).locator(':scope > li');
    await expect(panel.getByText(messages.en.routine.plan.unavailable)).toBeVisible();
    await expect(steps).toHaveCount(0);
    // Admin says the Team's Routines changed (ADR-0114), so the page reads them again.
    const reread = nextRead(page, 'routines.list');
    await raiseTopic(page, 'team/marketing/routines');
    await reread;
    await expect(steps).toHaveCount(10);
    await expect(panel.getByText(messages.en.routine.plan.unavailable)).toHaveCount(0);
  });

  test("a 120-step Routine's plan shows its summary at once and reads its steps page by page as they are revealed", { tag: '@slow' }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    // ADR-0092 amendment, 2026-10-05 (scale): the continuous watch repeats one Action for each of its zones.
    const scenario = await routeScenario(page, 'routine-lifecycle');
    const [watch] = scenario.call('routines.list', { team_id: 'marketing' }).json.routines;
    expect(watch.plan.steps).toBe(120);
    const read = [];
    await routeRead(page, 'routines.plan_steps', ({ revision, offset }) => {
      read.push(`${revision}/${offset}`);
      return undefined;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page, watch.name);
    await panel.getByRole('tab', { name: 'Steps' }).click();
    const steps = panel.getByRole('list', { name: 'Steps' }).locator(':scope > li');
    // Only the first page is read; ten steps are shown.
    await expect(steps).toHaveCount(10);
    await expect.poll(() => read).toEqual(['1/0']);
    expect(await accessibilityViolations(page)).toEqual([]);
    const more = panel.getByRole('button', { name: /^Show \d+ more steps?$/u });
    for (let shown = 20; shown <= 60; shown += 10) {
      await more.click();
      await expect(steps).toHaveCount(shown);
    }
    // The first page holds 64 steps, so revealing past it reads the next page, and focus moves to the first new step.
    await expect.poll(() => read).toEqual(['1/0']);
    await more.click();
    await expect(steps).toHaveCount(70);
    await expect.poll(() => read).toEqual(['1/0', '1/64']);
    await expect(steps.nth(60)).toBeFocused();
    // Reading the Routine list again when Admin says it changed keeps what was read and revealed for the same revision.
    // Admin says the Team's Routines changed (ADR-0114), so the page reads them again.
    const reread = nextRead(page, 'routines.list');
    await raiseTopic(page, 'team/marketing/routines');
    await reread;
    await expect(steps).toHaveCount(70);
    await expect.poll(() => read).toEqual(['1/0', '1/64']);
    for (let shown = 80; shown <= 120; shown += 10) {
      await more.click();
      await expect(steps).toHaveCount(Math.min(shown, 120));
    }
    await expect(more).toHaveCount(0);
    await expect(steps.nth(119)).toContainText('120');
    await expect.poll(() => read).toEqual(['1/0', '1/64']);
  });

  test('a Routine whose revision changed while its steps were read shows only the new revision', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const scenario = await routeScenario(page, 'routine-lifecycle');
    const listed = scenario.call('routines.list', { team_id: 'marketing' }).json;
    const [watch] = listed.routines;
    // The first step's literal carries a bidi override that Team escaped in its preview.
    const steps = Array.from({ length: 3 }, (_, index) => ({
      position: index + 1,
      assistant: 'shimpz-cloudflare',
      action: 'list-zones',
      read_only: true,
      inputs: index ? [] : [{ member: 'name', source: 'literal', value: '"a\\u202eb"' }],
      stored_inputs: [],
    }));
    const revised = planSummary(steps, 2);
    let changed = false;
    const read = [];
    await routeRead(page, 'routines.plan_steps', ({ routine_id: routineId, revision, offset }) => {
      if (routineId !== watch.routine_id) return undefined;
      read.push(`${revision}/${offset}`);
      if (revision === '1') {
        changed = true;
        return ok({ code: 'routine-revision-changed' }, 409);
      }
      return ok(planPage(watch.routine_id, revised, steps, Number(offset)));
    });
    // Once Team refused the old revision, the Routine list names the new one.
    await routeRead(page, 'routines.list', (params) => (changed && params.team_id === 'marketing'
      ? ok({ ...listed, routines: listed.routines.map((item) => (item.routine_id === watch.routine_id ? { ...item, plan: revised } : item)) })
      : undefined));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page, watch.name);
    await panel.getByRole('tab', { name: 'Steps' }).click();
    await expect(panel.getByRole('list', { name: 'Steps' }).locator(':scope > li')).toHaveCount(3);
    await expect.poll(() => read).toEqual(['1/0', '2/0']);
    // The escape stays visible text: decoding the preview never puts the raw override into the page.
    await expect(panel.getByRole('list', { name: 'Steps' }).locator('dd').first()).toHaveText('a\\u202eb');
    expect(await page.evaluate(() => document.body.textContent.includes('\u202e'))).toBe(false);
    await expect(panel.getByRole('button', { name: /^Show \d+ more steps?$/u })).toHaveCount(0);
  });

  test('a run view pages its own step records: a failed step, steps that never ran, and records read again once they changed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'b'.repeat(32);
    const total = 70;
    const plan = planSummary(Array.from({ length: total }, () => ({ assistant: 'shimpz-cloudflare', action: 'list-dns-records' })));
    const status = messages.en.routine.result.status;
    await routeReadyChat(page, {
      history: {
        entries: [noticeRow(run, ROUTINE_VIEW, 'done', {
          plan,
          output: { step: total, state: 'shown', value: { kind: 'text', value: 'ok', cut: false }, truncated: false },
        }, { at: NOTICE_AT })],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await routeRead(page, 'routines.diagnostics', () => ok({ team_id: 'marketing', run_id: run, diagnostics: [] }));
    // Fifty-nine steps were done, Stop cut the next one, the one after failed, one record is gone, and the run never
    // started the rest.
    const gap = (position, kind) => ({
      position: position, status: kind, assistant_id: null, action: null, attempt: null, duration_ms: null, inputs: null,
    });
    const records = Array.from({ length: total }, (_, index) => {
      const position = index + 1;
      if (position > 62) return gap(position, 'not_run');
      if (position === 62) return gap(position, 'unavailable');
      return {
        position: position,
        status: { 60: 'stopped', 61: 'failed' }[position] ?? 'done',
        assistant_id: 'shimpz-cloudflare',
        action: 'list-dns-records',
        attempt: position === 61 ? 3 : 1,
        duration_ms: 812,
        // Team escaped a bidi override in the first step's preview.
        inputs: [{ member: 'zone_id', value: position === 1 ? '"zone\\u202e-1"' : `"zone-${position}"` }],
      };
    });
    const read = [];
    let latest = 0;
    const OLD = 'c'.repeat(32);
    const NEW = 'e'.repeat(32);
    await routeRead(page, 'routines.run_steps', ({ snapshot, offset }) => {
      read.push(`${snapshot === 'latest' ? 'latest' : snapshot[0]}/${offset}`);
      // The snapshot read first changed before its second page was read.
      if (snapshot === OLD && offset === '64') return ok({ code: 'routine-run-changed' }, 409);
      if (snapshot === 'latest') latest += 1;
      const current = snapshot === 'latest' ? (latest === 1 ? OLD : NEW) : snapshot;
      return ok(runStepsPage(run, ROUTINE_VIEW.routine_id, plan, records, { snapshot: current, offset: Number(offset) }));
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('list', { name: 'Runs' }).getByRole('button', { name: 'Done', exact: true }).click();
    const steps = page.getByRole('region', { name: 'Steps' });
    const items = steps.locator('ol > li');
    await expect(items).toHaveCount(10);
    await expect.poll(() => read).toEqual(['latest/0']);
    const more = steps.getByRole('button', { name: /^Show \d+ more steps?$/u });
    for (let shown = 20; shown <= 60; shown += 10) {
      await more.click();
      await expect(items).toHaveCount(shown);
    }
    // Past the first page the changed snapshot is refused, so the records are read again from the newest.
    await more.click();
    await expect(items).toHaveCount(70);
    await expect.poll(() => read).toEqual(['latest/0', 'c/64', 'latest/0', 'e/64']);
    await expect(more).toHaveCount(0);
    // The stopped and failed steps name their Action, and every step without a record says why, with no Action or input.
    await expect(items.nth(59)).toContainText(status.stopped);
    await expect(items.nth(60)).toContainText(status.failed);
    await expect(items.nth(60)).toContainText('List DNS records');
    await expect(items.nth(60).locator('dd')).toHaveText('zone-61');
    // The escape stays visible text: decoding the preview never puts the raw override into the page.
    await expect(items.nth(0).locator('dd')).toHaveText('zone\\u202e-1');
    expect(await page.evaluate(() => document.body.textContent.includes('\u202e'))).toBe(false);
    await expect(items.nth(61)).toContainText(status.unavailable);
    for (const index of [62, 69]) {
      await expect(items.nth(index)).toContainText(status.not_run);
      await expect(items.nth(index)).not.toContainText('List DNS records');
      await expect(items.nth(index).locator('dd')).toHaveCount(0);
    }
  });

  test('every run opens its own step records: a failed run whose notice names no plan, and a completed run that shows no result', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const scenario = await routeScenario(page, 'routine-lifecycle');
    const { routines } = scenario.call('routines.list', { team_id: 'marketing' }).json;
    const [watch, , daily] = routines;
    const status = messages.en.routine.result.status;
    const read = [];
    await routeRead(page, 'routines.run_steps', ({ run_id: runId, snapshot, offset }) => {
      read.push(`${runId[0]}:${snapshot === 'latest' ? 'latest' : 'snapshot'}/${offset}`);
      return undefined;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page, daily.name);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    // The failed run shows no result, so its outcome opens its steps: the step that failed and the one never run.
    const opener = panel.getByRole('list', { name: 'Runs' }).getByRole('button', { name: /^Failed/u });
    await expect(opener).toHaveCount(1);
    await opener.click();
    const withSteps = { has: page.getByRole('region', { name: 'Steps' }) };
    let view = page.getByRole('dialog', { name: daily.name }).filter(withSteps);
    const steps = view.getByRole('region', { name: 'Steps' }).locator('ol > li');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText(status.failed);
    await expect(steps.nth(1)).toContainText(status.not_run);
    await expect(view.getByRole('region', { name: 'Response' })).toHaveCount(0);
    await expect.poll(() => read).toEqual(['7:latest/0']);
    await page.keyboard.press('Escape');
    await expect(view).toHaveCount(0);
    await expect(opener).toBeFocused();

    // The continuous watch's completed run hands its result on: no result to show, and its 120 steps read by page.
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('group', { name: 'Routines' }).getByRole('button', { name: new RegExp(`^${RegExp.escape(watch.name)}`) }).click();
    const watchPanel = page.getByRole('dialog', { name: watch.name, exact: true });
    await watchPanel.getByRole('tab', { name: 'Runs' }).click();
    const completed = watchPanel.getByRole('list', { name: 'Runs' }).getByRole('button', { name: 'Done', exact: true });
    await expect(completed).toHaveCount(1);
    await completed.click();
    view = page.getByRole('dialog', { name: watch.name }).filter(withSteps);
    const records = view.getByRole('region', { name: 'Steps' }).locator('ol > li');
    await expect(records).toHaveCount(10);
    await expect(view.getByRole('region', { name: 'Response' })).toHaveCount(0);
    const more = view.getByRole('button', { name: /^Show \d+ more steps?$/u });
    for (let shown = 20; shown <= 70; shown += 10) {
      await more.click();
      await expect(records).toHaveCount(shown);
    }
    await expect.poll(() => read).toEqual(['7:latest/0', 'c:latest/0', 'c:snapshot/64']);
    await expect(records.nth(69)).toContainText(status.done);
  });

  test('a Routine notice shows the name Team froze into it as literal text, never as a link, image, or element', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    // A name's 80 characters still fit every kind of markup it could imitate.
    const name = '[x](https://e.test) ![i](https://e.test/a.png) <img src=x onerror=alert(1)>**b**';
    // Team lists the Routine under a newer name now; each notice keeps the name it was written with.
    const listed = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name: 'Renamed later' };
    const row = (id, routineId, outcome, detail) => noticeRow(id, { routine_id: routineId, name }, outcome, detail, { at: NOTICE_AT });
    await routeReadyChat(page, {
      history: {
        entries: [
          row('b'.repeat(32), 'a'.repeat(32), 'created', {}),
          row('c'.repeat(32), listed.routine_id, 'failed', { code: 'assistant-rpc-failed' }),
          row('d'.repeat(32), 'f'.repeat(32), 'done', { plan: ROUTINE_VIEW.plan, output: null }),
        ],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [listed], runs: [], incidents: [] }) : undefined));
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto('/chat/?team=marketing');
    // The chat shows the creation, under the name it was written with, whatever markup it imitates.
    const notice = page.locator('.routine-run');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(name);
    await expect(notice).not.toContainText(listed.name);
    await expect(notice.getByRole('link')).toHaveCount(0);
    await expect(notice.getByRole('img')).toHaveCount(0);
    await expect(notice.getByRole('heading')).toHaveCount(0);
    await expect(notice.locator('a, img, script, iframe, em, strong')).toHaveCount(0);
    await expect(notice).toHaveAccessibleName(name);
    // A run opened from its Routine's history, listed under its newer name, is titled by its own notice's name.
    const panel = await openRoutinePanel(page, listed.name);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('list', { name: 'Runs' }).getByRole('button', { name: /^Failed/u }).click();
    const view = page.getByRole('dialog', { name }).filter({ has: page.getByRole('region', { name: 'Steps' }) });
    await expect(view.getByRole('heading', { level: 2 })).toHaveText(name);
    await expect(view.getByRole('heading', { level: 2 }).locator('a, img, script, iframe, em, strong')).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(requests.filter((url) => /e(?:vil)?\.test/u.test(url))).toEqual([]);
  });

  // A Routine row of the transcript (ADR-0086), for one listed Routine.
  function routineRow(id, outcome, detail, { routine = ROUTINE_VIEW, version = 1, at = NOTICE_AT, usage, lost = false } = {}) {
    return noticeRow(id, routine, outcome, detail, { at, version, usage, lost });
  }

  // A Routine's creation notice, the one Routine row the chat shows, naming the Routine `routine` was created as.
  function createdRow(id, routine = ROUTINE_VIEW) {
    return routineRow(id, 'created', {}, { routine });
  }

  function choiceNames(panel) {
    return panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  }

  test('a held run is settled in its Routine\'s panel, through the card Team opened, with exact fresh tags', { tag: '@slow' }, async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const held = 'b'.repeat(32);
    const paused = 'c'.repeat(32);
    const audit = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name: 'Weekly DNS audit' };
    await routeReadyChat(page, {
      history: {
        entries: [
          routineRow(held, 'held', {}, { version: 2 }),
          routineRow(paused, 'paused', { reason: 'exhausted' }, { routine: audit, version: 2 }),
        ],
        before: null,
      },
    });
    let routines = [{ ...ROUTINE_VIEW, state: 'paused' }, { ...audit, state: 'paused' }];
    let incidents = [heldIncident(held), heldIncident(paused, audit)];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines, runs: [], incidents }) : undefined));
    const opened = [];
    const answers = [];
    await routeRead(page, 'routines.card', ({ run_id: runId }) => {
      opened.push(runId);
      // Team's card names its current step, which the transcript row may not show yet.
      const action = runId === held ? 'create-dns-record' : 'replace-dns-record';
      return ok(recoveryCard(runId, { tag: String(opened.length).repeat(64), action }));
    });
    // The paused run's first answer finds its card stale; everything else settles its run and lifts its Routine's pause.
    await routeRead(page, 'routines.card_answer', ({ run_id: runId, body: answer }) => {
      answers.push(answer);
      if (runId === paused && answers.length === 2) return ok({ code: 'routine-card-stale' }, 409);
      const settled = incidents.find((item) => item.run_id === runId);
      incidents = incidents.filter((item) => item !== settled);
      routines = routines.map((routine) => (routine.routine_id === settled.routine_id ? { ...routine, state: 'active' } : routine));
      return ok({ team_id: 'marketing', run_id: runId });
    });
    await page.goto('/chat/?team=marketing');
    // The chat shows no run; the Team's Routines button says a Routine needs the person, and opening one is the card.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    expect(opened).toEqual([]);
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing: one needs your attention' })).toBeVisible();
    const panel = await openRoutinePanel(page);
    // The panel shows exactly the card's two choices, one action each, in Team's order, before any answer: the whole
    // panel is the decision, with where the run stopped, and none of its pages.
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Delete']);
    expect(answers).toEqual([]);
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await expect(panel).toContainText('step 2 of 3');
    expect(await accessibilityViolations(page)).toEqual([]);
    // The step shown is the card's, with its likely cause, the error it returned as plain text, and what running it
    // again may repeat, before the person chooses.
    await expect(panel).toContainText('Create DNS record');
    await expect(panel).toContainText(messages.en.routine.card.causeTitles.credits);
    await expect(panel).toContainText(messages.en.routine.card.runHint);
    await panel.getByText('See the technical error').click();
    await expect(panel.locator('.error-text')).toHaveText(CREDITS_MESSAGE);
    await panel.getByRole('button', { name: 'Run' }).click();
    await expect(panel.getByRole('status')).toContainText('Set aside. The Routine runs again now.');
    await expect(panel.getByRole('group', { name: 'Recovery choices' })).toHaveCount(0);
    // Once settled, the panel returns to its pages, on its Summary, which takes focus.
    await expect(panel.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    // A stale card says so and changes nothing; the next answer uses a freshly opened card.
    const auditPanel = await openRoutinePanel(page, audit.name);
    await expect.poll(() => choiceNames(auditPanel)).toEqual(['Run', 'Delete']);
    await auditPanel.getByRole('button', { name: 'Run' }).click();
    await expect(auditPanel.getByRole('status')).toHaveText(messages.en.routine.errors.cardChanged);
    await expect.poll(() => choiceNames(auditPanel)).toEqual(['Run', 'Delete']);
    // The freshly opened card takes focus from the answer it replaced.
    await expect(auditPanel.getByRole('button', { name: 'Run' })).toBeFocused();
    await auditPanel.getByRole('button', { name: 'Run' }).click();
    await expect(auditPanel.getByRole('status')).toContainText('Set aside. The Routine runs again now.');
    await expect(auditPanel.getByRole('group', { name: 'Recovery choices' })).toHaveCount(0);
    expect(new Set(opened)).toEqual(new Set([held, paused]));
    // Every answer carries exactly the tag of a card the panel had shown, never one opened after the click.
    const tags = opened.map((_id, index) => String(index + 1).repeat(64));
    expect(answers.map((answer) => Object.keys(answer))).toEqual([['tag'], ['tag'], ['tag']]);
    for (const answer of answers) expect(tags).toContain(answer.tag);
    const pausedTags = opened.flatMap((id, index) => (id === paused ? [String(index + 1).repeat(64)] : []));
    expect(answers.slice(1).map((answer) => answer.tag)).toEqual(pausedTags.slice(0, 2));
  });

  test("a card's error is literal text, and a shortened one says it was shortened", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const held = 'b'.repeat(32);
    const message = '<img src=x onerror=alert(1)> Insufficient account credits';
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(held, 'held', {}, { version: 2 })],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [{ ...ROUTINE_VIEW, state: 'paused' }], runs: [], incidents: [heldIncident(held)] }) : undefined));
    await routeRead(page, 'routines.card', () => ok(recoveryCard(held, { failure: { message, truncated: true } })));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByText('See the technical error').click();
    await expect(panel.locator('.error-text')).toHaveText(message);
    await expect(panel.locator('.error-text img')).toHaveCount(0);
    await expect(panel).toContainText('shortened');
  });

  test("a run's execution details are read for that run in its Routine's panel and shown only as text", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const failed = 'c'.repeat(32);
    await routeReadyChat(page, {
      history: { entries: [routineRow(failed, 'failed', { code: 'assistant-rpc-failed' })], before: null },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    const requested = [];
    const attempt = (number, failure, condition = null) => diagnostic({ attempt: number, failure, condition });
    let answer = {
      team_id: 'marketing',
      run_id: failed,
      diagnostics: [
        attempt(1, httpFailure({
          message: '<img src=x onerror="window.leaked=1"> **not markdown**',
          http_status: 404,
          response_excerpt: '{"success":false}',
        })),
        attempt(2, null, 'exit-status:1'),
      ],
    };
    await routeRead(page, 'routines.diagnostics', ({ run_id: runId }) => {
      requested.push(runId);
      return ok(answer);
    });
    await page.goto('/chat/?team=marketing');
    // The run never reaches the transcript; its details are in its Routine's panel.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runDetails = panel.getByRole('button', { name: 'Execution details' });
    await runDetails.click();
    const dialog = page.getByRole('dialog', { name: 'Execution details' });
    await expect(dialog).toContainText('<img src=x onerror="window.leaked=1"> **not markdown**');
    await expect(dialog).toContainText('The Action exited with status 1.');
    await expect(dialog.locator('img, strong')).toHaveCount(0);
    expect(await page.evaluate(() => window.leaked)).toBeUndefined();
    await expect.poll(() => requested).toEqual([failed]);
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    // Details that name another run are refused, never shown.
    answer = { ...answer, run_id: 'd'.repeat(32) };
    await runDetails.click();
    await expect(dialog).toContainText('The Routine request failed. Try again.');
    await expect(dialog).not.toContainText('httpx.HTTPStatusError');
  });

  test("a repeated Action's failed attempts at three positions read apart in the panel's execution details", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const failed = 'c'.repeat(32);
    await routeReadyChat(page, {
      history: { entries: [routineRow(failed, 'failed', { code: 'assistant-rpc-failed' })], before: null },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    // The same Action's first attempt failed at steps 2, 5, and 7: one operation per position.
    const attempt = (operation, position) => diagnostic({
      operation_id: `6f1c2b8e-3a4d-4c5e-9f60-${operation}`,
      action: 'list-dns-records',
      position,
      condition: 'timeout',
    });
    await routeRead(page, 'routines.diagnostics', () => ok({ team_id: 'marketing', run_id: failed, diagnostics: [
      attempt('718293a4b5c6', 2),
      attempt('718293a4b5c7', 5),
      attempt('718293a4b5c8', 7),
    ] }));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('button', { name: 'Execution details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Execution details' });
    const attempts = dialog.locator('.attempts > li');
    await expect(attempts).toHaveCount(3);
    // Each attempt names its own position, so all three read apart.
    const headings = await attempts.locator('.heading').allTextContents();
    expect(new Set(headings).size).toBe(3);
    expect(headings[0]).toContain('2');
    expect(headings[1]).toContain('5');
    expect(headings[2]).toContain('7');
  });

  // The footer of a Routine's history, which reveals its next runs ten at a time.
  const moreRuns = (panel) => panel.getByRole('button', { name: /^Show \d+ more runs?$/u });

  // Reveals a Routine's whole history, one press at a time, each once the runs it reads are listed.
  async function revealEveryRun(panel, listed) {
    const more = moreRuns(panel);
    const loading = panel.getByText(messages.en.routine.list.loading, { exact: true });
    for (;;) {
      await expect(loading).toHaveCount(0);
      if (!(await more.count())) return;
      const shown = (await listed()).length;
      await more.click();
      await expect.poll(async () => (await listed()).length).toBeGreaterThan(shown);
    }
  }

  test("a Routine's panel reads its own history, never the chat's, however much the chat holds", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const done = { plan: ROUTINE_VIEW.plan, output: null };
    const chat = Array.from({ length: 64 }, (_, index) => ({
      id: `${index.toString(16).padStart(32, '0')}:user`,
      created_at: '2026-10-02T09:00:00Z',
      kind: 'message',
      role: 'user',
      text: `Unrelated message ${index + 1}`,
    }));
    const chatHistory = await routeReadyChat(page, {
      history: {
        entries: [
          routineRow('c'.repeat(32), 'failed', { code: 'assistant-rpc-failed' }),
          routineRow('d'.repeat(32), 'done', done),
          ...chat,
        ],
        before: null,
      },
    });
    const views = async () => (await readsOf(page, 'history.page')).map((params) => params.routine ?? null);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    await expect(page.getByText('Unrelated message 64', { exact: true })).toBeVisible();
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    // Both runs sit behind the newest chat; the panel's own view of the history holds just them, newest first.
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(2);
    await expect(runs.getByRole('listitem').first()).toContainText('Done');
    await expect(moreRuns(panel)).toHaveCount(0);
    await expect.poll(views).toContain(ROUTINE_VIEW.routine_id);
    expect((await views()).every((routine) => routine === null || routine === ROUTINE_VIEW.routine_id)).toBe(true);
    expect(chatHistory.historyRequests().every((before) => before === null)).toBe(true);
  });

  test("a Routine's runs are revealed ten at a time, its older runs read as the list reaches them, and a run that ends joins them", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const done = { plan: ROUTINE_VIEW.plan, output: null };
    const run = (index) => routineRow((index + 1).toString(16).padStart(32, '0'), 'done', done);
    const searched = [];
    // A run that ends while the panel is open is written after the newest run.
    let delivered = null;
    await routeReadyChat(page);
    // The Routine's own history: a full newest page of its runs, then its one older run.
    await routeRead(page, 'history.page', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      const params = new URLSearchParams(Object.entries(read).filter(([key]) => key !== 'team_id'));
      const routine = params.get('routine');
      if (routine === null) return ok({ entries: [], before: null });
      searched.push(params.get('before'));
      const newest = Array.from({ length: 64 }, (_, index) => run(index + 1));
      return ok(params.get('before') === null
          ? { entries: delivered ? [...newest.slice(1), delivered] : newest, before: 'AAAAAAAAAMg' }
          : { entries: [run(0)], before: null });
    });
    let routineReads = 0;
    let running = [{
      run_id: 'e'.repeat(32),
      routine_id: ROUTINE_VIEW.routine_id,
      status: 'leased',
      request_kind: null,
      assistant_id: null,
      action: null,
    }];
    await routeRead(page, 'routines.list', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      routineReads += 1;
      return ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: running, incidents: [] });
    });
    await page.clock.install();
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    const details = runs.getByRole('button', { name: 'Execution details' });
    const more = moreRuns(panel);
    const older = () => searched.filter((cursor) => cursor !== null);
    // The newest page holds 64 runs; ten show, and the footer says how many one press reveals.
    await expect(details).toHaveCount(10);
    await expect(more).toHaveText('Show 10 more runs');
    await expect(runs).toContainText('Running now');
    // The running run ends while the panel stays open: the next refresh lists it at the top, reading only the newest
    // page, and the list keeps its place.
    delivered = routineRow('e'.repeat(32), 'done', done);
    running = [];
    await routineNotice(page);
    await expect(runs).not.toContainText('Running now');
    await expect(runs.getByRole('listitem').first()).toContainText('Done');
    await expect(runs.getByRole('listitem').first().getByRole('button', { name: 'Execution details' })).toBeVisible();
    await expect(details).toHaveCount(10);
    expect(older()).toEqual([]);
    // Each press reveals ten more, and moves focus to the first run it revealed; the older page is read only once the
    // list comes within a page of its end.
    await more.click();
    await expect(details).toHaveCount(20);
    await expect(runs.getByRole('listitem').nth(10)).toBeFocused();
    expect(older()).toEqual([]);
    await revealEveryRun(panel, () => details.all());
    await expect(details).toHaveCount(66);
    expect(older()).toEqual(['AAAAAAAAAMg']);
    // The chat's periodic refresh replaces the Routine's details; the runs found so far stay.
    const reads = routineReads;
    await routineNotice(page);
    await expect.poll(() => routineReads).toBeGreaterThan(reads);
    await expect(details).toHaveCount(66);
    await expect(more).toHaveCount(0);
    expect(older()).toEqual(['AAAAAAAAAMg']);
  });

  test("a Routine's panel that stays open lists every run that ends, and every older run stays reachable", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const done = { plan: ROUTINE_VIEW.plan, output: null };
    const failed = { code: 'assistant-rpc-failed' };
    // The Routine's stored history, oldest first; a row's position is its place in it, as Admin's cursor names it.
    const stored = [];
    // Each run ends a second after the one before, so a listed run is known by its time.
    const write = (count, detail = done) => {
      for (let index = 0; index < count; index += 1) {
        const position = stored.length + 1;
        const row = routineRow(position.toString(16).padStart(32, '0'), detail === done ? 'done' : 'failed', detail);
        stored.push({ ...row, created_at: new Date(Date.UTC(2026, 9, 1, 12) + position * 1000).toISOString().replace('.000Z', 'Z') });
      }
    };
    const everyRun = () => stored.map((row) => row.created_at).reverse();
    const cursor = (position) => {
      const raw = Buffer.alloc(8);
      raw.writeBigUInt64BE(BigInt(position));
      return raw.toString('base64url');
    };
    const position = (value) => Number(Buffer.from(value, 'base64url').readBigUInt64BE());
    await routeReadyChat(page);
    // One newest-first page of at most 64 rows before the cursor, oldest first, as Admin pages the Routine's view.
    await routeRead(page, 'history.page', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      const params = new URLSearchParams(Object.entries(read).filter(([key]) => key !== 'team_id'));
      if (params.get('routine') === null) return ok({ entries: [], before: null });
      const below = params.get('before') === null ? stored.length + 1 : position(params.get('before'));
      const start = Math.max(0, below - 1 - 64);
      const entries = stored.slice(start, below - 1);
      return ok({ entries, before: start > 0 ? cursor(start + 1) : null });
    });
    let routineReads = 0;
    await routeRead(page, 'routines.list', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      routineReads += 1;
      return ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] });
    });
    write(5);
    await page.clock.install();
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    const listed = () => runs.locator('time').evaluateAll((times) => times.map((time) => time.getAttribute('datetime')));
    await expect.poll(listed).toEqual(everyRun());
    const refresh = async () => {
      const reads = routineReads;
      await routineNotice(page);
      await expect.poll(() => routineReads).toBeGreaterThan(reads);
    };
    // Every run that ends while the panel is open joins the top; none listed before is dropped.
    for (let round = 0; round < 3; round += 1) {
      write(1);
      write(1, failed);
      await refresh();
      await expect(runs.getByRole('listitem').first()).toContainText('assistant-rpc-failed');
      await revealEveryRun(panel, listed);
      await expect.poll(listed).toEqual(everyRun());
    }
    // More end than the list takes, then more than one refresh reads: each time the list starts again from the newest
    // page, and continuing it reaches every run, none skipped.
    for (const count of [65, 520]) {
      write(count);
      await refresh();
      await expect.poll(listed).toEqual(everyRun().slice(0, 10));
      await revealEveryRun(panel, listed);
      await expect.poll(listed).toEqual(everyRun());
    }
  });

  test("an older read that a newer reading of the panel's history overtook never hides that reading", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const done = { plan: ROUTINE_VIEW.plan, output: null };
    const stored = [];
    const write = (count) => {
      for (let index = 0; index < count; index += 1) {
        const position = stored.length + 1;
        const row = routineRow(position.toString(16).padStart(32, '0'), 'done', done);
        stored.push({ ...row, created_at: new Date(Date.UTC(2026, 9, 1, 12) + position * 1000).toISOString().replace('.000Z', 'Z') });
      }
    };
    const everyRun = () => stored.map((row) => row.created_at).reverse();
    const cursor = (position) => {
      const raw = Buffer.alloc(8);
      raw.writeBigUInt64BE(BigInt(position));
      return raw.toString('base64url');
    };
    const position = (value) => Number(Buffer.from(value, 'base64url').readBigUInt64BE());
    // The test holds the newest-page reading a refresh starts again from, and fails the older read the list makes as
    // the person reveals its runs, while holding it: a read that continues from a cursor the list was given before the
    // refresh, never one the refresh itself reads on with.
    let holdNewest = null;
    let newestReads = 0;
    let olderReads = 0;
    let holdOlder = null;
    const given = new Set();
    await routeReadyChat(page);
    await routeRead(page, 'history.page', async (read) => {
      if (read.team_id !== 'marketing') return undefined;
      const params = new URLSearchParams(Object.entries(read).filter(([key]) => key !== 'team_id'));
      if (params.get('routine') === null) return ok({ entries: [], before: null });
      const reading = params.get('before') === null ? ++newestReads : 0;
      if (reading && holdNewest && reading === holdNewest.at) await holdNewest.released;
      if (!reading && holdOlder?.cursors.has(params.get('before'))) {
        olderReads += 1;
        await holdOlder.released;
        return ok({ detail: 'Synthetic history failure.' }, 503);
      }
      const below = reading ? stored.length + 1 : position(params.get('before'));
      const start = Math.max(0, below - 1 - 64);
      const before = start > 0 ? cursor(start + 1) : null;
      given.add(before);
      return ok({ entries: stored.slice(start, below - 1), before });
    });
    let routineReads = 0;
    await routeRead(page, 'routines.list', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      routineReads += 1;
      return ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] });
    });
    const gate = () => {
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      return { released, release };
    };
    write(200);
    await page.clock.install();
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    const more = moreRuns(panel);
    const unavailable = panel.getByText(messages.en.routine.panel.runsUnavailable, { exact: true });
    const listed = () => runs.locator('time').evaluateAll((times) => times.map((time) => time.getAttribute('datetime')));
    await expect.poll(listed).toEqual(everyRun().slice(0, 10));
    // Each press reveals ten more; the one that comes within a page of what was read makes the list read older runs.
    const revealUntilOlderRead = async () => {
      const reads = olderReads;
      while (olderReads === reads) {
        await more.click();
        await expect.poll(async () => olderReads > reads || await more.isVisible()).toBe(true);
      }
    };
    for (const order of ['newest first', 'older first']) {
      // More runs end than the list takes, so the next refresh reads the newest page again; it is held, and meanwhile
      // the person reveals more runs, whose older read fails.
      write(65);
      const newest = gate();
      const search = gate();
      holdNewest = { at: newestReads + 2, released: newest.released };
      holdOlder = { cursors: new Set(given), released: search.released };
      const reads = routineReads;
      await routineNotice(page);
      await expect.poll(() => routineReads).toBeGreaterThan(reads);
      await expect.poll(() => newestReads).toBe(holdNewest.at);
      await revealUntilOlderRead();
      if (order === 'newest first') {
        newest.release();
        await expect.poll(listed).toEqual(everyRun().slice(0, 10));
        search.release();
      } else {
        search.release();
        await expect(unavailable).toBeVisible();
        newest.release();
      }
      // Either way the newer reading stands, and its cursor still reaches every older run.
      await expect.poll(listed).toEqual(everyRun().slice(0, 10));
      await expect(unavailable).toHaveCount(0);
      holdNewest = null;
      holdOlder = null;
      await expect(more).toBeEnabled();
    }
    await revealEveryRun(panel, listed);
    await expect.poll(listed).toEqual(everyRun());
  });

  test("a continuous Routine's healthy minutes are its runs, each with its count and no execution details", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the Team drawer on a phone is proven by the Team list journeys kept on the phone projects');
    const continuous = { ...ROUTINE_VIEW, schedule: { kind: 'continuous', gap: 5 } };
    const rollup = (id, runs) => routineRow(id, 'healthy', { runs }, { routine: continuous });
    await routeReadyChat(page, { history: { entries: [rollup('c'.repeat(32), 12), rollup('d'.repeat(32), 1)], before: null } });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [continuous], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page, continuous.name);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    // Newest first, each minute with how many runs it finished; a rollup is no single run with details to open.
    await expect(runs.getByRole('listitem').nth(0)).toContainText('1 run finished');
    await expect(runs.getByRole('listitem').nth(1)).toContainText('12 runs finished');
    await expect(runs).not.toContainText('No runs yet.');
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(0);
  });

  test("a Routine's history gives each run its outcome, usage, and time, and opens the result it showed", { tag: '@mobile' }, async ({ page }) => {
    const text = (value) => ({ kind: 'text', value, cut: false });
    const shown = { step: 1, state: 'shown', value: { kind: 'fields', fields: [['zone', text('example.com')]], omitted: 0 }, truncated: false };
    const missed = routineRow('a'.repeat(32), 'skipped', { missed: 2 }, { at: '2026-10-01T11:00:00Z' });
    const lost = routineRow('c'.repeat(32), 'failed', { code: 'assistant-rpc-failed' }, { at: '2026-10-01T11:30:00Z', lost: true });
    const done = routineRow('d'.repeat(32), 'done', { plan: ROUTINE_VIEW.plan, output: shown }, {
      at: '2026-10-01T12:01:07Z',
      usage: { duration_ms: 7400 },
    });
    // A run paused for a safety rule, and the pause its Routine's consecutive failed runs caused, which is no run.
    const paused = routineRow('e'.repeat(32), 'paused', { reason: 'policy' }, { at: '2026-10-01T11:10:00Z' });
    const streak = routineRow('f'.repeat(32), 'streak-paused', { failures: 3 }, { at: '2026-10-01T11:20:00Z' });
    await routeReadyChat(page, { history: { entries: [missed, paused, streak, lost, done], before: null } });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const rows = panel.getByRole('list', { name: 'Runs' }).getByRole('listitem');
    await expect(rows).toHaveCount(5);
    // Newest first, each with its own time, also on a phone.
    for (const [index, row] of [done, lost, streak, paused, missed].entries()) {
      await expect(rows.nth(index).locator(`time[datetime="${row.created_at}"]`)).toBeVisible();
    }
    // The completed run: its outcome opens it, with its usage.
    await expect(rows.nth(0)).toContainText('7.4 s');
    // The failed run says its results are hidden to protect secret values; the missed runs say how many and open nothing.
    await expect(rows.nth(1)).toContainText(messages.en.routine.notice.protectionLost);
    // The streak's pause says how many failed runs caused it and opens nothing; a paused run says why it paused.
    await expect(rows.nth(2)).toContainText(messages.en.routine.panel.streakPaused.other.replace('{count}', '3'));
    await expect(rows.nth(2).getByRole('button')).toHaveCount(0);
    const run = messages.en.routine.run;
    await expect(rows.nth(3)).toContainText(run.paused.replace('{reason}', run.pauseReasons.policy));
    await expect(rows.nth(4)).toContainText('2 runs missed');
    await expect(rows.nth(4).getByRole('button')).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);

    const outcome = rows.nth(0).getByRole('button', { name: 'Done', exact: true });
    await expect(outcome).toHaveAttribute('aria-haspopup', 'dialog');
    await outcome.click();
    const view = page.getByRole('dialog', { name: ROUTINE_VIEW.name }).last();
    await expect(view.getByRole('heading', { name: messages.en.routine.result.response })).toBeVisible();
    await expect(view).toContainText('example.com');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: messages.en.routine.result.response })).toHaveCount(0);
    await expect(outcome).toBeFocused();
  });

  test('a Routine paused after its failures resumes from its panel, never past a held run its own panel decides', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const failed = 'c'.repeat(32);
    const held = 'f'.repeat(32);
    const heldRoutine = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name: 'Weekly DNS audit', state: 'paused' };
    await routeReadyChat(page, {
      history: {
        entries: [
          routineRow(failed, 'failed', { code: 'assistant-rpc-failed' }),
          routineRow(held, 'paused', {
            reason: 'exhausted',
          }, { routine: heldRoutine }),
        ],
        before: null,
      },
    });
    let routines = [{ ...ROUTINE_VIEW, state: 'paused' }, heldRoutine];
    const incidents = [heldIncident(held, heldRoutine)];
    const resumed = [];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines, runs: [], incidents }) : undefined));
    await routeRead(page, 'routines.resume', ({ routine_id: routineId }) => {
      resumed.push(routineId);
      routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, state: 'active' } : routine));
      return ok({ team_id: 'marketing', routine_id: routineId, paused: false });
    });
    await routeRead(page, 'routines.card', () => ok(recoveryCard(held, { tag: '1'.repeat(64) })));
    await page.goto('/chat/?team=marketing');
    // No run reaches the chat, so nothing there resumes a Routine.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    // A Routine an unresolved incident still holds offers no Resume: its panel is the recovery decision alone.
    const heldPanel = await openRoutinePanel(page, heldRoutine.name);
    await expect.poll(() => choiceNames(heldPanel)).toEqual(['Run', 'Delete']);
    await expect(heldPanel.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await heldPanel.getByRole('button', { name: 'Close' }).click();
    await expect(heldPanel).toHaveCount(0);

    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(resumed).toEqual([ROUTINE_VIEW.routine_id]);
  });

  test('a Routine change whose answer was lost says its outcome is unknown and is never sent again', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [{ ...ROUTINE_VIEW, state: 'paused' }], runs: [], incidents: [] }) : undefined));
    // Admin receives the resume over the session socket, and the connection drops before its answer arrives.
    await routeRead(page, 'routines.resume', () => new Promise(() => {}));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    const resume = panel.getByRole('button', { name: 'Resume' });
    await resume.click();
    await waitForRead(page, 'routines.resume');
    await dropSessions(page);
    await expect(panel.getByText(messages.en.shell.outcomeUnknown)).toBeVisible();
    // Once Admin is back the change is offered again; nothing sent it a second time.
    await expect(resume).toBeEnabled({ timeout: 20_000 });
    expect(await readsOf(page, 'routines.resume')).toHaveLength(1);
  });

  test("a held run's approval stays disabled while Admin reconnects and is offered again once it is back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'd'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(run, 'frozen', {
          request_kind: 'human',
        })],
        before: null,
      },
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [frozenRun(run, 'human')], incidents: [] }) : undefined));
    await routeRead(page, 'routines.challenge', () => ok(routineChallenge(run, localizedChallenge(humanRequest('approval')))));
    // While refusing, Admin is unreachable: each socket the page opens fails before it is upgraded.
    let refusing = false;
    await routeConnect(page, (socket) => {
      if (!refusing) return true;
      socket.connectToServer();
      return false;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Review' }).click();
    const approve = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' }).getByRole('button', { name: 'Approve action' });
    await expect(approve).toBeEnabled();
    refusing = true;
    await dropSessions(page);
    await expect(approve).toBeDisabled();
    refusing = false;
    await expect(approve).toBeEnabled({ timeout: 20_000 });
    expect(await readsOf(page, 'routines.human')).toEqual([]);
  });

  test("a Routine panel's focus that a reconnect dropped returns to the panel once Admin is back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'd'.repeat(32);
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [frozenRun(run, 'human')], incidents: [] }) : undefined));
    // While refusing, Admin is unreachable: each socket the page opens fails before it is upgraded.
    let refusing = false;
    await routeConnect(page, (socket) => {
      if (!refusing) return true;
      socket.connectToServer();
      return false;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    const review = panel.getByRole('button', { name: 'Review' });
    await review.focus();
    // Reconnecting disables Review, which loses the focus; it comes back once Review is offered again.
    refusing = true;
    await dropSessions(page);
    await expect(review).toBeDisabled();
    refusing = false;
    await expect(review).toBeEnabled({ timeout: 20_000 });
    await expect(review).toBeFocused();
  });

  test("a Routine panel's Pause that a reconnect disabled takes back the focus once Admin is back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    // While refusing, Admin is unreachable: each socket the page opens fails before it is upgraded.
    let refusing = false;
    await routeConnect(page, (socket) => {
      if (!refusing) return true;
      socket.connectToServer();
      return false;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    const pause = panel.getByRole('button', { name: 'Pause' });
    await pause.focus();
    refusing = true;
    await dropSessions(page);
    await expect(pause).toBeDisabled();
    refusing = false;
    await expect(pause).toBeEnabled({ timeout: 20_000 });
    await expect(pause).toBeFocused();
    expect(await readsOf(page, 'routines.pause')).toEqual([]);
  });

  test("a deletion confirmation's Delete that a reconnect disabled takes back the focus once Admin is back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    // While refusing, Admin is unreachable: each socket the page opens fails before it is upgraded.
    let refusing = false;
    await routeConnect(page, (socket) => {
      if (!refusing) return true;
      socket.connectToServer();
      return false;
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete “${ROUTINE_VIEW.name}”?` });
    await confirm.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await confirm.getByLabel('Six-digit code').fill('123456');
    const remove = confirm.getByRole('button', { name: 'Delete' });
    await remove.focus();
    refusing = true;
    await dropSessions(page);
    await expect(remove).toBeDisabled();
    refusing = false;
    await expect(remove).toBeEnabled({ timeout: 20_000 });
    await expect(remove).toBeFocused();
    expect(await readsOf(page, 'routines.deletion')).toEqual([]);
  });

  test("a frozen run lights its Team's Routines button and is approved in its Routine's panel, with the chat approval dialog", { tag: '@mobile' }, async ({ page }) => {
    const run = 'd'.repeat(32);
    const waiting = 'e'.repeat(32);
    const audit = { ...ROUTINE_VIEW, routine_id: 'c'.repeat(32), name: 'Weekly DNS audit' };
    const frozenRow = (id, requestKind, routine) => routineRow(id, 'frozen', {
      request_kind: requestKind,
    }, { routine });
    await routeReadyChat(page, {
      history: { entries: [frozenRow(waiting, 'integrations', audit), frozenRow(run, 'human', ROUTINE_VIEW)], before: null },
    });
    let runs = [frozenRun(waiting, 'integrations', audit), frozenRun(run, 'human')];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW, audit], runs, incidents: [] }) : undefined));
    const answers = [];
    const resumes = [];
    const openings = [];
    await routeRead(page, 'routines.challenge', ({ run_id: runId, body }) => {
      openings.push(body);
      return ok(runId === run
        ? routineChallenge(run, localizedChallenge(humanRequest('approval')))
        : { team_id: 'marketing', run_id: runId, status: 'integrations-required' });
    });
    await routeRead(page, 'routines.human', ({ run_id: runId, body }) => {
      if (runId !== run) return undefined;
      answers.push(body);
      // The first approval resumes a run that freezes again for its next approval; the second completes it.
      const status = answers.length === 1 ? 'frozen' : 'done';
      if (status === 'done') runs = runs.filter((item) => item.run_id !== run);
      return ok({ team_id: 'marketing', run_id: run, status });
    });
    await routeRead(page, 'routines.integrations', ({ run_id: runId }) => {
      resumes.push(runId);
      return ok({ team_id: 'marketing', run_id: waiting, status: 'frozen' });
    });
    await page.goto('/chat/?team=marketing');
    // No run reaches the chat: a run waiting for the person's approval or connection is found from the Team's
    // Routines button, which says a Routine needs them although no Routine is paused or held.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing: one needs your attention' })).toBeVisible();
    expect(openings).toEqual([]);

    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
    await expect(dialog).toBeVisible();
    // Dismissing answers nothing: the run stays frozen and can be reviewed again, with focus back on Review.
    const review = panel.getByRole('button', { name: 'Review' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(review).toBeFocused();
    await review.click();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
    await expect(review).toBeFocused();
    expect(answers).toEqual([]);
    const approval = { type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true };
    await panel.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toHaveText('The run continued: waiting for another answer');
    await expect(review).toBeFocused();
    await panel.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toContainText('The run continued: Done');
    await expect(panel.getByRole('button', { name: 'Review' })).toHaveCount(0);
    await expect.poll(() => answers).toEqual([approval, approval]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    const auditPanel = await openRoutinePanel(page, audit.name);
    await auditPanel.getByRole('button', { name: 'Review' }).click();
    await expect(auditPanel).toContainText('Connect Shimpz Cloudflare from the Team\'s Store, then continue the run.');
    expect(resumes).toEqual([]);
    await auditPanel.getByRole('button', { name: 'Continue the run' }).click();
    await expect(auditPanel.getByRole('status')).toHaveText('The run continued: waiting for another answer');
    await expect(auditPanel.getByRole('button', { name: 'Review' })).toBeFocused();
    expect(resumes).toEqual([waiting]);
    // Every opening names the interface language the request copy is rendered in (ADR-0091).
    expect(openings).toEqual(Array(5).fill({ locale: 'en' }));
  });

  test("a run frozen at a Supervisor password is found from the Routines button and authorized in its panel", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'd'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(run, 'frozen', {
          request_kind: 'human',
        })],
        before: null,
      },
    });
    let runs = [frozenRun(run, 'human')];
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents: [] }) : undefined));
    await routeRead(page, 'routines.challenge', () => ok(routineChallenge(run, localizedChallenge(humanRequest('auth:password')))));
    // The first two passwords are refused and keep the challenge open; the third authorizes the run, which completes.
    const answered = [];
    await routeRead(page, 'routines.human', ({ run_id: runId, body }) => {
      answered.push([runId, body]);
      if (answered.length <= 2) {
        const rejection = { type: 'human-response-rejected', challenge_id: 'b'.repeat(32), reason: 'authentication-denied', attempts_remaining: 2, retry_after: 0 };
        return ok({ code: 'authentication-denied', ...rejection }, 409);
      }
      runs = [];
      return ok({ team_id: 'marketing', run_id: run, status: 'done' });
    });
    await page.goto('/chat/?team=marketing');
    // The chat shows no run; the Routines button says one needs the person.
    await expect(page.locator('.routine-run')).toHaveCount(0);
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing: one needs your attention' })).toBeVisible();
    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
    const password = dialog.getByLabel('Supervisor password');
    await expect(password).toHaveAttribute('type', 'password');
    expect(await accessibilityViolations(page)).toEqual([]);
    // A wrong password settles nothing: the run still waits. Leaving the refusal answers nothing either, and the next
    // review asks for the password again instead of repeating the refusal.
    await password.fill('wrong-password');
    await dialog.getByRole('button', { name: 'Confirm authorization' }).click();
    await expect.poll(() => answered.length).toBe(1);
    const validation = page.getByRole('dialog', { name: 'Supervisor password not confirmed' });
    await validation.getByRole('button', { name: 'Not now' }).click();
    await expect(validation).toBeHidden();
    const review = panel.getByRole('button', { name: 'Review' });
    await expect(review).toBeFocused();
    await review.click();
    await expect(password).toBeVisible();
    // Another wrong password is refused again, and the person tries again in the same request.
    await password.fill('wrong-password');
    await dialog.getByRole('button', { name: 'Confirm authorization' }).click();
    await expect.poll(() => answered.length).toBe(2);
    await validation.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByRole('status')).toHaveCount(0);
    await password.fill('supervisor-password');
    await dialog.getByRole('button', { name: 'Confirm authorization' }).click();
    await expect(panel.getByRole('status')).toContainText('The run continued: Done');
    // Every answer went to exactly this run, each with the one challenge it opened.
    expect(answered.map(([runId, frame]) => [runId, frame.challenge_id, frame.decision])).toEqual([
      [run, 'b'.repeat(32), 'submit'],
      [run, 'b'.repeat(32), 'submit'],
      [run, 'b'.repeat(32), 'submit'],
    ]);
  });

  test("a password refusal that arrives after its request expired leaves focus on Review, and the next review asks again", async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    await freezeClock(page, new Date('2026-10-01T12:00:00Z'));
    const run = 'd'.repeat(32);
    await routeReadyChat(page);
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [frozenRun(run, 'human')], incidents: [] }) : undefined));
    // Each opening is a fresh challenge; the first expires in three seconds.
    let openings = 0;
    await routeRead(page, 'routines.challenge', () => {
      openings += 1;
      return ok(routineChallenge(run, localizedChallenge(humanRequest('auth:password')), {
        challengeId: (openings === 1 ? 'b' : 'c').repeat(32),
        expiresIn: openings === 1 ? 3 : 300,
      }));
    });
    // The refusal of the first password arrives only after its request expired.
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    let answers = 0;
    await routeRead(page, 'routines.human', async ({ body }) => {
      answers += 1;
      await late;
      return ok({ code: 'authentication-denied', type: 'human-response-rejected', challenge_id: body.challenge_id, reason: 'authentication-denied', attempts_remaining: 2, retry_after: 0 }, 409);
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    const review = panel.getByRole('button', { name: 'Review' });
    await review.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
    await dialog.getByLabel('Supervisor password').fill('wrong-password');
    await dialog.getByRole('button', { name: 'Confirm authorization' }).click();
    await expect.poll(() => answers).toBe(1);
    await page.clock.fastForward(3_000);
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole('status')).toHaveText(messages.en.routine.errors.expired);
    release();
    await expect(review).toBeEnabled();
    await expect(review).toBeFocused();
    await review.click();
    await expect(dialog.getByLabel('Supervisor password')).toBeVisible();
    expect(openings).toBe(2);
  });

  test('Review of a run another window already resumed reads the Routines again and the panel keeps the focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'd'.repeat(32);
    await routeReadyChat(page);
    let runs = [frozenRun(run, 'human')];
    let reads = 0;
    await routeRead(page, 'routines.list', (params) => {
      if (params.team_id !== 'marketing') return undefined;
      reads += 1;
      return ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents: [] });
    });
    // Another window answered the run's request first, so it no longer waits for one.
    await routeRead(page, 'routines.challenge', () => {
      runs = [];
      return ok({ code: 'routine-run-not-frozen' }, 409);
    });
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    const before = reads;
    await panel.getByRole('button', { name: 'Review' }).click();
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(panel.getByRole('button', { name: 'Review' })).toHaveCount(0);
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
  });

  test('Continue on an Integration wait another window already continued reads the Routines again and the panel keeps the focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.use.hasTouch, 'the drawer path to a Routine panel on a phone is proven by the panel journeys kept on the phone projects');
    const run = 'd'.repeat(32);
    await routeReadyChat(page);
    let runs = [frozenRun(run, 'integrations')];
    let reads = 0;
    await routeRead(page, 'routines.list', (params) => {
      if (params.team_id !== 'marketing') return undefined;
      reads += 1;
      return ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents: [] });
    });
    await routeRead(page, 'routines.challenge', (params) => ok({ team_id: 'marketing', run_id: params.run_id, status: 'integrations-required' }));
    await page.goto('/chat/?team=marketing');
    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Review' }).click();
    const proceed = panel.getByRole('button', { name: 'Continue the run' });
    await expect(proceed).toBeVisible();
    // Another window connected the Integration and continued the run first: Team no longer holds it frozen.
    await routeRead(page, 'routines.integrations', () => {
      runs = [];
      return ok({ code: 'routine-run-not-frozen' }, 409);
    });
    const before = reads;
    await proceed.click();
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(proceed).toHaveCount(0);
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeFocused();
  });

  test("a Routine's creation delivered after the chat opened appears without a reload, and its runs never do", { tag: '@mobile' }, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    const run = 'd'.repeat(32);
    const earlier = createdRow('c'.repeat(32));
    const frozen = routineRow(run, 'frozen', { request_kind: 'human' });
    let history = { entries: [], before: null };
    let runs = [];
    await routeReadyChat(page, { history });
    // Admin's scheduler writes notices durably on its own; these routes serve whatever it has written so far, in the
    // view each request asks for.
    await routeRead(page, 'history.page', (params) => (params.team_id === 'marketing' ? ok({ ...history, entries: historyView(history.entries, params.routine ?? null) }) : undefined));
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents: [] }) : undefined));
    await routeRead(page, 'routines.challenge', () => ok(routineChallenge(run, localizedChallenge(humanRequest('approval')))));
    const answers = [];
    await routeRead(page, 'routines.human', ({ body }) => {
      answers.push(body);
      return ok({ team_id: 'marketing', run_id: run, status: 'done' });
    });
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    await expect(rows).toHaveCount(0);
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await fillWhenReady(page, composer, 'A draft that must survive');

    // The scheduler delivers the Routine's creation and then a frozen run while the conversation is open: the creation
    // joins the transcript, the run stays out of it, and the draft is kept.
    history = { entries: [earlier, frozen], before: null };
    runs = [frozenRun(run, 'human')];
    await routineNotice(page);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAccessibleName(ROUTINE_VIEW.name);
    await expect(composer).toHaveValue('A draft that must survive');
    // The Team's Routines list shows the run waiting.
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await page.getByRole('menuitem', { name: 'Routines' }).click();
    await expect(page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })).toContainText('Paused');
    await page.keyboard.press('Escape');
    if (page.viewportSize().width <= 820) await page.keyboard.press('Escape');

    const panel = await openRoutinePanel(page);
    await panel.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toContainText('The run continued: Done');
    await expect.poll(() => answers).toEqual([{ type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true }]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    // The run's newer version is the Routine's history too; the transcript and the draft stay as they were.
    const published = { plan: planSummary([{ assistant: 'shimpz-cloudflare', action: 'replace-dns-record' }]), output: null };
    history = { entries: [earlier, { ...frozen, outcome: 'done', detail: published, version: 2 }], before: null };
    runs = [];
    await routineNotice(page);
    await expect(rows).toHaveCount(1);
    await expect(composer).toHaveValue('A draft that must survive');
  });

  test('Routine creations written behind more than one page of newer history while the chat was away still arrive', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    const named = (letter, name) => createdRow(letter.repeat(32), { ...ROUTINE_VIEW, routine_id: letter.repeat(32), name });
    const earlier = named('c', 'Daily DNS zones');
    const gap = named('d', 'Weekly DNS audit');
    const newest = named('e', 'Certificate check');
    const unrelated = (start, count) => Array.from({ length: count }, (_, index) => ({
      id: `${(start + index).toString(16).padStart(32, '0')}:user`,
      created_at: '2026-10-01T12:00:00Z',
      kind: 'message',
      role: 'user',
      text: `Unrelated message ${start + index + 1}`,
    }));
    // Admin's history by cursor: what the chat opened with, then what was written while it was away.
    let pages = { null: { entries: [earlier], before: null } };
    const requested = [];
    await routeReadyChat(page);
    await routeRead(page, 'history.page', (read) => {
      if (read.team_id !== 'marketing') return undefined;
      const before = read.before ?? null;
      requested.push(before);
      return ok(pages[before]);
    });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    await expect(rows).toHaveCount(1);
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await fillWhenReady(page, composer, 'A draft that must survive');

    // A notice, then more than a page of other rows, then another notice: the refresh reads back to the opening row.
    pages = {
      null: { entries: [...unrelated(10, 63), newest], before: 'AAAAAAAAAMg' },
      AAAAAAAAAMg: { entries: [earlier, gap, ...unrelated(0, 10)], before: null },
    };
    requested.length = 0;
    await routineNotice(page);
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toHaveAccessibleName('Weekly DNS audit');
    await expect(rows.nth(2)).toHaveAccessibleName('Certificate check');
    await expect.poll(() => requested).toEqual([null, 'AAAAAAAAAMg']);
    // The next refresh finds nothing new on the newest page and reads no further.
    requested.length = 0;
    await routineNotice(page);
    await expect.poll(() => requested).toEqual([null]);
    await expect(rows).toHaveCount(3);

    // More was written than one refresh reads: the transcript starts again from the newest rows, as a reload shows them,
    // and earlier history continues from where the refresh stopped, down to the notice written in between.
    const behind = named('f', 'Monthly report');
    const cursor = (index) => `AAAAAAAA${String(index).padStart(2, '0')}A`;
    pages = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      index === 0 ? 'null' : cursor(index),
      { entries: unrelated(1000 + (8 - index) * 64, 64), before: cursor(index + 1) },
    ]));
    pages[cursor(8)] = { entries: [newest, behind], before: null };
    requested.length = 0;
    await routineNotice(page);
    await expect(page.getByText(`Unrelated message ${1000 + 8 * 64 + 64}`, { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    await expect.poll(() => requested).toEqual([null, ...Array.from({ length: 7 }, (_, index) => cursor(index + 1))]);
    await page.locator('.turns').evaluate((element) => { element.scrollTop = 0; });
    await expect(rows).toHaveCount(2);
    expect(requested.at(-1)).toBe(cursor(8));
    await expect(composer).toHaveValue('A draft that must survive');
  });

  test('each day of the transcript opens with its date, which stays at the top while that day scrolls', async ({ page }) => {
    // Noon in São Paulo on 1 October; a row written at 02:30 UTC that day is still the evening before for this viewer.
    await page.clock.install({ time: new Date('2026-10-01T15:00:00Z') });
    const at = (row, createdAt) => ({ ...row, created_at: createdAt });
    // Each reply is stored nine seconds after its message.
    const later = (iso) => new Date(Date.parse(iso) + 9_000).toISOString().replace('.000Z', 'Z');
    const exchange = (prefix, index, createdAt) => {
      const id = `${prefix}${String(index).padStart(31, '0')}`;
      return [
        { id: `${id}:user`, created_at: createdAt, kind: 'message', role: 'user', text: `Question ${prefix}${index}` },
        { id: `${id}:reply`, created_at: later(createdAt), kind: 'message', role: 'assistant', author: 'Marketing',
          text: `Answer ${prefix}${index}\n\n${'Detail line. '.repeat(30).trim()}` },
      ];
    };
    const history = {
      entries: [
        ...exchange('a', 0, '2026-09-29T14:00:05Z'),
        at(createdRow('b'.repeat(32)), '2026-09-29T15:00:00Z'),
        ...[0, 1, 2].flatMap((index) => exchange('c', index, `2026-09-29T2${index}:00:00Z`)),
        // Yesterday holds only stored messages: each row's own time gives it a day, with no Routine notice to borrow.
        ...[3, 4].flatMap((index) => exchange('c', index, `2026-09-30T1${index}:00:00Z`)),
        ...exchange('c', 5, '2026-10-01T02:30:00Z'),
        ...exchange('e', 0, '2026-10-01T13:00:00Z'),
        at(createdRow('f'.repeat(32)), '2026-10-01T14:00:00Z'),
      ],
      before: null,
    };
    await routeReadyChat(page, { history, reply: 'Live answer' });
    await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({ team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] }) : undefined));
    await page.goto('/chat/?team=marketing');
    const turns = page.locator('.turns');
    const days = turns.getByRole('heading', { level: 2 });
    const DAYS = ['September 29, 2026', 'Yesterday', 'Today'];
    await expect(days).toHaveText(DAYS);
    // The first stored message opens its own day.
    await expect(turns.locator('h2 + .exchange').first()).toContainText('Question a0');
    // Every message shows when it was sent and every reply when it was completed, to the second, in the viewer's
    // timezone; a Routine's creation shows its own time to the second.
    const timeOf = (text) => turns.locator('article', { hasText: text }).locator('time');
    await expect(timeOf('Question a0')).toHaveText('11:00:05');
    await expect(timeOf('Question a0')).toHaveAttribute('datetime', '2026-09-29T14:00:05Z');
    await expect(timeOf('Answer a0')).toHaveText('11:00:14');
    await expect(timeOf('Answer a0')).toHaveAttribute('datetime', '2026-09-29T14:00:14Z');
    await expect(timeOf('Question c5')).toHaveText('23:30:00');
    await expect(timeOf('Answer c5')).toHaveText('23:30:09');
    await expect(turns.locator('article', { has: page.locator('.routine-run') }).locator('time').first()).toHaveText('12:00:00');

    // A message sent now belongs to today, under the header already there.
    await sendMessage(page, 'Sent today');
    await expect(page.getByText('Live answer', { exact: true })).toBeVisible();
    await expect(days).toHaveText(DAYS);
    // A message sent and a reply completed while the page is open show the times the page saw them.
    const sent = await timeOf('Sent today').getAttribute('datetime');
    const answered = await timeOf('Live answer').getAttribute('datetime');
    expect(Date.parse(sent)).toBeGreaterThanOrEqual(Date.parse('2026-10-01T15:00:00Z'));
    expect(Date.parse(answered)).toBeGreaterThanOrEqual(Date.parse(sent));
    await expect(timeOf('Sent today')).toHaveText(/^12:\d{2}:\d{2}$/);
    await expect(timeOf('Live answer')).toHaveText(/^12:\d{2}:\d{2}$/);

    // Whatever is scrolled to the top of the transcript, the first thing there is its day's header.
    const dayAtTop = (text) => turns.evaluate((element, anchor) => {
      const target = [...element.querySelectorAll('p')].find((item) => item.textContent === anchor);
      target.scrollIntoView({ block: 'start' });
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + (box.width / 2), box.top + 3)?.closest('h2');
      return hit ? { day: hit.textContent, offset: Math.round(hit.getBoundingClientRect().top - box.top) } : null;
    }, text);
    await expect.poll(() => dayAtTop('Question c1')).toEqual({ day: 'September 29, 2026', offset: 0 });
    await expect(page.getByText('Question c1', { exact: true })).toBeInViewport();
    await expect.poll(() => dayAtTop('Question c4')).toEqual({ day: 'Yesterday', offset: 0 });
    await expect.poll(() => dayAtTop('Question c5')).toEqual({ day: 'Yesterday', offset: 0 });
    await expect.poll(() => dayAtTop('Sent today')).toEqual({ day: 'Today', offset: 0 });

    // After a reload every day still opens with its date, the earliest stored one included.
    await page.reload();
    await expect(days).toHaveText(DAYS);
    await expect(turns.locator('h2 + .exchange').first()).toContainText('Question a0');
    await expect.poll(() => dayAtTop('Question e0')).toEqual({ day: 'Today', offset: 0 });
  });
});

const KEY_PAGE = 'https://docs.exa.ai/keys';
const KEY_HELP = 'An Exa key lets this Assistant search the web. Sign in to Exa, create a key, and copy it.';
const TASK_PURPOSE = 'To bring today’s AI news I need to search the web with Shimpz Cloudflare.';

async function openHumanRequest(page, options) {
  const contract = await routeReadyChat(page, { humanKind: 'input:password', ...options });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Bring me today’s AI news');
  await page.getByRole('button', { name: 'Send' }).click();
  return contract;
}

test('a Stored Input request shows how to get the key, links its reviewed page, and sends the pasted key once', async ({ page }) => {
  const contract = await openHumanRequest(page, {
    humanStoredInput: 'exa-api-key',
    humanPurpose: TASK_PURPOSE,
    humanHelp: KEY_HELP,
    humanHelpUrl: KEY_PAGE,
  });
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toContainText(TASK_PURPOSE);
  // The help Team copied from the reviewed declaration reaches the person, and only its link is clickable.
  await expect(dialog).toContainText(KEY_HELP);
  const link = dialog.getByRole('link');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAccessibleName(/How to get it/);
  await expect(link).toHaveAttribute('href', KEY_PAGE);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const field = dialog.getByLabel('Cloudflare API secret');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('exa-secret-key');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect.poll(() => contract.humanResponses()).toEqual([expect.objectContaining({
    type: 'human-response',
    challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    decision: 'submit',
    value: 'exa-secret-key',
  })]);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('exa-secret-key');
});

test('a Stored Input request without a purpose names its Assistant and still shows how to get the key', async ({ page }) => {
  const contract = await openHumanRequest(page, { humanStoredInput: 'exa-api-key' });
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toContainText('Shimpz Cloudflare needs this key');
  await expect(dialog).toContainText('Create an API key in the Exa dashboard and copy it.');
  await expect(dialog.getByRole('link')).toHaveAttribute('href', 'https://dashboard.exa.ai/api-keys');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect.poll(() => contract.humanResponses()).toEqual([expect.objectContaining({ decision: 'deny' })]);
  expect(contract.humanResponses()[0]).not.toHaveProperty('value');
});

test('every chat frame carries the interface language selected when it is sent', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await sendMessage(page, 'List my DNS zones');
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect(composer).toBeEnabled();

  await switchLanguage(page, 'en', 'pt');
  const portuguese = page.getByRole('textbox', { name: 'Enviar', exact: true });
  await portuguese.fill('Liste minhas zonas DNS');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(2);
  expect(chat.chatFrames().map((frame) => [frame.type, frame.locale])).toEqual([['chat', 'en'], ['chat', 'pt']]);
});

test('a frozen Routine run opens in the interface language and answers with the canonical response', async ({ page }, testInfo) => {
  test.skip(testInfo.project.use.hasTouch, 'the phone opens the Team list from a drawer whose labels this test does not localize');
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  const run = 'd'.repeat(32);
  await routeReadyChat(page, {
    history: {
      entries: [noticeRow(run, { routine_id: 'a'.repeat(32), name: ROUTINE_VIEW.name }, 'frozen', { request_kind: 'human' }, { at: NOTICE_AT })],
      before: null,
    },
  });
  await routeRead(page, 'routines.list', (params) => (params.team_id === 'marketing' ? ok({
      team_id: 'marketing',
      routines: [ROUTINE_VIEW],
      runs: [frozenRun(run, 'human')],
      incidents: [],
    }) : undefined));
  const openings = [];
  const answers = [];
  await routeRead(page, 'routines.challenge', ({ body: opening }) => {
    openings.push(opening);
    // A Routine challenge carries no purpose: Team renders its request copy in the opening's language.
    return ok(routineChallenge(run, localizedChallenge(humanRequest('approval'), {
      locale: opening.locale,
      shown: {
        title: 'Publicar as alterações de DNS revisadas?',
        description: 'O Shimpz Cloudflare pausou antes de continuar esta Ação exata.',
      },
    })));
  });
  await routeRead(page, 'routines.human', ({ body }) => {
    answers.push(body);
    return ok({ team_id: 'marketing', run_id: run, status: 'done' });
  });
  await page.goto('/chat/?team=marketing');
  // The Routine's panel opens in the interface language and offers the review.
  const panel = await openRoutinePanel(page, ROUTINE_VIEW.name, 'pt');
  await panel.getByRole('button', { name: 'Revisar' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publicar as alterações de DNS revisadas?' });
  await expect(dialog).toContainText('O Shimpz Cloudflare pausou antes de continuar esta Ação exata.');
  await expect(dialog).not.toContainText('Publish reviewed DNS changes?');
  expect(openings).toEqual([{ locale: 'pt' }]);
  await dialog.getByRole('button', { name: 'Aprovar ação' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => answers).toEqual([{ type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true }]);
});
