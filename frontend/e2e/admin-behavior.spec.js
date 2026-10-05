import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

import { messages } from '../src/lib/messages.js';
import { accessibilityViolations } from './axe.js';
import { localizedChallenge } from './localizedRequest.js';

import { routeScenario } from './scenarioRoutes.js';
import { CLARIFICATION as SCENARIO_CLARIFICATION, ROUTINE_VIEW, TEAMS } from './scenarios.js';

// The page-level WebSocket transport mock is stateful. Keep this file ordered while
// the independent shell and boot contracts continue using the full worker pool.
test.describe.configure({ mode: 'default' });

// Every stored chat history row carries the UTC time Admin wrote it.
const HISTORY_AT = '2026-10-01T12:00:00Z';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/modelCatalog.json', import.meta.url), 'utf8'),
);

function localSession(overrides = {}) {
  return {
    profile: 'local',
    authenticated: false,
    initialized: false,
    authentication_state: 'uninitialized',
    ...overrides,
  };
}

function authenticatedLocalSession(overrides = {}) {
  return localSession({
    authenticated: true,
    initialized: true,
    authentication_state: 'configured',
    authentication_method: 'webauthn',
    origin_admitted: true,
    oauth_completion_mode: null,
    passkey_enrollment_available: true,
    passkey_registered: true,
    ...overrides,
  });
}

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
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.4.1',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'f'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
      }],
    }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [], trace_id: 'c'.repeat(32) }),
  }));
}

function humanRequest(kind) {
  const base = {
    kind,
    ordinal: 0,
    title: {
      approval: 'Publish reviewed DNS changes?',
      'auth:password': 'Confirm with your Supervisor password',
      'auth:totp': 'Confirm with your TOTP code',
      'auth:passkey': 'Confirm with your passkey',
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
async function fillWhenReady(page, composer, message) {
  await composer.fill(message);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
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
    pt: 'Inspeciona zonas do Cloudflare e gerencia registros DNS comuns com segurança por OAuth.',
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
  humanHelpUrl = '',
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
  hostedSession = false,
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
  let releaseReply = () => {};
  let releaseProgressStart = () => {};
  let releaseProgressFinish = () => {};
  let sendProgressEvent = () => {};
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
    if (firstChatDisconnected && expireSessionOnDisconnect) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(localSession({ initialized: true, authentication_state: 'configured' })),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(hostedSession
        ? { profile: 'hosted', authenticated: true, account_id: 'account-1' }
        : authenticatedLocalSession({ oauth_completion_mode: oauthCompletionMode })),
    });
  });
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
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
    }),
  }));
  await page.route('**/api/teams/marketing/assistants', async (route) => {
    if (holdAssistantInventoryRefresh && !assistantInstalled) await assistantInventoryHold;
    if (holdPostInstallInventory && assistantInstalled) await assistantInventoryHold;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
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
      }),
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
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));
  await page.route('**/api/teams/marketing/chat/history**', async (route) => {
    const requestUrl = new URL(route.request().url());
    historyRequests.push(requestUrl.searchParams.get('before'));
    if (holdHistory) await historyHold;
    return route.fulfill({
      status: historyStatus,
      contentType: 'application/json',
      body: JSON.stringify(historyStatus === 200
        ? requestUrl.searchParams.has('before') ? olderHistory : history
        : { detail: 'Synthetic history failure.' }),
    });
  });
  const providerState = ({ credential_validation: _credential, ...provider }) => ({
    ...provider,
    configured: configuredProviders.has(provider.id),
    masked: configuredProviders.has(provider.id) ? '••••1234' : null,
  });
  await page.route('**/api/model-providers', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ providers: modelCatalog.providers.map(providerState) }),
  }));
  await page.route('**/api/model-providers/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    credentialBodies.push({ id, ...route.request().postDataJSON() });
    configuredProviders.add(id);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(providerState(modelCatalog.providers.find((provider) => provider.id === id))),
    });
  });
  await page.route('**/api/decision-provider', (route) => {
    const method = route.request().method();
    decisionRequests.push({ method, body: route.request().postDataJSON() });
    if (method === 'PUT' && rejectDecisionKey) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'TypeSafe rejected API key' }) });
    }
    if (method === 'PUT') decisionMasked = `••••${route.request().postDataJSON().api_key.slice(-4)}`;
    if (method === 'DELETE') decisionMasked = null;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'typesafe', configured: decisionMasked !== null, masked: decisionMasked }),
    });
  });
  await page.route('**/api/teams/marketing/inference', async (route) => {
    if (missingInference && route.request().method() === 'GET') {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'not configured' }),
      });
    }
    if (route.request().method() === 'PUT') {
      inferenceWrites += 1;
      inferenceBodies.push(route.request().postDataJSON());
      if (holdInferenceWrite) await inferenceWriteHold;
      if (failInferenceWrite && inferenceWrites === 1) {
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'The Team model selection could not be saved.' }),
        });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ team_id: 'marketing', ...route.request().postDataJSON() }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ team_id: 'marketing', provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' }),
    });
  });
  await page.route('**/api/teams/marketing/assistant-integrations', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
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
    }),
  }));
  // Team reads an installed Assistant's summary from its binding's pack, only in the requested interface language.
  await page.route(
    (url) => /^\/api\/teams\/marketing\/assistants\/[^/]+\/summary$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url());
      const locale = url.searchParams.get('locale');
      const summary = INSTALLED_SUMMARIES[url.pathname.split('/')[5]]?.[locale];
      return route.fulfill(summary ? {
        contentType: 'application/json',
        body: JSON.stringify({ locale, summary }),
      } : {
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'installed Assistant manifest failed its reviewed contract' }),
      });
    },
  );
  await page.route('**/api/teams/marketing/assistant-stored-inputs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      stored_inputs: storedInputStatus ? [{
        assistant_id: 'whatsapp',
        stored_input_id: 'whatsapp-token',
        status: storedInputStatus,
      }] : [],
    }),
  }));
  await page.route(
    '**/api/teams/marketing/assistant-stored-inputs/whatsapp/whatsapp-token',
    (route) => {
      storedInputClears += 1;
      storedInputStatus = 'missing';
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ cleared: true }),
      });
    },
  );
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    if (firstChatDisconnected && reconnectsRefused < refusedReconnects) {
      // Admin is down while a release swaps its containers, or refuses an expired session before accepting the
      // upgrade: either way the upgrade fails before the socket ever opens.
      reconnectsRefused += 1;
      socket.connectToServer();
      return;
    }
    sendProgressEvent = (event) => socket.send(JSON.stringify(event));
    const connection = chatConnections;
    chatConnections += 1;

    // The optional Brain-written purpose and reviewed key page travel beside the fingerprinted request (ADR-0090).
    const humanPresentation = {
      ...(humanPurpose ? { purpose: humanPurpose } : {}),
      ...(humanHelpUrl ? { help_url: humanHelpUrl } : {}),
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
        // Admin seals each admitted send; a resend carries its seal back unchanged (ADR-0092).
        const seal = frame.request ?? `${1_790_000_000 + chatFrames.length}.${'a'.repeat(32)}.${'b'.repeat(64)}`;
        socket.send(JSON.stringify({ type: 'sent', request: seal }));
        if (disconnectFirstChat && !firstChatDisconnected && frame.type === 'chat') {
          firstChatDisconnected = true;
          socket.close({ code: 1011, reason: 'Synthetic interrupted turn' });
          return;
        }
        if (expireSessionOnFirstChat) {
          // Admin revalidates the session before every frame and closes the socket once it has expired.
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
              providers: ['cloudflare'],
              provenance: 'local',
            },
            {
              id: 'whatsapp',
              name: 'WhatsApp',
              summary: 'Send reviewed WhatsApp messages.',
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
            socket.send(JSON.stringify({
              type: 'assistant-uninstall',
              state: 'proposed',
              proposal_id: 'e'.repeat(32),
              team_id: 'marketing',
              reply: 'Shimpz Cloudflare is installed. Should I uninstall it from this Team?',
              expires_in: 120,
              assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
            }));
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
    releaseAssistantInventory: () => releaseAssistantInventory(),
    releaseAssistantIcon: () => releaseAssistantIcon(),
    releaseInferenceWrite: () => releaseInferenceWrite(),
    releaseHumanResponse: () => releaseHumanResponse(),
    releaseHistory: () => releaseHistory(),
    releaseReply: () => releaseReply(),
    releaseProgressStart: () => releaseProgressStart(),
    releaseProgressFinish: () => releaseProgressFinish(),
    sendProgressEvent: (event) => sendProgressEvent(event),
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
  expect(chat.credentialBodies()).toEqual([{ id: 'openai', api_key: 'sk-browser-contract-1234567890' }]);
  expect(chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6-luna', effort: 'low' }]);
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
  expect(chat.credentialBodies()).toEqual([{ id: 'anthropic', api_key: secret }]);
  expect(chat.inferenceBodies()).toEqual([{ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' }]);
  expect(chat.chatConnections()).toBe(connections);

  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  expect(JSON.stringify(chat.chatFrames())).not.toContain(secret);
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
  const { fast } = await openFastRouting(page);
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
  expect(chat.decisionRequests()).toEqual([
    { method: 'GET', body: null },
    { method: 'GET', body: null },
    { method: 'PUT', body: { api_key: secret } },
    { method: 'DELETE', body: null },
  ]);
  expect(chat.credentialBodies()).toEqual([]);
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

  await page.keyboard.press('Escape');
  await expect(page.getByLabel('TypeSafe API key')).toHaveCount(0);
  await trigger.click();
  await expect(fast.getByRole('alert')).toHaveCount(0);
  await expect(fast.getByLabel('TypeSafe API key')).toHaveValue('');
  expect(chat.decisionRequests().map((request) => request.method)).toEqual(['GET', 'GET', 'PUT', 'GET']);
});

test('reopening fast routing re-reads a Jev key another session changed', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const { trigger, fast } = await openFastRouting(page);
  await expect(fast.getByLabel('TypeSafe API key')).toBeVisible();
  await page.keyboard.press('Escape');

  chat.configureDecisionElsewhere('••••abcd');
  await trigger.click();
  await expect(fast).toContainText('On · key ••••abcd');
  expect(chat.decisionRequests().map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
});

test('Hosted chat never offers or requests a Jev key', async ({ page }) => {
  const chat = await routeReadyChat(page, { hostedSession: true });
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^Reasoning effort/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^Fast routing/ })).toHaveCount(0);
  expect(chat.decisionRequests()).toEqual([]);
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
  await fillWhenReady(page, composer, VOICE_REQUEST);
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByRole('form', { name: SCENARIO_CLARIFICATION.question });
  await expect(card.getByRole('radio', { name: /· recommended/ })).toBeChecked();
  expect(sentMessages(scenario.chatFrames())).toEqual([VOICE_REQUEST]);
  return { composer, card };
}

test('answering a question sends the request with the answer at once and the Team replies', async ({ page }) => {
  const scenario = await routeScenario(page, 'clarify');
  const { composer, card } = await askVoiceQuestion(page, scenario);
  const recommended = SCENARIO_CLARIFICATION.options[SCENARIO_CLARIFICATION.default_index].label;

  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText(`Certo — sigo com ${recommended}`)).toBeVisible();
  expect(sentMessages(scenario.chatFrames())).toEqual([
    VOICE_REQUEST,
    composedAnswer(VOICE_REQUEST, SCENARIO_CLARIFICATION.question, recommended),
  ]);
  // The answered question offers no second answer, even in another language, and nothing was left to send again.
  await expect(card).toHaveCount(0);
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('article', { name: 'You' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  await expect(page.getByRole('textbox', { name: 'Enviar', exact: true })).toBeEnabled();
  await expect(card).toHaveCount(0);
  expect(sentMessages(scenario.chatFrames())).toHaveLength(2);
});

test('the composer waits while the latest question is open and the card\'s answer unlocks it', async ({ page }) => {
  const scenario = await routeScenario(page, 'clarify');
  const { composer, card } = await askVoiceQuestion(page, scenario);
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveAttribute('placeholder', 'Answer the question above to continue.');
  await expect(send).toBeDisabled();

  await card.getByRole('button', { name: 'Answer' }).click();
  const recommended = SCENARIO_CLARIFICATION.options[SCENARIO_CLARIFICATION.default_index].label;
  await expect(page.getByText(`Certo — sigo com ${recommended}`)).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.fill('Thanks');
  await expect(send).toBeEnabled();
  expect(sentMessages(scenario.chatFrames())).toEqual([
    VOICE_REQUEST,
    composedAnswer(VOICE_REQUEST, SCENARIO_CLARIFICATION.question, recommended),
  ]);
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

test('a failed answer is sent again once by Try again, without a second user turn', async ({ page }) => {
  const scenario = await routeScenario(page, 'clarify-error');
  const { card } = await askVoiceQuestion(page, scenario);
  const composed = composedAnswer(
    VOICE_REQUEST,
    SCENARIO_CLARIFICATION.question,
    SCENARIO_CLARIFICATION.options[1].label,
  );

  await card.getByRole('radio', { name: SCENARIO_CLARIFICATION.options[1].label }).check();
  await card.getByRole('button', { name: 'Answer' }).click();
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeEnabled();
  expect(sentMessages(scenario.chatFrames())).toEqual([VOICE_REQUEST, composed]);

  await retry.click();
  await expect(page.getByText(`Certo — sigo com ${SCENARIO_CLARIFICATION.options[1].label}`)).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(sentMessages(scenario.chatFrames())).toEqual([VOICE_REQUEST, composed, composed]);
  await expect(page.getByRole('article', { name: 'You' })).toHaveCount(2);
});

test('Try again resends only the latest failed message', async ({ page }) => {
  const chat = await routeReadyChat(page, { terminalError: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeEnabled();

  // A new message replaces the failed one as the only message that can be sent again.
  await fillWhenReady(page, composer, 'List my DNS records');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toBeEnabled();
  const frames = chat.chatFrames();
  expect(sentMessages(frames)).toEqual(['List my DNS zones', 'List my DNS records', 'List my DNS records']);
  // A new send names no identity; Try again carries back the seal Admin gave the failed send (ADR-0092).
  expect(frames.map((frame) => frame.request)).toEqual([null, null, `${1_790_000_002}.${'a'.repeat(32)}.${'b'.repeat(64)}`]);
});

test('a send refused while the Space resets explains the reset and can be sent again', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    terminalError: 409,
    terminalDetail: 'space-resetting: the Space is being reset; retry when it finishes',
  });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const notice = page.locator('[data-slot="notice"].shimpz-notice--error');
  await expect(notice).toContainText(messages.en.chatPage.spaceResetting);

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual(['List my DNS zones', 'List my DNS zones']);
});

test('a send Admin refuses as expired is never offered to be sent again', async ({ page }) => {
  await routeReadyChat(page, { terminalError: 410 });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('HTTP 410', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('an error delivered by a reconnect sync never offers to resend a finished request', async ({ page }) => {
  await routeScenario(page, 'ready');
  const frames = [];
  let connections = 0;
  // Registered after the scenario, so this chat socket takes precedence: the first request ends with Team guidance,
  // the socket restarts, and the reconnect sync reports a failure that belongs to no request of this page.
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
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
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Uninstall the Assistant');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('The local chat runtime is unavailable.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
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
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Which new AI models were released?');
  await page.getByRole('button', { name: 'Send' }).click();

  const card = page.getByRole('form', { name: clarification.question });
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual([
    'Which new AI models were released?',
    composedAnswer('Which new AI models were released?', clarification.question, clarification.options[0].label),
  ]);
});

// A Routine question recommends nothing (ADR-0092 amendment, 2026-10-05): no option is chosen until the person picks one.
const ROUTINE_REQUEST = 'create a routine that does this every 30 seconds';
const ROUTINE_QUESTION = {
  question: 'What should the Routine repeat every 30 seconds?',
  options: [{ label: 'List my Cloudflare domains', description: '' }],
  default_index: null,
};
const ROUTINE_QUESTION_REPLY = 'What should the Routine repeat every 30 seconds?\n\n1. List my Cloudflare domains';

async function askRoutineQuestion(page) {
  const chat = await routeReadyChat(page, { clarification: ROUTINE_QUESTION, reply: ROUTINE_QUESTION_REPLY });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, ROUTINE_REQUEST);
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByRole('form', { name: ROUTINE_QUESTION.question });
  const answer = card.getByRole('button', { name: 'Answer' });
  await expect(answer).toBeDisabled();
  for (const radio of await card.getByRole('radio').all()) await expect(radio).not.toBeChecked();
  return { chat, card, answer };
}

test('a Routine question preselects nothing and sends the suggestion the person picks', async ({ page }) => {
  const { chat, card, answer } = await askRoutineQuestion(page);
  await card.getByRole('radio', { name: ROUTINE_QUESTION.options[0].label }).check();
  await expect(answer).toBeEnabled();
  await answer.click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual([
    ROUTINE_REQUEST,
    composedAnswer(ROUTINE_REQUEST, ROUTINE_QUESTION.question, ROUTINE_QUESTION.options[0].label),
  ]);
});

test('a Routine question sends the person\'s own words as the other answer', async ({ page }) => {
  const { chat, card, answer } = await askRoutineQuestion(page);
  await card.getByRole('radio', { name: 'Other answer' }).check();
  await expect(answer).toBeDisabled();
  await card.getByRole('textbox').fill('List my DNS records');
  await answer.click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual([
    ROUTINE_REQUEST,
    composedAnswer(ROUTINE_REQUEST, ROUTINE_QUESTION.question, 'List my DNS records'),
  ]);
});

test('an answer that would exceed one message is refused and nothing is sent', async ({ page }) => {
  const chat = await routeReadyChat(page, { clarification: CLARIFICATION, reply: CLARIFICATION_REPLY });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  const request = 'x'.repeat(16_000 - 60);
  await fillWhenReady(page, composer, request);
  await page.getByRole('button', { name: 'Send' }).click();

  const card = page.getByRole('form', { name: CLARIFICATION.question });
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(card).toBeVisible();
  expect(sentMessages(chat.chatFrames())).toEqual([request]);
});

test('a reloaded question stays bound to its own request', async ({ page }) => {
  const turn = 'd'.repeat(32);
  const asked = [
    { id: `${turn}:user`, created_at: HISTORY_AT, kind: 'message', role: 'user', text: 'Which new AI models were released?' },
    {
      id: `${turn}:reply`,
      created_at: HISTORY_AT,
      kind: 'message',
      role: 'assistant',
      text: CLARIFICATION_REPLY,
      author: 'Marketing',
      clarification: CLARIFICATION,
    },
  ];
  const chat = await routeReadyChat(page, { clarification: null, history: { entries: asked, before: null } });
  await page.goto('/chat/');
  const card = page.getByRole('form', { name: CLARIFICATION.question });
  await card.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => sentMessages(chat.chatFrames())).toEqual([
    composedAnswer('Which new AI models were released?', CLARIFICATION.question, 'Today'),
  ]);
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
  expect(chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' }]);
  expect(chat.chatFrames()).toHaveLength(0);
});

test('shows a Brain failure and its retry beside an earlier chat error', async ({ page }) => {
  await routeReadyChat(page, {
    unconfiguredProviders: ['anthropic'],
    failInferenceWrite: true,
    terminalError: true,
  });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
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

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(chat.credentialBodies()).toHaveLength(1);
  expect(chat.inferenceBodies()).toEqual([
    { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' },
    { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' },
  ]);
});

test('compiled Chat renders Markdown and its execution receipt', async ({ page }) => {
  await routeReadyChat(page, {
    reply: `**Rendered answer** with a [safe link](https://example.com).

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
  await expect(page.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com/');
  const notices = page.locator('.shimpz-message--assistant [data-slot="notice"]');
  await expect(notices).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(notices.nth(index)).toHaveAttribute('role', 'status');
  }
  await expect(page.getByText(/Execution stages recorded: 1/i)).toBeVisible();
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
  await thinking.locator('[data-slot="disclosure-trigger"]').click();
  const step = thinking.locator('.ledger li');
  await expect(step).toBeVisible();
  await expect(step).toHaveClass(/active/);
  chat.releaseProgressFinish();
  await expect(step).toHaveClass(/complete/);
  await expect(step.locator('time')).toHaveText('19 ms');
  await expect(liveStatus).toHaveText(/Complete$/);

  chat.releaseReply();
  await expect(page.getByText('Execution stages recorded: 1')).toBeVisible();
  await composer.fill('Check progress again');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(liveStatus).toHaveText(/In progress$/);
  chat.releaseProgressFinish();
  await expect(liveStatus).toHaveText(/Complete$/);
  chat.releaseReply();
  await expect(page.getByText('Execution stages recorded: 1')).toHaveCount(2);
});

test('overlapping progress returns the visible summary to the earlier active phase @browser-sensitive', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdProgressFinish: true, holdReply: true });
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
  await thinking.locator('[data-slot="disclosure-trigger"]').click();
  const rows = thinking.locator('.ledger li');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveClass(/active/);
  await expect(rows.last()).toHaveClass(/complete/);
  await expect(rows.last().locator('time')).toHaveText('9 ms');

  chat.sendProgressEvent({
    type: 'progress', seq: 4, origin: 'admin', phase: 'admin-preparation',
    state: 'finished', elapsed_ms: 20,
  });
  await expect(current).toHaveText('Waiting for execution');
  chat.releaseReply();
  await expect(page.getByText('Execution stages recorded: 2')).toBeVisible();
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
  await expect(thinking.locator('.ledger li')).toHaveCount(0);
  await expect(composer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect.poll(() => chat.chatFrames().length).toBe(1);

  chat.releaseProgressStart();
  await expect(liveStatus).toHaveText(/Complete$/);
  chat.releaseReply();
  await expect(page.getByText('Execution stages recorded: 1')).toBeVisible();
  await expect(composer).toBeEnabled();
  expect(chat.chatFrames()).toHaveLength(1);
});

test('the composer sends 16,000 emoji and shows a reply longer than 60,000 UTF-16 units', async ({ page }) => {
  // Team and Admin bound chat text by Unicode code points; each emoji is two UTF-16 units.
  const message = '😀'.repeat(16_000);
  const chat = await routeReadyChat(page, { reply: `Accepted ${'😀'.repeat(30_001)}` });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, message);
  await page.getByRole('button', { name: 'Send' }).click();

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
  await composer.fill('Check progress');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect(page.getByText('The secure chat response was invalid.', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  await expect(page.getByText('Rendered answer', { exact: true })).toHaveCount(0);
  expect(chat.chatFrames()).toHaveLength(1);
});

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
  await expect(composer).toBeEnabled();
  await composer.fill('Second prompt');
  await send.click();
  await expect.poll(() => chat.chatFrames().length).toBe(2);
  await expect(composer).toHaveValue('');

  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First prompt');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('First prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('Second prompt');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');
  await composer.press('ArrowDown');
  await expect(composer).toHaveValue('');

  await composer.fill('Manual draft');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Manual draft');
  await composer.fill('');
  await composer.press('ArrowUp');
  await expect(composer).toHaveValue('Second prompt');
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
  expect(chat.historyRequests()).toEqual([null]);
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  await expect(turns).toHaveAccessibleDescription('Scroll up to load earlier messages.');

  await turns.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => chat.historyRequests()).toEqual([null, cursor]);
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  // The prepended page keeps the message the reader was looking at in place.
  await expect(page.getByText('Recent question 1', { exact: true })).toBeInViewport();
  await expect(turns).not.toHaveAttribute('aria-describedby');
});

test('keeps the message at the top of the transcript where it was once earlier history arrives @browser-sensitive', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  await routeReadyChat(page, {
    history: longHistory('f', 32, cursor),
    olderHistory: longHistory('e', 32, null),
  });
  let releaseOlder;
  const olderHeld = new Promise((resolve) => { releaseOlder = resolve; });
  await page.route('**/api/teams/marketing/chat/history**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('before')) await olderHeld;
    return route.fallback();
  });
  // A reader who asked for reduced motion gets every layout change at once, so it is measured with that setting.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/chat/');
  const turns = page.locator('.turns');
  await expect(page.getByText('Recent answer 32', { exact: false })).toBeInViewport();
  // The reader scrolls the transcript to its top with the wheel, as they reach earlier history; an engine may move
  // less than one gesture asks, so the reader keeps scrolling until the earlier page is requested.
  const loading = page.getByRole('status').filter({ hasText: 'Loading earlier messages…' });
  await turns.hover();
  await expect(async () => {
    await page.mouse.wheel(0, -((await turns.evaluate((element) => element.scrollTop)) + 1000));
    await expect(loading).toBeAttached({ timeout: 500 });
  }).toPass();
  const reading = page.getByText('Recent question 1', { exact: true });
  const shownAt = async () => (await reading.boundingBox()).y;
  const before = await shownAt();
  releaseOlder();
  await expect(page.getByText('Earlier question 32', { exact: true })).toBeAttached();
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
  await page.route('**/api/teams/marketing/chat/history**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('before')) await olderHeld;
    return route.fallback();
  });
  await page.goto('/chat/');
  const turns = page.locator('.turns');
  await expect(page.getByText('Recent answer 12', { exact: false })).toBeInViewport();

  const olderRequest = page.waitForRequest((request) => request.url().includes('before='));
  await turns.evaluate((element) => { element.scrollTop = 0; });
  await olderRequest;
  await expect(page.getByRole('status').filter({ hasText: 'Loading earlier messages…' })).toBeAttached();
  const reading = page.getByText('Recent question 6', { exact: true });
  await reading.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(reading).toBeInViewport();
  releaseOlder();
  await expect(page.getByText('Earlier question 12', { exact: true })).toBeAttached();
  await expect(reading).toBeInViewport();
  expect(chat.historyRequests()).toEqual([null, cursor]);
});

test('fills a short transcript through consecutive earlier pages', async ({ page }) => {
  const first = 'AAAAAAAAAAI';
  const second = 'AAAAAAAAABA';
  const chat = await routeReadyChat(page, { history: longHistory('f', 1, first, { detail: false }) });
  const pages = {
    [first]: longHistory('e', 1, second, { detail: false }),
    [second]: longHistory('d', 1, null, { detail: false }),
  };
  await page.route('**/api/teams/marketing/chat/history**', (route) => {
    const before = new URL(route.request().url()).searchParams.get('before');
    if (!before) return route.fallback();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(pages[before]) });
  });
  const requested = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/chat/history')) requested.push(url.searchParams.get('before'));
  });
  await page.goto('/chat/');
  await expect(page.getByText('Oldest question 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier question 1', { exact: true })).toBeVisible();
  await expect.poll(() => requested).toEqual([null, first, second]);
  await expect(page.locator('.turns')).not.toHaveAttribute('aria-describedby');
  expect(chat.historyRequests()).toEqual([null]);
});

test('offers a retry only after automatic earlier history fails', async ({ page }) => {
  const cursor = 'AAAAAAAAAAI';
  const chat = await routeReadyChat(page, {
    history: longHistory('f', 1, cursor),
    olderHistory: longHistory('e', 1, null),
  });
  let olderAttempts = 0;
  await page.route('**/api/teams/marketing/chat/history**', (route) => {
    if (!new URL(route.request().url()).searchParams.has('before')) return route.fallback();
    olderAttempts += 1;
    if (olderAttempts > 1) return route.fallback();
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'offline' }) });
  });
  await page.goto('/chat/');
  const retry = page.getByRole('button', { name: 'Load older messages' });
  await expect(retry).toBeVisible();
  await page.waitForTimeout(300);
  expect(olderAttempts).toBe(1);
  await expect(page.locator('.turns')).not.toHaveAttribute('aria-describedby');

  await retry.click();
  await expect(page.getByText('Earlier question 1', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(olderAttempts).toBe(2);
  expect(chat.historyRequests()).toEqual([null, cursor]);
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
  expect(chat.historyRequests()).toEqual([null, cursor]);
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
  await page.route('**/api/teams/marketing/chat/history**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('before')) await olderHeld;
    return route.fallback();
  });

  const olderRequest = page.waitForRequest((request) => request.url().includes('before='));
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
          assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
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
  await expect(tasks.nth(0)).toContainText('Local');
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
  expect(chat.chatFrames()).toHaveLength(1);
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
  expect(chat.chatFrames()).toHaveLength(2);
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
  expect(chat.chatFrames()).toHaveLength(1);
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
  expect(chat.chatFrames()).toHaveLength(1);
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
  await dialog.getByLabel('Shimpz Cloudflare API key').fill('saved-third-party-secret');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  await expect(composer).toBeEnabled();
  expect(chat.chatFrames()).toHaveLength(1);
  expect(chat.humanResponses()).toHaveLength(1);
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
  await dialog.getByLabel('Shimpz Cloudflare API key').fill('saved-third-party-secret');
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
  await dialog.getByLabel('Shimpz Cloudflare API key').fill('saved-third-party-secret');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  expect(chat.humanResponses()).toHaveLength(1);
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

test('keeps reconnecting while Admin restarts for a release and recovers without a refresh', async ({ page }) => {
  // The browser spaces out repeated failed upgrades in real time, beyond the virtual clock.
  test.slow();
  await page.clock.install();
  // More refused upgrades than the old five-attempt budget allowed, as a Local release swap causes.
  // Admin's own session check is unreachable for the first half of the outage and answers once Admin is back.
  const chat = await routeReadyChat(page, {
    disconnectFirstChat: true,
    refusedReconnects: 6,
    adminDownRefusals: 3,
    reply: 'Task complete.',
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const reconnecting = page.getByText('The secure chat connection was interrupted. Reconnecting…');
  await expect(reconnecting).toBeVisible();

  // Virtual time advances one second per probe, while the browser's own delay after a failed attempt runs in real time.
  const advanced = (probe) => async () => {
    await page.clock.runFor(1_000);
    return probe();
  };
  await expect.poll(advanced(() => chat.refusedConnections()), { timeout: 30_000 }).toBe(6);
  await expect.poll(advanced(() => reconnecting.isVisible()), { timeout: 30_000 }).toBe(false);
  await expect(page.getByText('The secure chat connection could not be established.', { exact: false })).toHaveCount(0);

  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
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

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return chat.refusedConnections();
  }).toBeGreaterThan(0);
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const refused = chat.refusedConnections();
  await page.clock.runFor(160_000);
  expect(chat.refusedConnections()).toBe(refused);
});

test('an expired session ends the chat connection instead of reconnecting', async ({ page }) => {
  await page.clock.install();
  const chat = await routeReadyChat(page, { expireSessionOnFirstChat: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The secure chat connection could not be established.', { exact: false })).toBeVisible();
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
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Lista minhas zonas DNS no Cloudflare');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The secure chat connection was interrupted. Reconnecting…')).toBeVisible();
  await expect(composer).toBeEnabled();

  await composer.fill('Você mesmo consegue habilitar?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Task complete.')).toBeVisible();
  const resumed = page.locator('.resumed-task');
  await expect(resumed).toContainText('Resuming this task');
  await expect(resumed).toContainText('Lista minhas zonas DNS no Cloudflare');

  expect(chat.chatFrames()).toHaveLength(2);
  expect(chat.chatFrames()[1]).toEqual({
    type: 'resume-task',
    message: 'Você mesmo consegue habilitar?',
    objective: 'Lista minhas zonas DNS no Cloudflare',
    files: [],
    assistant_ids: [],
    objective_assistant_ids: [],
    locale: 'en',
    timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    request: null,
  });
  const persistedBrowserState = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(persistedBrowserState).not.toContain('Lista minhas zonas DNS no Cloudflare');
  expect(persistedBrowserState).not.toContain('Você mesmo consegue habilitar?');
});

for (const [code, message, question] of [
  ['assistant-install-target-required', 'instale', 'Qual Assistant você quer instalar?'],
  [
    'assistant-uninstall-target-required',
    'désinstalle',
    'Quel Assistant installé voulez-vous désinstaller\u00a0?',
  ],
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
    await expect(page.locator('.chat-route > .error')).toHaveCount(0);
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

test('a failed uninstall decision never offers to resend the earlier request', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true, failUninstallDecision: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Uninstall the Cloudflare Assistant');
  await page.getByRole('button', { name: 'Send' }).click();
  const uninstall = page.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();
  await page.waitForTimeout(2100);
  await uninstall.click();

  await expect(page.getByRole('alert').filter({ hasText: 'chat history is unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant', 'yes']);
});

test('a typed uninstall decision that fails is never offered for resend', async ({ page }) => {
  const chat = await routeReadyChat(page, { assistantUninstall: true, failUninstallDecision: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Uninstall the Cloudflare Assistant');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' })).toBeEnabled();
  await fillWhenReady(page, composer, 'no');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'chat history is unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  expect(chat.chatFrames().map((frame) => frame.message)).toEqual(['Uninstall the Cloudflare Assistant', 'no']);
});

test('uninstalls an Assistant from the inline proposal and confirms Team absence', async ({ page }) => {
  const chat = await routeReadyChat(page, {
    assistantUninstall: true,
    holdAssistantIcon: true,
    holdAssistantUninstall: true,
    holdAssistantInventoryRefresh: true,
  });
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
  expect(chat.chatFrames()).toHaveLength(1);
  await expect(task).toContainText('Assistant uninstall');
  await expect(task).toContainText('Confirmation required');
  await expect(task).toContainText(
    'This removes the running Assistant, its Integration authorizations, and any pending work for it in this Team. If it is a Local build, its snapshot remains staged on this machine so it can be installed again. To delete that snapshot permanently, run shimpz assistant unstage from its project.',
  );
  const icon = task.locator('img');
  await expect(icon).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  await expect(task.getByRole('button', { name: 'Cancel uninstalling Shimpz Cloudflare' }))
    .toBeEnabled();
  const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();

  await page.waitForTimeout(2100);
  await uninstall.click();
  await expect(task).toHaveAttribute('data-state', 'pending');
  expect(chat.chatFrames()).toHaveLength(1);
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

  await page.getByRole('button', { name: 'Brain: GPT-6.1 Sol, Low reasoning' }).click();
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
  const summaryLocales = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/summary')) summaryLocales.push(url.searchParams.get('locale'));
  });
  await routeReadyChat(page, { multipleIntegrations: true });
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
  await expect.poll(() => summaryLocales).toEqual(['en', 'pt', 'pt']);
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
  let authorizeRoute;
  await page.route(
    '**/api/teams/marketing/assistant-integrations/challenges/*/authorize',
    (route) => { authorizeRoute = route; },
  );
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
  await expect.poll(() => Boolean(authorizeRoute)).toBe(true);
  expect(authorizeRoute.request().postDataJSON()).toEqual({
    assistant_id: 'whatsapp',
    integration_id: 'whatsapp-messages',
  });
  await authorizeRoute.abort();
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
  await page.route(
    `**/api/teams/marketing/assistant-integrations/challenges/${challengeId}/authorize`,
    (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ authorization_url: authorizationUrl, completion_mode: 'automatic' }),
    }),
  );
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
  await page.route(
    `**/api/teams/marketing/assistant-integrations/challenges/${challengeId}/authorize`,
    (route) => {
      if (route.request().method() === 'DELETE') {
        canceled = true;
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ authorization_url: authorizationUrl, completion_mode: 'code' }),
      });
    },
  );
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
  await page.route(
    `**/api/teams/marketing/assistant-integrations/challenges/${challengeId}/authorize`,
    (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ authorization_url: authorizationUrl, completion_mode: 'code' }),
    }),
  );
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
  await expect(page.getByRole('dialog', { name: 'Paste the completion code' })).toBeVisible();
  expect(await popup.evaluate(() => window.opener)).toBeNull();
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
  await page.route(
    `**/api/teams/marketing/assistant-integrations/challenges/${challengeId}/authorize`,
    (route) => {
      if (route.request().method() === 'DELETE') {
        canceled = true;
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ authorization_url: authorizationUrl, completion_mode: 'code' }),
      });
    },
  );
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await dialog.getByRole('button', { name: 'Authorize on Cloudflare' }).click();
  await expect.poll(() => canceled).toBe(true);
  await expect(dialog).toContainText('The secure authorization could not start.');
});

// The exact value each kind submits; a passkey answers with its ceremony, not a typed value.
const humanValues = {
  approval: true,
  'input:text': 'Reviewed value',
  'input:textarea': 'Reviewed value',
  'input:password': 'third-party-secret',
  'input:phone': '+1 415 555 0123',
  'input:select': 'safe',
  'input:choice': 'safe',
  'input:choices': ['safe'],
  'auth:password': 'supervisor-password',
  'auth:totp': '123456',
};

const humanPresentations = [
  ['approval', 'Publish reviewed DNS changes?'],
  ['input:text', 'Provide the missing Action context'],
  ['input:textarea', 'Provide the missing Action context'],
  ['input:password', 'Provide the missing Action context'],
  ['input:phone', 'Provide the missing Action context'],
  ['input:select', 'Provide the missing Action context'],
  ['input:choice', 'Provide the missing Action context'],
  ['input:choices', 'Provide the missing Action context'],
  ['auth:password', 'Confirm with your Supervisor password'],
  ['auth:totp', 'Confirm with your TOTP code'],
  ['auth:passkey', 'Confirm with your passkey'],
];

for (const [kind, title] of humanPresentations) {
  test(`completes the ${kind} Action request with its exact value`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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
    if (kind === 'input:password') {
      await expect(dialog.getByLabel(/Cloudflare API secret/)).toHaveAttribute('type', 'password');
    } else if (kind === 'auth:password') {
      await expect(dialog.getByLabel('Supervisor password')).toHaveAttribute('type', 'password');
    }

    if (kind === 'input:text' || kind === 'input:textarea') {
      await dialog.getByLabel(/Response/).fill('Reviewed value');
    } else if (kind === 'input:password') {
      await dialog.getByLabel(/Cloudflare API secret/).fill('third-party-secret');
    } else if (kind === 'input:phone') {
      await dialog.getByLabel(/Contact phone/).fill('+1 415 555 0123');
    } else if (kind === 'input:select') {
      await dialog.getByRole('combobox').selectOption('safe');
    } else if (kind === 'input:choice') {
      await dialog.getByRole('radio', { name: /Safe mode/ }).check();
    } else if (kind === 'input:choices') {
      await dialog.getByRole('checkbox', { name: /Safe mode/ }).check();
    } else if (kind === 'auth:password') {
      await dialog.getByLabel('Supervisor password').fill('supervisor-password');
    } else if (kind === 'auth:totp') {
      await dialog.getByLabel('Verification code').fill('123456');
    }
    await dialog.getByRole('button', {
      name: kind === 'approval'
        ? 'Approve action'
        : kind === 'auth:passkey'
          ? 'Use passkey'
          : kind.startsWith('auth:') ? 'Confirm authorization' : 'Send',
    }).click();
    await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
    expect(contract.humanResponses()).toHaveLength(1);
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
  expect(contract.humanResponses()).toHaveLength(1);
  expect(contract.humanResponses()[0]).toMatchObject({ decision: 'submit', value: atLimit });
});

test('updates the Action human request countdown without a page refresh', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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

test('closes and reconciles an expired Action human request', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
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
  expect(contract.humanResponses()).toHaveLength(1);

  await validation.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
});

test('blocks Supervisor password retry behind the server countdown', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
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
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'Create the reviewed DNS record');
  await page.getByRole('button', { name: 'Send' }).click();
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
  expect(contract.humanResponses()).toHaveLength(1);
});

test('reopens the Team-owned human request when reconnect sync proves it is still pending', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    disconnectHumanResponse: true,
    humanKind: 'auth:password',
  });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'Create the reviewed DNS record');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Supervisor password').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await expect(page.getByRole('group', { name: 'I’m processing…' })).toHaveCount(0);
  contract.disconnectHumanSocket();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
  expect(contract.humanResponses()).toHaveLength(1);
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
  await routeReadyChat(page, { usage });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = page.getByRole('article', { name: 'Marketing' });
  await expect(reply).toContainText('Rendered answer');
  await expect(reply).toContainText('$0.0095');
  await expect(reply).toContainText('13,680 tokens');
  await expect(reply.getByTitle(/GPT-6 Luna: 11,900 input · 580 output/)).toHaveCount(1);
});

test('a reply whose done frame reports no usage shows no usage line', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = page.getByRole('article', { name: 'Marketing' });
  await expect(reply).toContainText('Rendered answer');
  await expect(reply).not.toContainText('tokens');
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

test('a done frame with malformed usage is refused and shows no reply', async ({ page }) => {
  await routeReadyChat(page, { usage: { duration_ms: 1, models: [] } });
  await page.goto('/chat/');
  await fillWhenReady(page, page.getByRole('textbox', { name: 'Send', exact: true }), 'List my DNS zones');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
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

test('deletes a Team with its exact confirmation and reports the deletion', async ({ page }) => {
  await routeReadyChat(page);
  let deleted = false;
  let deletionBody;
  await page.unroute('**/api/teams');
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      teams: deleted
        ? [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }]
        : [
            { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
            { team_id: 'support', team_name: 'Support', status: 'running' },
          ],
    }),
  }));
  await page.route('**/api/teams/support', async (route) => {
    deletionBody = route.request().postDataJSON();
    deleted = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        team_id: 'support',
        destroyed: true,
        assistants_removed: 0,
        residue_absent: localTeamResidues,
        storage_removed: true,
      }),
    });
  });

  await page.goto('/chat/');
  const navigation = await openTeamNavigation(page);
  await navigation.getByRole('button', { name: 'Actions for Support' }).click();
  await page.getByRole('menuitem', { name: 'Delete Team' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Team' });
  await deleteDialog.getByLabel('Confirm Team name').fill('Support');
  await deleteDialog.getByLabel('Supervisor password').fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();

  await expect(deleteDialog).toBeHidden();
  expect(deletionBody).toEqual({ team_name: 'Support', password: 'private-password' });
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Team deleted');
  await expect(toast).toContainText('Support and all of its data were securely deleted.');
});

test('a Team name of 80 emoji can be typed to rename and to confirm its deletion', async ({ page }) => {
  // Team bounds names by Unicode code points; each emoji is two UTF-16 units, so 80 of them fill 160 units.
  const longest = '😀'.repeat(80);
  await routeReadyChat(page);
  let deleted = false;
  const renames = [];
  let deletionBody;
  await page.unroute('**/api/teams');
  await page.route('**/api/teams', (route) => route.fulfill({
    json: {
      teams: [
        { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
        ...(deleted ? [] : [{ team_id: 'support', team_name: renames.length ? longest : 'Support', status: 'running' }]),
      ],
    },
  }));
  await page.route('**/api/teams/support', async (route) => {
    if (route.request().method() === 'PATCH') {
      renames.push(route.request().postDataJSON());
      return route.fulfill({ json: { team_id: 'support', team_name: route.request().postDataJSON().team_name } });
    }
    deletionBody = route.request().postDataJSON();
    deleted = true;
    return route.fulfill({
      json: {
        team_id: 'support',
        destroyed: true,
        assistants_removed: 0,
        residue_absent: localTeamResidues,
        storage_removed: true,
      },
    });
  });

  await page.goto('/chat/');
  const navigation = await openTeamNavigation(page);
  await navigation.getByRole('button', { name: 'Actions for Support' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await navigation.getByRole('textbox', { name: 'Name for Support' }).fill(longest);
  await page.keyboard.press('Enter');
  await expect(navigation.getByRole('link', { name: longest, exact: true })).toBeFocused();
  expect(renames).toEqual([{ team_name: longest }]);

  await navigation.getByRole('button', { name: `Actions for ${longest}` }).click();
  await page.getByRole('menuitem', { name: 'Delete Team' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Team' });
  await deleteDialog.getByLabel('Confirm Team name').fill(longest);
  await deleteDialog.getByLabel('Supervisor password').fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();

  await expect(deleteDialog).toBeHidden();
  expect(deletionBody).toEqual({ team_name: longest, password: 'private-password' });
});

test('reports an already-absent Store uninstall and keeps Chat usable', async ({ page }) => {
  await routeReadyChat(page);
  await routeAssistantStoreUninstall(page);
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: false }),
  }));

  await page.goto('/assistants/');
  await page.getByRole('button', { name: 'Uninstall' }).click();
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
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', async (route) => {
    committed = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: true }),
    });
  });
  await page.route('**/api/teams/marketing/assistants', (route) => {
    if (!committed) return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'inventory unavailable' }),
    });
  });

  await page.goto('/assistants/');
  await page.getByRole('button', { name: 'Uninstall' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();

  await expect(dialog).toBeHidden();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Assistant inventory needs refresh');
  await expect(toast).toContainText(
    'Shimpz Cloudflare is no longer installed in Marketing, but the current Team inventory could not be refreshed.',
  );
  await expect(toast).toContainText('Reload this page to confirm the Assistant list.');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('keeps a first Store install ready while local display metadata catches up', async ({ page }) => {
  let installed = false;
  let catalogReads = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: 'automatic' })),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    }),
  }));
  await page.route('**/api/assistants', async (route) => {
    catalogReads += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistants: installed
          ? [{
            id: 'shimpz-cloudflare',
            title: 'Shimpz Cloudflare',
          }]
          : [],
      }),
    });
  });
  await page.route('**/api/teams/marketing/assistants', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        assistant_id: 'shimpz-cloudflare',
        source_digest: `sha256:${'4'.repeat(64)}`,
      });
      installed = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ assistant: 'shimpz-cloudflare', installed: true }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistants: installed
          ? [{
            assistant: 'shimpz-cloudflare',
            assistant_version: '0.1.0',
            status: 'running',
            provenance: 'published',
          }]
          : [],
      }),
    });
  });
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));
  await page.route(/\/api\/assistant-catalog\?locale=en$/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: 1, locale: 'en',
      assistants: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_version: '0.1.0',
        creators: ['@shimpz'],
        icon_digest: `sha256:${'e'.repeat(64)}`,
        name: 'Shimpz Cloudflare',
        source_digest: `sha256:${'4'.repeat(64)}`,
        summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
      }],
    }),
  }));
  await page.route('**/api/local-assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [], trace_id: 'c'.repeat(32) }),
  }));
  await page.route('**/api/assistants/shimpz-cloudflare/catalog-icon', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));

  await page.goto('/assistants/');
  await page.getByRole('button', { name: 'Install or replace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install this Assistant?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm install' }).click();

  await expect(page.locator('[data-slot="toast"]')).toContainText(
    'Shimpz Cloudflare is ready in Marketing.',
  );
  await expect(page.getByText('The installed Assistant inventory is invalid.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Uninstall' })).toBeVisible();
  expect(catalogReads).toBeGreaterThanOrEqual(2);
});

test('the ready Chat passes its accessibility scan and the Brain chooser works by keyboard', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');

  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  // The Chat screen's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);

  const brainTrigger = page.getByRole('button', { name: /^Brain: / });
  await expect(brainTrigger).toHaveAccessibleName('Brain: GPT-6.1 Sol, Low reasoning');
  await brainTrigger.click();
  const brainPanel = page.getByRole('dialog', { name: 'Brain settings' });
  await expect(brainPanel).toBeVisible();
  const models = brainPanel.getByRole('group', { name: 'Model' });
  await expect(models.getByRole('button', { name: /GPT-6.1 Sol/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(models.getByRole('button', { name: /GPT-6.1 Sol/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(brainPanel).toBeHidden();
  await expect(brainTrigger).toBeFocused();

  const effortTrigger = page.getByRole('button', { name: /^Reasoning effort/ });
  await expect(effortTrigger).toHaveAccessibleName('Reasoning effort: Low');
  await effortTrigger.click();
  const effortPanel = page.getByRole('dialog', { name: 'Reasoning effort' });
  const effort = effortPanel.getByRole('radiogroup', { name: 'Reasoning effort' });
  await expect(effort.getByRole('radio', { name: 'Low' })).toHaveAttribute('aria-checked', 'true');
  await expect(effort.getByRole('radio', { name: 'Low' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => chat.inferenceBodies().at(-1)).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' });
  await expect(effort.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  await expect(effort.getByRole('radio', { name: 'Medium' })).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => chat.inferenceBodies().at(-1)?.effort).toBe('high');
  await expect(brainTrigger).toHaveAccessibleName('Brain: GPT-6.1 Sol, High reasoning');
  await expect(effortTrigger).toHaveAccessibleName('Reasoning effort: High');
  await page.keyboard.press('Escape');
  await expect(effortPanel).toBeHidden();
  await expect(effortTrigger).toBeFocused();

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'You' })).toContainText('Show the rendered response');
});

test('opens a Team chat from the Team list and its Store from the row icon', async ({ page }) => {
  await routeReadyChat(page);
  await page.unroute('**/api/teams');
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [
      { team_id: 'marketing', team_name: 'Marketing', status: 'running' },
      { team_id: 'support', team_name: 'Support', status: 'running' },
    ] }),
  }));
  await page.route('**/api/teams/support/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [] }),
  }));
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
  // A Local Team menu opens on Rename; a Team without Routines offers no Routines item, and the last Team's disabled
  // Move down is skipped.
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Delete Team' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Routines' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Delete Team' })).toBeHidden();
  await expect(actions).toBeFocused();
});

test('opens the mobile Team list as a modal drawer and restores focus', async ({ page }, testInfo) => {
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

test('names every running Assistant beyond the chat limit and sends exactly the limit', async ({ page }) => {
  const chat = await routeReadyChat(page);
  const ids = Array.from({ length: 18 }, (_value, index) => `helper-${String(index).padStart(2, '0')}`);
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: ids.map((id, index) => ({ id, title: `Helper ${index}` })),
    }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: ids.map((assistant) => ({
        assistant,
        assistant_version: '1.0.0',
        status: 'running',
        provenance: 'published',
      })),
    }),
  }));
  await page.goto('/chat/');

  const notice = page.locator('.assistant-overflow');
  await expect(notice).toContainText('more running Assistants than one conversation can use (16)');
  await expect(notice).toContainText('Helper 16, Helper 17');
  await expect(notice.getByRole('link', { name: 'Open the Store' })).toHaveAttribute('href', '/assistants/?team=marketing');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Check the scope');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  expect(chat.chatFrames()[0].assistant_ids).toEqual(ids.slice(0, 16));
});

test('Escape during an effort save returns focus to the trigger once it is enabled again', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdInferenceWrite: true });
  await page.goto('/chat/');
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const trigger = page.getByRole('button', { name: /^Reasoning effort/ });
  await trigger.click();
  await page.getByRole('dialog', { name: 'Reasoning effort' }).getByRole('radio', { name: 'High' }).click();
  await expect.poll(chat.inferenceWrites).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Reasoning effort' })).toBeHidden();
  await expect(trigger).toBeDisabled();

  chat.releaseInferenceWrite();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test('holds Send while a Brain change is saving so the turn uses the saved selection', async ({ page }) => {
  const chat = await routeReadyChat(page, { holdInferenceWrite: true });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'Use the new effort');
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled();

  await page.getByRole('button', { name: /^Reasoning effort/ }).click();
  await page.getByRole('dialog', { name: 'Reasoning effort' }).getByRole('radio', { name: 'High' }).click();
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
  expect(chat.inferenceBodies()).toEqual([{ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' }]);
});


// A held run's card as Team opens it (ADR-0092 section 7): the step, its recorded failure (a Cloudflare account out of
// credits), and exactly Rodar, Recriar, and Excluir.
const CREDITS_MESSAGE = "Client error '402 Payment Required' for url 'https://api.cloudflare.com/client/v4/zones/[REDACTED]'";

function recoveryCard(incidentId, { nonce = 'f'.repeat(32), action = 'replace-dns-record', failure = {} } = {}) {
  return {
    team_id: 'marketing',
    incident_id: incidentId,
    routine_id: ROUTINE_VIEW.routine_id,
    revision: 1,
    assistant_id: 'shimpz-cloudflare',
    action,
    step: 2,
    steps: 3,
    evidence: 'recorded',
    diagnostic: {
      operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
      attempt: 1,
      assistant_id: 'shimpz-cloudflare',
      action,
      recorded_at: '2026-10-01T12:01:05Z',
      failure: {
        error_type: 'httpx.HTTPStatusError',
        message: CREDITS_MESSAGE,
        provider: 'api.cloudflare.com',
        http_status: 402,
        response_excerpt: null,
        redacted: true,
        truncated: false,
        ...failure,
      },
      condition: null,
    },
    nonce,
    expires_in: 300,
    choices: ['run', 'recreate', 'delete'],
  };
}

// Admin's deletion ceremony (ADR-0051): the Supervisor password first, then one six-digit code; `000000` is wrong.
const SUPERVISOR_PASSWORD = 'correct supervisor passphrase';

async function routeRoutines(
  page,
  {
    others = [],
    listFailsAfterDelete = false,
    runEnding = false,
    held = true,
    lockAfter = 0,
    passkey = false,
    refuseRecreate = false,
  } = {},
) {
  const calls = { begins: [], deletes: [], stops: [], resumes: [], pauses: [], answers: [] };
  let rejected = 0;
  // The Routine is paused, and unless told otherwise an earlier run of it is held for recovery (ADR-0092).
  let routines = [{ ...ROUTINE_VIEW, paused: true }, ...others];
  let runs = [];
  let incidents = held ? [
    {
      incident_id: 'b'.repeat(32),
      routine_id: ROUTINE_VIEW.routine_id,
      quote: ROUTINE_VIEW.quote,
      created_at: '2026-09-30T12:01:07Z',
      assistant_id: 'shimpz-cloudflare',
      action: 'replace-dns-record',
    },
  ] : [];
  await page.route('**/api/teams/marketing/routines', async (route) => {
    if (listFailsAfterDelete && calls.deletes.length > 0) {
      await route.fulfill({ status: 503, json: { code: 'team-unavailable' } });
      return;
    }
    await route.fulfill({ json: { team_id: 'marketing', routines, runs, incidents } });
  });
  await page.route('**/api/teams/marketing/routines/*/resume', async (route) => {
    const routineId = new URL(route.request().url()).pathname.split('/').at(-2);
    calls.resumes.push(route.request().postDataJSON());
    routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, paused: false } : routine));
    await route.fulfill({ json: { team_id: 'marketing', routine_id: routineId, paused: false } });
  });
  await page.route('**/api/teams/marketing/routines/*/pause', async (route) => {
    const routineId = new URL(route.request().url()).pathname.split('/').at(-2);
    calls.pauses.push(route.request().postDataJSON());
    routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, paused: true } : routine));
    await route.fulfill({ json: { team_id: 'marketing', routine_id: routineId, paused: true } });
  });
  await page.route('**/api/teams/marketing/routines/*/deletion', async (route) => {
    const { password } = route.request().postDataJSON();
    calls.begins.push(route.request().method());
    if (password === SUPERVISOR_PASSWORD && !(lockAfter && rejected >= lockAfter)) {
      const offer = passkey ? { methods: ['totp', 'passkey'], passkey_options: { challenge: 'Y2hhbGxlbmdl', allowCredentials: [], rpId: 'localhost', timeout: 180000, userVerification: 'required' } } : { methods: ['totp'] };
      await route.fulfill({ status: 202, json: offer });
      return;
    }
    rejected += password === SUPERVISOR_PASSWORD ? 0 : 1;
    if (lockAfter && rejected >= lockAfter) {
      await route.fulfill({ status: 429, json: { code: 'authentication-locked', retry_after: 42 } });
      return;
    }
    await route.fulfill({ status: 401, json: { code: 'password-incorrect' } });
  });
  await page.route(/\/api\/teams\/marketing\/routines\/[0-9a-f]{32}$/, async (route) => {
    const routineId = new URL(route.request().url()).pathname.split('/').at(-1);
    const proof = route.request().postDataJSON();
    calls.deletes.push(proof);
    if (proof.code === '000000') {
      await route.fulfill({ status: 401, json: { code: 'code-incorrect' } });
      return;
    }
    // While a run is still ending, Team keeps the Routine as deleting and answers false.
    routines = runEnding
      ? routines.map((routine) => (routine.routine_id === routineId ? { ...routine, deleting: true } : routine))
      : routines.filter((routine) => routine.routine_id !== routineId);
    // Deleting a Routine sets its held runs aside (ADR-0092).
    incidents = incidents.filter((item) => item.routine_id !== routineId);
    await route.fulfill({ json: { team_id: 'marketing', routine_id: routineId, deleted: !runEnding } });
  });
  await page.route('**/api/teams/marketing/routines/runs/*/stop', async (route) => {
    const [, runId] = new URL(route.request().url()).pathname.match(/runs\/([0-9a-f]{32})\/stop$/);
    calls.stops.push(route.request().postDataJSON());
    runs = runs.filter((item) => item.run_id !== runId);
    await route.fulfill({ json: { team_id: 'marketing', run_id: runId, stopped: true } });
  });
  // The held run's card. Rodar and Recriar set the run aside and lift the pause, unless Recriar is refused.
  await page.route('**/api/teams/marketing/routines/incidents/*/card', async (route) => {
    const incidentId = new URL(route.request().url()).pathname.split('/').at(-2);
    await route.fulfill({ json: recoveryCard(incidentId) });
  });
  await page.route('**/api/teams/marketing/routines/incidents/*/answer', async (route) => {
    const incidentId = new URL(route.request().url()).pathname.split('/').at(-2);
    const answer = route.request().postDataJSON();
    calls.answers.push(answer);
    if (answer.choice === 'recreate' && refuseRecreate) {
      await route.fulfill({ status: 422, json: { code: 'routine-recreate-refused' } });
      return;
    }
    incidents = incidents.filter((item) => item.incident_id !== incidentId);
    routines = routines.map((routine) => ({ ...routine, paused: false }));
    const status = answer.choice === 'run' ? 'requested' : 'recreated';
    await route.fulfill({ json: { team_id: 'marketing', incident_id: incidentId, choice: answer.choice, status } });
  });
  return calls;
}

test('a Local Team is renamed in place: Enter saves by id, Escape keeps the name, a refusal keeps editing', async ({ page }) => {
  await routeScenario(page, 'ready');
  const renames = [];
  let refuse = false;
  await page.route('**/api/teams/marketing', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    renames.push(route.request().postDataJSON());
    if (refuse) return route.fulfill({ status: 409, json: { detail: 'Another Team already has this name.' } });
    return route.fulfill({ json: { team_id: 'marketing', team_name: route.request().postDataJSON().team_name } });
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
  expect(renames).toEqual([{ team_name: 'Growth Marketing' }]);

  refuse = true;
  let releaseRefusal;
  const refusalHeld = new Promise((resolve) => { releaseRefusal = resolve; });
  await page.route('**/api/teams/marketing', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await refusalHeld;
    return route.fallback();
  });
  await navigation.getByRole('button', { name: 'Actions for Growth Marketing' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const again = navigation.getByRole('textbox', { name: 'Name for Growth Marketing' });
  await again.fill('Sales');
  await page.keyboard.press('Enter');
  // While the name is saving, the field keeps focus but cannot be edited, so no later draft is silently lost.
  await expect(again).toHaveAttribute('readonly', '');
  releaseRefusal();
  await expect(page.getByText('Another Team already has this name.')).toBeVisible();
  await expect(again).not.toHaveAttribute('readonly', '');
  await expect(again).toBeFocused();
  await expect(again).toHaveValue('Sales');
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
    await page.route('**/api/teams/order', (route) => {
      orders.push(route.request().postDataJSON());
      return route.fallback();
    });
    await page.goto(`/chat/?team=${team}`);
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
    const navigation = await openTeamNavigation(page);
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    return { navigation, orders };
  }

  // Presses the handle, moves past the drag threshold onto the target row's upper half, and optionally cancels.
  async function mouseDrag(page, navigation, name, target, { escape = false } = {}) {
    await navigation.getByRole('link', { name, exact: true }).hover();
    const handle = (await navigation.getByTitle(`Drag to reorder ${name}`).boundingBox());
    const goal = await navigation.getByRole('link', { name: target, exact: true }).boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, goal.y + 4, { steps: 8 });
    if (escape) await page.keyboard.press('Escape');
    await page.mouse.up();
  }

  test('dragging a Team by its handle reorders it, saves the exact order, and keeps it across a reload', async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    // A press on the handle that never moves is not a drag.
    const handle = navigation.getByTitle('Drag to reorder Neo');
    await navigation.getByRole('link', { name: 'Neo', exact: true }).hover();
    const box = await handle.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(orders).toEqual([]);

    await mouseDrag(page, navigation, 'Smith', 'Trinity');
    const moved = ['Marketing', 'Smith', 'Trinity', 'Cypher', 'Morpheus', 'Neo'];
    await expect.poll(() => teamNames(navigation)).toEqual(moved);
    await expect.poll(() => orders).toEqual([{ team_ids: moved.map(ID) }]);
    // The drop never doubles as a click: the selected Team and page stay the same.
    await expect(page).toHaveURL(/\/chat\/?\?team=marketing$/);

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeVisible();
    await expect.poll(async () => teamNames(await openTeamNavigation(page))).toEqual(moved);
  });

  test('a touch drag on the handle reorders, while Escape cancels a drag without saving', async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    await mouseDrag(page, navigation, 'Neo', 'Trinity', { escape: true });
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    // Escape ended only the drag; on a phone the Team drawer stays open.
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toBeVisible();
    expect(orders).toEqual([]);

    const cdp = await page.context().newCDPSession(page);
    const handle = await navigation.getByTitle('Drag to reorder Cypher').boundingBox();
    const goal = await navigation.getByRole('link', { name: 'Trinity', exact: true }).boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step += 1) {
      const point = { x, y: y + (goal.y + 4 - y) * (step / 8) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const moved = ['Marketing', 'Cypher', 'Trinity', 'Morpheus', 'Neo', 'Smith'];
    await expect.poll(() => teamNames(navigation)).toEqual(moved);
    await expect.poll(() => orders).toEqual([{ team_ids: moved.map(ID) }]);
  });

  test('Move up and Move down reorder from the keyboard, announce the place, and keep focus on the Team', async ({ page }) => {
    const { navigation, orders } = await openOrder(page);
    const actions = navigation.getByRole('button', { name: 'Actions for Neo' });
    await actions.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeFocused();
    await page.keyboard.press('Enter');

    const moved = ['Marketing', 'Trinity', 'Cypher', 'Neo', 'Morpheus', 'Smith'];
    await expect.poll(() => teamNames(navigation)).toEqual(moved);
    await expect(actions).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Neo moved to position 4 of 6' })).toHaveCount(1);
    await expect.poll(() => orders).toEqual([{ team_ids: moved.map(ID) }]);

    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    await expect(actions).toBeFocused();
    await expect.poll(() => orders.length).toBe(2);

    // The boundaries cannot move further.
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await navigation.getByRole('button', { name: 'Actions for Smith' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(orders).toHaveLength(2);
  });

  test('a refused save restores only the order and keeps the selected Team', async ({ page }) => {
    const { navigation, orders } = await openOrder(page, 'reorder-unavailable', 'neo');
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toHaveAttribute('aria-current', 'page');
    await navigation.getByRole('button', { name: 'Actions for Smith' }).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();

    await expect(page.getByText('The Team order could not be saved. The previous order is back.')).toBeVisible();
    await expect.poll(() => teamNames(navigation)).toEqual(READY_ORDER);
    expect(orders).toEqual([{ team_ids: ['marketing', 'trinity', 'cypher', 'morpheus', 'smith', 'neo'] }]);
    await expect(navigation.getByRole('link', { name: 'Neo', exact: true })).toHaveAttribute('aria-current', 'page');

    // The next save goes through.
    await navigation.getByRole('button', { name: 'Actions for Smith' }).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await expect.poll(() => orders.length).toBe(2);
    await expect.poll(() => teamNames(navigation)).toEqual(['Marketing', 'Trinity', 'Cypher', 'Morpheus', 'Smith', 'Neo']);
  });

  test('a save refused because the Teams changed reloads the list', async ({ page }) => {
    const { navigation, orders } = await openOrder(page, 'reorder-conflict');
    await mouseDrag(page, navigation, 'Smith', 'Trinity');
    await expect(page.getByText('The Teams changed while you were reordering. The list was reloaded; try again.')).toBeVisible();
    await expect.poll(() => teamNames(navigation)).toEqual(['Oracle', ...READY_ORDER]);
    expect(orders).toHaveLength(1);
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
    await navigation.getByRole('link', { name: 'Neo', exact: true }).hover();
    const handle = await navigation.getByTitle('Drag to reorder Neo').boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
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

  test('Hosted offers no reordering', async ({ page }) => {
    await routeReadyChat(page, { hostedSession: true });
    await page.route('**/api/teams', (route) => route.fulfill({
      json: { teams: [TEAMS[0], TEAMS[1]] },
    }));
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('link', { name: 'Trinity', exact: true })).toBeVisible();
    await expect(navigation.getByTitle(/^Drag to reorder/)).toHaveCount(0);
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete Team' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Move / })).toHaveCount(0);
  });
});

test.describe('Team Routines', () => {
  test.use({ timezoneId: 'America/Sao_Paulo' });

  test('a Routine asked for in chat is created at once, announced, and joins the Team list', async ({ page }) => {
    await routeScenario(page, 'ready');
    await page.goto('/chat/?team=marketing');
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await fillWhenReady(page, composer, 'Every day at 9, list my DNS zones');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Done: this Routine runs every day at 09:00.')).toBeVisible();
    // There is no confirmation card: the user's own message created the Routine (ADR-0092).
    await expect(page.getByRole('region', { name: 'Routine proposal' })).toHaveCount(0);

    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await page.getByRole('menuitem', { name: 'Routines' }).click();
    const item = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: /Daily DNS zones/ });
    await expect(item).toHaveCount(1);
    // Its panel shows the plan: each step's Assistant and Action, and its saved keys by name only.
    await item.click();
    const panel = page.getByRole('dialog', { name: 'Daily DNS zones' });
    await panel.getByRole('tab', { name: 'Steps' }).click();
    const steps = panel.getByRole('list', { name: 'Steps' });
    await expect(steps).toContainText('List zones');
    await expect(steps).toContainText('api-token');
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    // The created notice is an entry of the Team's transcript, with the browser's timezone the message was sent with
    // and its steps named by Assistant.
    await page.reload();
    const created = page.locator('.routine-run').filter({ hasText: 'Daily DNS zones' });
    await expect(created).toHaveAccessibleName('Daily DNS zones');
    await expect(created).toContainText('created');
    await expect(created).toContainText('America/Sao_Paulo');
    await expect(created).toContainText('Shimpz Cloudflare · List zones');
    await expect(created.getByRole('button')).toHaveCount(0);
  });

  test('a Team\'s own Routines button opens its list in a modal from pointer or keyboard and says when one needs attention', async ({ page }) => {
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

  test('a Team whose Routines are all running needs no attention, and a Team without Routines has no Routines button', async ({ page }) => {
    await routeReadyChat(page);
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] },
    }));
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await expect(navigation.getByRole('button', { name: 'Routines for Marketing', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: /needs your attention/ })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: /^Routines for (?!Marketing)/ })).toHaveCount(0);
  });

  test('a Routine opens in a panel from the keyboard: it resumes, pauses, shows its runs, and is deleted after a confirmation', async ({ page }) => {
    const failed = 'c'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [{
          id: `${failed}:routine`,
          kind: 'routine-run',
          notice_id: failed,
          routine_id: ROUTINE_VIEW.routine_id,
          quote: ROUTINE_VIEW.quote,
          run_id: failed,
          outcome: 'failed',
          created_at: '2026-10-01T12:01:07Z',
          detail: { code: 'assistant-rpc-failed', actions: [] },
          version: 1,
        }],
        before: null,
      },
    });
    // The refresh after the deletion fails; the confirmed deletion must still leave the list.
    const calls = await routeRoutines(page, { listFailsAfterDelete: true, held: false });
    const diagnostics = [];
    await page.route('**/api/teams/marketing/routines/runs/*/diagnostics', async (route) => {
      diagnostics.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { team_id: 'marketing', run_id: failed, diagnostics: [] } });
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
    await expect(panel).toContainText(ROUTINE_VIEW.quote);
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
    await expect(panel).toContainText(ROUTINE_VIEW.quote);
    // Escape and Back each return to the Team's list, focused on the Routine the panel was opened from.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(item).toBeFocused();
    await item.click();
    await panel.getByRole('button', { name: 'Back to Routines' }).click();
    await expect(panel).toHaveCount(0);
    await expect(item).toBeFocused();
    await item.click();

    // Resume turns dispatch back on, and Pause turns it off again.
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(calls.resumes).toEqual([{}]);
    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(calls.pauses).toEqual([{}]);

    // A recent run, on the Runs page, opens its execution details.
    await panel.getByRole('tab', { name: 'Runs' }).click();
    await panel.getByRole('button', { name: 'Execution details' }).click();
    const details = page.getByRole('dialog', { name: 'Execution details' });
    await expect(details).toContainText('No failed attempts were recorded for this run.');
    expect(diagnostics).toEqual([`/api/teams/marketing/routines/runs/${failed}/diagnostics`]);
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
    expect(calls.begins).toEqual(['POST', 'POST', 'POST']);
    expect(calls.deletes).toEqual([{ code: '000000' }, { code: '123456' }]);
    // With no Routines left, focus returns to the Team's actions, whose menu no longer offers Routines.
    await expect(navigation.getByRole('button', { name: 'Actions for Marketing' })).toBeFocused();
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await expect(page.getByRole('menuitem', { name: 'Routines' })).toHaveCount(0);
  });

  test('a Routine whose run is still ending stays listed as being deleted', async ({ page }) => {
    await routeReadyChat(page);
    const calls = await routeRoutines(page, { runEnding: true, held: false });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    await list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Delete' }).click();
    await panel.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await panel.getByLabel('Six-digit code').fill('123456');
    await panel.getByRole('button', { name: 'Delete' }).click();
    await expect(panel).toContainText('Being deleted');
    await expect(panel.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    expect(calls.deletes).toEqual([{ code: '123456' }]);
  });

  test('a Routine deletion shows the shared sign-in lockout and deletes nothing', async ({ page }) => {
    await routeReadyChat(page);
    const calls = await routeRoutines(page, { held: false, lockAfter: 2 });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
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
    expect(calls.deletes).toEqual([]);
  });

  test('a Routine deletion in flight cannot be dismissed, and a passkey the browser cancels deletes nothing', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.credentials.get = () => Promise.reject(new DOMException('canceled', 'NotAllowedError'));
    });
    await routeReadyChat(page);
    const calls = await routeRoutines(page, { held: false, passkey: true });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(/\/api\/teams\/marketing\/routines\/[0-9a-f]{32}$/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    const list = page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' });
    await list.getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
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
    expect(calls.begins).toEqual(['POST']);
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
    expect(calls.deletes).toEqual([{ code: '123456' }]);
  });

  async function openHeldPanel(page, options = {}) {
    await routeReadyChat(page);
    const calls = await routeRoutines(page, options);
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    return { calls, panel: page.getByRole('dialog', { name: ROUTINE_VIEW.name }) };
  }

  test('a Routine waiting for a recovery decision shows the step\'s error and returns to its pages once run', async ({ page }) => {
    const { calls, panel } = await openHeldPanel(page);
    // The whole panel is the decision: where the run stopped, the error the step returned and its likely cause, and
    // exactly the card's three choices, each saying what it does before it is chosen.
    const choices = panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button');
    await expect.poll(() => choices.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
      .toEqual(['Run', 'Recreate', 'Delete']);
    await expect(panel).toContainText('step 2 of 3');
    await expect(panel).toContainText('Replace DNS record');
    await panel.getByText('See the technical error').click();
    await expect(panel.locator('.error-text')).toHaveText(CREDITS_MESSAGE);
    await expect(panel).toContainText('HTTP 402 · api.cloudflare.com');
    await expect(panel).toContainText('out of credits');
    await expect(panel).toContainText('What it already did may repeat.');
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    expect(calls.answers).toEqual([]);
    expect(await accessibilityViolations(page)).toEqual([]);
    // Run answers that card once; the panel goes back to its pages and says what the answer did.
    await panel.getByRole('button', { name: 'Run' }).click();
    await expect(panel.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('status')).toContainText('Set aside. The Routine runs again now.');
    expect(calls.answers).toEqual([{ nonce: 'f'.repeat(32), choice: 'run' }]);
  });

  test('Recreate rebuilds the Routine, and a refused Recreate changes nothing and offers a fresh card', async ({ page }) => {
    const { calls, panel } = await openHeldPanel(page, { refuseRecreate: true });
    const choices = panel.getByRole('group', { name: 'Recovery choices' });
    await choices.getByRole('button', { name: 'Recreate' }).click();
    await expect(panel.getByRole('status')).toHaveText(
      'Your original request could not be made into this Routine again. Nothing changed; ask for it again in the chat.',
    );
    // The decision stays: a fresh card opens for the next answer.
    await expect(choices.getByRole('button')).toHaveCount(3);
    expect(calls.answers).toEqual([{ nonce: 'f'.repeat(32), choice: 'recreate' }]);
  });

  test('Delete in a decision opens the deletion confirmation, Cancel returns to the decision, and confirming deletes', async ({ page }) => {
    const { calls, panel } = await openHeldPanel(page);
    // Until it is answered, nothing else is offered: no pages and no Routine actions besides Back, Close, and the
    // card's own.
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(5);
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete “${ROUTINE_VIEW.name}”?` });
    const password = confirm.getByLabel('Supervisor password');
    await expect(password).toBeFocused();
    await expect(confirm.getByRole('button')).toHaveText(['Cancel', 'Delete']);
    expect(await accessibilityViolations(page)).toEqual([]);
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
    expect(calls.deletes).toEqual([{ code: '123456' }]);
    expect(calls.answers).toEqual([]);
  });

  test('a Routine waiting for an approval is that decision in its panel, and a run held after approval asks again', async ({ page }) => {
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    let runs = [{
      run_id: run,
      routine_id: ROUTINE_VIEW.routine_id,
      status: 'frozen',
      scheduled_at: '2026-10-01T12:00:00Z',
      request_kind: 'human',
      assistant_id: 'shimpz-cloudflare',
      action: 'replace-dns-record',
    }];
    let incidents = [];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents },
    }));
    await page.route('**/api/teams/marketing/routines/runs/*/challenge', (route) => route.fulfill({
      json: {
        team_id: 'marketing',
        run_id: run,
        status: 'human-required',
        challenge: {
          type: 'human-required',
          challenge_id: 'b'.repeat(32),
          expires_in: 300,
          assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
          action: { id: 'replace-dns-record', summary: 'Replace one reviewed DNS record.' },
          ...localizedChallenge(humanRequest('approval')),
        },
      },
    }));
    // Approving resumes the run, which Team then holds at a step whose effect is unknown.
    await page.route(`**/api/teams/marketing/routines/runs/${run}/human`, async (route) => {
      runs = [{ ...runs[0], status: 'held', request_kind: null, assistant_id: null, action: null }];
      incidents = [{
        incident_id: run,
        routine_id: ROUTINE_VIEW.routine_id,
        quote: ROUTINE_VIEW.quote,
        created_at: '2026-10-01T12:01:07Z',
        assistant_id: 'shimpz-cloudflare',
        action: 'replace-dns-record',
      }];
      await route.fulfill({ json: { team_id: 'marketing', run_id: run, status: 'held' } });
    });
    await page.route('**/api/teams/marketing/routines/incidents/*/card', (route) => route.fulfill({
      json: recoveryCard(run, { nonce: 'e'.repeat(32) }),
    }));
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await expect(panel).toContainText('Waiting for your approval of Replace DNS record');
    // Review is the one action besides going back to the list and closing the panel.
    await expect(panel.getByRole('button')).toHaveCount(3);
    await panel.getByRole('button', { name: 'Review' }).click();
    await page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' }).getByRole('button', { name: 'Approve action' }).click();
    // The same run, now held, opens its recovery decision instead of leaving the panel without one.
    const choices = panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button');
    await expect.poll(() => choices.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))))
      .toEqual(['Run', 'Recreate', 'Delete']);
  });

  test('a held run listed before its incident keeps Retry in its panel until the card opens', async ({ page }) => {
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    const runs = [{ run_id: run, routine_id: ROUTINE_VIEW.routine_id, status: 'held', scheduled_at: '2026-10-01T12:00:00Z', request_kind: null, assistant_id: null, action: null }];
    let incidents = [];
    const openings = [];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents },
    }));
    await page.route('**/api/teams/marketing/routines/incidents/*/card', async (route) => {
      openings.push(route.request().url());
      // Team has not indexed the incident at the first opening; it is listed from then on.
      if (openings.length === 1) {
        incidents = [{ incident_id: run, routine_id: ROUTINE_VIEW.routine_id, quote: ROUTINE_VIEW.quote, created_at: '2026-10-01T12:01:07Z', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }];
        await route.fulfill({ status: 404, json: { code: 'routine-incident-unavailable' } });
        return;
      }
      await route.fulfill({ json: recoveryCard(run, { nonce: 'e'.repeat(32) }) });
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    // The decision is not dismissed: it waits for the person to try again, never reopening on its own.
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button')).toHaveCount(3);
    expect(openings).toHaveLength(2);
  });

  test('an answer that arrives after its Routine moved on never dismisses the newer decision', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    await routeReadyChat(page);
    const run = 'd'.repeat(32);
    let runs = [{ run_id: run, routine_id: ROUTINE_VIEW.routine_id, status: 'held', scheduled_at: '2026-10-01T12:00:00Z', request_kind: null, assistant_id: null, action: null }];
    let incidents = [{ incident_id: run, routine_id: ROUTINE_VIEW.routine_id, quote: ROUTINE_VIEW.quote, created_at: '2026-10-01T12:01:07Z', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }];
    let release;
    const answered = new Promise((resolve) => { release = resolve; });
    const openings = [];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents },
    }));
    await page.route('**/api/teams/marketing/routines/incidents/*/card', async (route) => {
      openings.push(route.request().url());
      await route.fulfill({ json: recoveryCard(run, { nonce: 'e'.repeat(32) }) });
    });
    // Rodar starts a fresh run, which freezes for an approval that the Team lists before the answer itself is
    // delivered.
    await page.route('**/api/teams/marketing/routines/incidents/*/answer', async (route) => {
      runs = [{ ...runs[0], status: 'frozen', request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }];
      incidents = [];
      await answered;
      await route.fulfill({ json: { team_id: 'marketing', incident_id: run, choice: 'run', status: 'requested' } });
    });
    await page.goto('/chat/?team=marketing');
    await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' }).getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Run' }).click();
    await page.clock.fastForward(15_000);
    await expect(panel.getByRole('button', { name: 'Review' })).toBeVisible();
    release();
    // The late answer belonged to the held decision; the approval it led to stays in front of the person.
    await page.clock.fastForward(1_000);
    await expect(panel.getByRole('button', { name: 'Review' })).toBeVisible();
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    expect(openings).toHaveLength(1);
  });

  test('deleting one of several Routines returns to the Team\'s list of the others, which then returns focus to its button', async ({ page }) => {
    await routeReadyChat(page);
    const weekly = { ...ROUTINE_VIEW, routine_id: 'c'.repeat(32), name: 'Certificate check', quote: 'Every Monday, check my certificates' };
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

  test('a Team\'s Routine list is searched by similar text and paged three at a time', async ({ page }) => {
    await routeReadyChat(page);
    const routine = (digit, name) => ({ ...ROUTINE_VIEW, routine_id: digit.repeat(32), name, quote: name });
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
    expect(await accessibilityViolations(page)).toEqual([]);
  });

  test('Routine outcomes appear in the transcript, apart from the conversation', async ({ page }) => {
    const run = 'b'.repeat(32);
    const entry = (id, outcome, detail, runId = id) => ({
      id: `${id}:routine`,
      kind: 'routine-run',
      notice_id: id,
      routine_id: 'a'.repeat(32),
      quote: 'Every day at 9, list my DNS zones',
      run_id: runId,
      outcome,
      created_at: '2026-10-01T12:01:07Z',
      detail,
      version: 1,
    });
    await routeReadyChat(page, {
      history: {
        entries: [
          entry('f'.repeat(32), 'skipped', { missed: 2 }, null),
          entry('c'.repeat(32), 'failed', { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']] }),
          entry('d'.repeat(32), 'frozen', { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }),
          entry(run, 'done', { actions: [['shimpz-cloudflare', 'list-zones']] }),
        ],
        before: null,
      },
    });
    await page.goto('/chat/?team=marketing');
    const transcript = page.locator('.routine-run');
    await expect(transcript).toHaveCount(4);
    // Each notice names its Routine, says what happened in a short status, and adds one line of detail.
    await expect(transcript.nth(0)).toContainText('missed runs');
    await expect(transcript.nth(0)).toContainText('2 scheduled runs did not happen');
    await expect(transcript.nth(1)).toContainText('failed');
    await expect(transcript.nth(1)).toContainText('assistant-rpc-failed');
    await expect(transcript.nth(1)).toContainText('Shimpz Cloudflare · List zones');
    await expect(transcript.nth(2)).toContainText('awaiting approval');
    await expect(transcript.nth(2)).toContainText('Shimpz Cloudflare · Replace DNS record');
    for (const index of [0, 1, 2]) await expect(transcript.nth(index)).toContainText('Every day at 9, list my DNS zones');
    // Without a listed Routine, a row is named by the request it came from.
    await expect(transcript.nth(3)).toHaveAccessibleName('Every day at 9, list my DNS zones');
    // A done row names the Actions the run carried out, never a model reply.
    await expect(transcript.nth(3)).toContainText('done');
    await expect(transcript.nth(3)).toContainText('Shimpz Cloudflare · List zones');
    // A row whose Routine Team does not list offers no action, not even its panel.
    await expect(transcript.getByRole('button')).toHaveCount(0);
  });

  test('a Routine notice shows every name it carries as literal text, never as a link, image, or element', async ({ page }) => {
    // A request may be longer than a name, whose 80 characters still fit every kind of markup it could imitate.
    const hostile = '[x](https://evil.test) ![i](https://evil.test/a.png) <img src=x onerror=alert(1)> **b**';
    const name = '[x](https://e.test) ![i](https://e.test/a.png) <img src=x onerror=alert(1)>**b**';
    const listed = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name };
    const row = (id, routineId, outcome, detail, runId = id) => ({
      id: `${id}:routine`,
      kind: 'routine-run',
      notice_id: id,
      routine_id: routineId,
      quote: hostile,
      run_id: runId,
      outcome,
      created_at: '2026-10-01T12:01:07Z',
      detail,
      version: 1,
    });
    await routeReadyChat(page, {
      history: {
        entries: [
          // Named by its own definition, by Team's list, and by its request.
          row('b'.repeat(32), 'a'.repeat(32), 'created', {
            name, steps: ROUTINE_VIEW.steps, schedule: ROUTINE_VIEW.schedule, timezone: 'America/Sao_Paulo',
          }, null),
          row('c'.repeat(32), listed.routine_id, 'failed', { code: 'assistant-rpc-failed', actions: [['shimpz-cloudflare', 'list-zones']] }),
          row('d'.repeat(32), 'f'.repeat(32), 'done', { actions: [['shimpz-cloudflare', 'list-zones']] }),
        ],
        before: null,
      },
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [listed], runs: [], incidents: [] },
    }));
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto('/chat/?team=marketing');
    const notices = page.locator('.routine-run');
    await expect(notices).toHaveCount(3);
    for (const [index, shown] of [name, name, hostile].entries()) {
      const notice = notices.nth(index);
      await expect(notice).toContainText(shown);
      await expect(notice.getByRole('link')).toHaveCount(0);
      await expect(notice.getByRole('img')).toHaveCount(0);
      await expect(notice.getByRole('heading')).toHaveCount(0);
      await expect(notice.locator('a, img, script, iframe, em, strong')).toHaveCount(0);
      // The name is the notice's own name, whatever markup it imitates.
      await expect(notice).toHaveAccessibleName(shown);
    }
    expect(dialogs).toEqual([]);
    expect(requests.filter((url) => /e(?:vil)?\.test/u.test(url))).toEqual([]);
  });

  // A Routine row of the transcript (ADR-0086), for one listed Routine.
  function routineRow(id, outcome, detail, { routine = ROUTINE_VIEW, version = 1 } = {}) {
    return {
      id: `${id}:routine`,
      kind: 'routine-run',
      notice_id: id,
      routine_id: routine.routine_id,
      quote: routine.quote,
      run_id: id,
      outcome,
      created_at: '2026-10-01T12:01:07Z',
      detail,
      version,
    };
  }

  // An unresolved incident that holds a run of `routine` for recovery (ADR-0092); it shares the run's id.
  function heldIncident(id, routine = ROUTINE_VIEW) {
    return {
      incident_id: id,
      routine_id: routine.routine_id,
      quote: routine.quote,
      created_at: '2026-10-01T12:00:07Z',
      assistant_id: 'shimpz-cloudflare',
      action: 'replace-dns-record',
    };
  }

  // A run of `routine` frozen for the person's answer.
  function frozenRun(id, requestKind, routine = ROUTINE_VIEW) {
    return {
      run_id: id,
      routine_id: routine.routine_id,
      status: 'frozen',
      scheduled_at: '2026-10-01T12:00:00Z',
      request_kind: requestKind,
      assistant_id: 'shimpz-cloudflare',
      action: 'replace-dns-record',
    };
  }

  function choiceNames(panel) {
    return panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  }

  test('a held run is settled in the panel its transcript card opens, through the card Team opened, with exact fresh nonces', async ({ page }) => {
    const held = 'b'.repeat(32);
    const paused = 'c'.repeat(32);
    const audit = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name: 'Weekly DNS audit', quote: 'Every Monday, audit my DNS' };
    const step = { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' };
    await routeReadyChat(page, {
      history: {
        entries: [
          routineRow(held, 'held', step, { version: 2 }),
          routineRow(paused, 'paused', { ...step, reason: 'exhausted' }, { routine: audit, version: 2 }),
        ],
        before: null,
      },
    });
    let routines = [{ ...ROUTINE_VIEW, paused: true }, { ...audit, paused: true }];
    let incidents = [heldIncident(held), heldIncident(paused, audit)];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines, runs: [], incidents },
    }));
    const opened = [];
    const answers = [];
    await page.route('**/api/teams/marketing/routines/incidents/*/card', async (route) => {
      const incidentId = new URL(route.request().url()).pathname.split('/').at(-2);
      opened.push(incidentId);
      // Team's card names its current step, which the transcript row may not show yet.
      const action = incidentId === held ? 'create-dns-record' : 'replace-dns-record';
      await route.fulfill({ json: recoveryCard(incidentId, { nonce: String(opened.length).repeat(32), action }) });
    });
    // The paused run's first Recreate is refused; everything else settles its run and lifts its Routine's pause.
    await page.route('**/api/teams/marketing/routines/incidents/*/answer', async (route) => {
      const incidentId = new URL(route.request().url()).pathname.split('/').at(-2);
      const answer = route.request().postDataJSON();
      answers.push(answer);
      if (incidentId === paused && answers.filter((item) => item.choice === 'recreate').length === 1) {
        await route.fulfill({ status: 422, json: { code: 'routine-recreate-refused' } });
        return;
      }
      const settled = incidents.find((item) => item.incident_id === incidentId);
      incidents = incidents.filter((item) => item !== settled);
      routines = routines.map((routine) => (routine.routine_id === settled.routine_id ? { ...routine, paused: false } : routine));
      const status = answer.choice === 'run' ? 'requested' : 'recreated';
      await route.fulfill({ json: { team_id: 'marketing', incident_id: incidentId, choice: answer.choice, status } });
    });
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    await expect(rows).toHaveCount(2);
    // A transcript card decides nothing: no recovery choice, Resume, or execution details, only its Routine's panel.
    for (const index of [0, 1]) {
      await expect(rows.nth(index).getByRole('button')).toHaveAccessibleName('Open Routine');
      await expect(rows.nth(index).getByRole('group', { name: 'Recovery choices' })).toHaveCount(0);
    }
    // Each waiting notice says so until its run is settled.
    await expect(rows.nth(0)).toContainText('stopped with an error');
    await expect(rows.nth(1)).toContainText('paused');
    await expect(rows.nth(1)).toContainText('Its recovery budget is used up.');
    for (const index of [0, 1]) await expect(rows.nth(index)).toContainText('Waiting for you');
    expect(opened).toEqual([]);
    expect(await accessibilityViolations(page)).toEqual([]);

    const open = rows.nth(0).getByRole('button', { name: 'Open Routine' });
    await open.click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    // The panel shows exactly the card's three choices, one action each, in Team's order, before any answer.
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Recreate', 'Delete']);
    expect(answers).toEqual([]);
    expect(await accessibilityViolations(page)).toEqual([]);
    // The step shown is the card's, with the error it returned as plain text.
    await expect(panel).toContainText('Create DNS record');
    await panel.getByText('See the technical error').click();
    await expect(panel.locator('.error-text')).toHaveText(CREDITS_MESSAGE);
    await panel.getByRole('button', { name: 'Run' }).click();
    await expect(panel.getByRole('status')).toContainText('Set aside. The Routine runs again now.');
    await expect(panel.getByRole('group', { name: 'Recovery choices' })).toHaveCount(0);
    // Closing the panel returns to the card, which no longer waits for anything.
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    await expect(rows.nth(0)).toBeFocused();
    await expect(rows.nth(0)).not.toContainText('Waiting for you');

    // A refused Recreate says why and changes nothing; the next answer uses a freshly opened card.
    await rows.nth(1).getByRole('button', { name: 'Open Routine' }).click();
    const auditPanel = page.getByRole('dialog', { name: audit.name });
    await expect.poll(() => choiceNames(auditPanel)).toEqual(['Run', 'Recreate', 'Delete']);
    await auditPanel.getByRole('button', { name: 'Recreate' }).click();
    await expect(auditPanel.getByRole('status')).toHaveText(
      'Your original request could not be made into this Routine again. Nothing changed; ask for it again in the chat.',
    );
    await expect.poll(() => choiceNames(auditPanel)).toEqual(['Run', 'Recreate', 'Delete']);
    await auditPanel.getByRole('button', { name: 'Recreate' }).click();
    await expect(auditPanel.getByRole('status')).toContainText('Recreated from your original request. It now follows its schedule.');
    await expect(auditPanel.getByRole('group', { name: 'Recovery choices' })).toHaveCount(0);
    expect(new Set(opened)).toEqual(new Set([held, paused]));
    // Every answer carries exactly the nonce of a card the panel had shown, never one opened after the click.
    const nonces = opened.map((_id, index) => String(index + 1).repeat(32));
    expect(answers.map((answer) => answer.choice)).toEqual(['run', 'recreate', 'recreate']);
    for (const answer of answers) expect(nonces).toContain(answer.nonce);
    const pausedNonces = opened.flatMap((id, index) => (id === paused ? [String(index + 1).repeat(32)] : []));
    expect(answers.slice(1).map((answer) => answer.nonce)).toEqual(pausedNonces.slice(0, 2));
  });

  test("a card's error is literal text, and a shortened one says it was shortened", async ({ page }) => {
    const held = 'b'.repeat(32);
    const message = '<img src=x onerror=alert(1)> Insufficient account credits';
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(held, 'held', { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }, { version: 2 })],
        before: null,
      },
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [{ ...ROUTINE_VIEW, paused: true }], runs: [], incidents: [heldIncident(held)] },
    }));
    await page.route('**/api/teams/marketing/routines/incidents/*/card', (route) => route.fulfill({
      json: recoveryCard(held, { failure: { message, truncated: true } }),
    }));
    await page.goto('/chat/?team=marketing');
    await page.locator('.routine-run').getByRole('button', { name: 'Open Routine' }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByText('See the technical error').click();
    await expect(panel.locator('.error-text')).toHaveText(message);
    await expect(panel.locator('.error-text img')).toHaveCount(0);
    await expect(panel).toContainText('shortened');
  });

  test("a transcript card opens its Routine's panel, whose Delete asks for the deletion confirmation", async ({ page }) => {
    const held = 'b'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(held, 'held', { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }, { version: 2 })],
        before: null,
      },
    });
    const calls = await routeRoutines(page);
    await page.goto('/chat/?team=marketing');
    const row = page.locator('.routine-run');
    const open = row.getByRole('button', { name: 'Open Routine' });
    await expect(open).toHaveAttribute('aria-haspopup', 'dialog');
    // Escape and Close each leave the panel with focus back on the card's button, and nothing was answered.
    await open.click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Recreate', 'Delete']);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(open).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Recreate', 'Delete']);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await expect(open).toBeFocused();

    await open.click();
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: `Delete “${ROUTINE_VIEW.name}”?` });
    await expect(confirm.getByLabel('Supervisor password')).toBeFocused();
    expect(await accessibilityViolations(page)).toEqual([]);
    // Cancel returns to that Routine's panel, which is the same decision.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' })).toBeFocused();
    await panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button', { name: 'Delete' }).click();
    await confirm.getByLabel('Supervisor password').fill(SUPERVISOR_PASSWORD);
    await confirm.getByLabel('Six-digit code').fill('123456');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toHaveCount(0);
    expect(calls.deletes).toEqual([{ code: '123456' }]);
    expect(calls.answers).toEqual([]);
    // The deleted Routine is no longer listed, so its card offers nothing.
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test("a run's execution details are read for that run in its Routine's panel and shown only as text", async ({ page }) => {
    const failed = 'c'.repeat(32);
    await routeReadyChat(page, {
      history: { entries: [routineRow(failed, 'failed', { code: 'assistant-rpc-failed', actions: [] })], before: null },
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] },
    }));
    const requested = [];
    const attempt = (number, failure, condition = null) => ({
      operation_id: '6f1c2b8e-3a4d-4c5e-9f60-718293a4b5c6',
      attempt: number,
      assistant_id: 'shimpz-cloudflare',
      action: 'replace-dns-record',
      recorded_at: '2026-10-01T12:00:03Z',
      failure,
      condition,
    });
    let answer = {
      team_id: 'marketing',
      run_id: failed,
      diagnostics: [
        attempt(1, {
          error_type: 'httpx.HTTPStatusError',
          message: '<img src=x onerror="window.leaked=1"> **not markdown**',
          provider: 'api.cloudflare.com',
          http_status: 404,
          response_excerpt: '{"success":false}',
          redacted: true,
          truncated: false,
        }),
        attempt(2, null, 'exit-status:1'),
      ],
    };
    await page.route('**/api/teams/marketing/routines/runs/*/diagnostics', async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: answer });
    });
    await page.goto('/chat/?team=marketing');
    // A run that waits for nobody offers nothing in the transcript; its details are in its Routine's panel.
    await expect(page.locator('.routine-run')).toContainText('Daily DNS zones failed');
    await expect(page.locator('.routine-run')).toContainText('assistant-rpc-failed');
    await expect(page.locator('.routine-run').getByRole('button')).toHaveCount(0);
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runDetails = panel.getByRole('button', { name: 'Execution details' });
    await runDetails.click();
    const dialog = page.getByRole('dialog', { name: 'Execution details' });
    await expect(dialog).toContainText('<img src=x onerror="window.leaked=1"> **not markdown**');
    await expect(dialog).toContainText('The Action exited with status 1.');
    await expect(dialog.locator('img, strong')).toHaveCount(0);
    expect(await page.evaluate(() => window.leaked)).toBeUndefined();
    expect(requested).toEqual([`/api/teams/marketing/routines/runs/${failed}/diagnostics`]);
    expect(await accessibilityViolations(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    // Details that name another run are refused, never shown.
    answer = { ...answer, run_id: 'd'.repeat(32) };
    await runDetails.click();
    await expect(dialog).toContainText('The Routine request failed. Try again.');
    await expect(dialog).not.toContainText('httpx.HTTPStatusError');
  });

  test("a Routine's recent runs are found past a full page of newer unrelated chat", async ({ page }) => {
    const done = { actions: [['shimpz-cloudflare', 'list-zones']] };
    const chat = Array.from({ length: 64 }, (_, index) => ({
      id: `${index.toString(16).padStart(32, '0')}:user`,
      created_at: '2026-10-02T09:00:00Z',
      kind: 'message',
      role: 'user',
      text: `Unrelated message ${index + 1}`,
    }));
    const chatHistory = await routeReadyChat(page, {
      history: { entries: chat, before: 'AAAAAAAAAMg' },
      olderHistory: {
        entries: [
          routineRow('c'.repeat(32), 'failed', { code: 'assistant-rpc-failed', actions: [] }),
          routineRow('d'.repeat(32), 'done', done),
        ],
        before: null,
      },
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] },
    }));
    await page.goto('/chat/?team=marketing');
    await expect(page.getByText('Unrelated message 64', { exact: true })).toBeVisible();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    // Both runs sit behind the newest page; the panel follows the cursor to them, newest first.
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(2);
    await expect(runs.getByRole('listitem').first()).toContainText('Done');
    await expect(runs).not.toContainText('No runs yet.');
    await expect(runs.getByRole('button', { name: 'Look for older runs' })).toHaveCount(0);
    expect(chatHistory.historyRequests()).toContain('AAAAAAAAAMg');
  });

  test("a Routine's runs beyond one search's page bound are reached by continuing it, and a run that ends joins them", async ({ page }) => {
    const pageOf = (start) => Array.from({ length: 64 }, (_, index) => ({
      id: `${(start + index).toString(16).padStart(32, '0')}:user`,
      created_at: '2026-10-02T09:00:00Z',
      kind: 'message',
      role: 'user',
      text: `Unrelated message ${start + index + 1}`,
    }));
    const searched = [];
    const done = { actions: [['shimpz-cloudflare', 'list-zones']] };
    // A run that ends while the panel is open is written after the newest unrelated message.
    let delivered = null;
    await routeReadyChat(page);
    // Seventeen pages of newer unrelated chat, then the Routine's one run.
    await page.route('**/api/teams/marketing/chat/history**', (route) => {
      const before = new URL(route.request().url()).searchParams.get('before');
      searched.push(before);
      const index = before === null ? 0 : Number.parseInt(before.slice(-3, -1), 10);
      const newest = delivered ? [...pageOf(0).slice(1), delivered] : pageOf(0);
      const body = index < 17
        ? { entries: index === 0 ? newest : pageOf(index * 64), before: `AAAAAAAA${String(index + 1).padStart(2, '0')}A` }
        : { entries: [routineRow('d'.repeat(32), 'done', done)], before: null };
      return route.fulfill({ json: body });
    });
    let routineReads = 0;
    let running = [{
      run_id: 'e'.repeat(32),
      routine_id: ROUTINE_VIEW.routine_id,
      status: 'leased',
      scheduled_at: '2026-10-02T09:00:00Z',
      request_kind: null,
      assistant_id: null,
      action: null,
    }];
    await page.route('**/api/teams/marketing/routines', (route) => {
      routineReads += 1;
      return route.fulfill({ json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: running, incidents: [] } });
    });
    await page.clock.install();
    await page.goto('/chat/?team=marketing');
    await expect(page.getByText('Unrelated message 64', { exact: true })).toBeVisible();
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    const older = runs.getByRole('button', { name: 'Look for older runs' });
    await expect(older).toBeVisible();
    await expect(runs).not.toContainText('No runs yet.');
    await expect(runs).toContainText('Running now');
    // The running run ends while the panel stays open: the next refresh lists it at the top, reading only the newest
    // page, and the search for older runs keeps its place.
    const before = searched.length;
    delivered = routineRow('e'.repeat(32), 'done', done);
    running = [];
    await page.clock.runFor(16_000);
    await expect(runs).not.toContainText('Running now');
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(1);
    await expect(runs.getByRole('listitem').first()).toContainText('Done');
    await expect(older).toBeVisible();
    expect(searched.slice(before).filter((cursor) => cursor !== null)).toEqual([]);
    await older.click();
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(2);
    await expect(older).toHaveCount(0);
    // The chat's periodic refresh replaces the Routine's details; the runs found so far stay.
    const reads = routineReads;
    const searches = searched.length;
    await page.clock.runFor(16_000);
    await expect.poll(() => routineReads).toBeGreaterThan(reads);
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(2);
    await expect(older).toHaveCount(0);
    expect(searched.slice(searches).filter((before) => before !== null)).toEqual([]);
  });

  test("a Routine's panel that stays open keeps its latest few runs while new runs keep ending", async ({ page }) => {
    const done = { actions: [['shimpz-cloudflare', 'list-zones']] };
    const failed = { code: 'assistant-rpc-failed', actions: [] };
    const digits = '0123456789abcdef';
    const history = [0, 1, 2, 3, 4].map((index) => routineRow(digits[index].repeat(32), 'done', done));
    await routeReadyChat(page);
    await page.route('**/api/teams/marketing/chat/history**', (route) => route.fulfill({
      json: { entries: history, before: null },
    }));
    let routineReads = 0;
    await page.route('**/api/teams/marketing/routines', (route) => {
      routineReads += 1;
      return route.fulfill({ json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] } });
    });
    await page.clock.install();
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    await expect(runs.getByRole('listitem')).toHaveCount(5);
    // Two runs end before each refresh; the newest, a failed one, lists first and the oldest leave the list.
    for (let index = 5; index < 15; index += 2) {
      history.push(routineRow(digits[index].repeat(32), 'done', done));
      history.push(routineRow(digits[index + 1].repeat(32), 'failed', failed));
      const reads = routineReads;
      await page.clock.runFor(16_000);
      await expect.poll(() => routineReads).toBeGreaterThan(reads);
      await expect(runs.getByRole('listitem').first()).toContainText('assistant-rpc-failed');
      await expect(runs.getByRole('listitem')).toHaveCount(5);
    }
  });

  test("a continuous Routine's healthy minutes are its runs, each with its count and no execution details", async ({ page }) => {
    const continuous = { ...ROUTINE_VIEW, schedule: { kind: 'continuous', gap: 5, cap: 12 } };
    const rollup = (id, runs) => ({ ...routineRow(id, 'healthy', { runs }, { routine: continuous }), run_id: null });
    await routeReadyChat(page, { history: { entries: [rollup('c'.repeat(32), 12), rollup('d'.repeat(32), 1)], before: null } });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [continuous], runs: [], incidents: [] },
    }));
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(continuous.name) }).click();
    const panel = page.getByRole('dialog', { name: continuous.name });
    await panel.getByRole('tab', { name: 'Runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    // Newest first, each minute with how many runs it finished; a rollup is no single run with details to open.
    await expect(runs.getByRole('listitem').nth(0)).toContainText('1 run finished');
    await expect(runs.getByRole('listitem').nth(1)).toContainText('12 runs finished');
    await expect(runs).not.toContainText('No runs yet.');
    await expect(runs.getByRole('button', { name: 'Execution details' })).toHaveCount(0);
  });

  test('a Routine paused after its failures resumes from its panel, never past a held run its transcript card opens', async ({ page }) => {
    const failed = 'c'.repeat(32);
    const held = 'f'.repeat(32);
    const heldRoutine = { ...ROUTINE_VIEW, routine_id: 'e'.repeat(32), name: 'Weekly DNS audit', paused: true };
    await routeReadyChat(page, {
      history: {
        entries: [
          routineRow(failed, 'failed', { code: 'assistant-rpc-failed', actions: [] }),
          routineRow(held, 'paused', {
            assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record', reason: 'exhausted',
          }, { routine: heldRoutine }),
        ],
        before: null,
      },
    });
    let routines = [{ ...ROUTINE_VIEW, paused: true }, heldRoutine];
    const incidents = [heldIncident(held, heldRoutine)];
    const resumed = [];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines, runs: [], incidents },
    }));
    await page.route('**/api/teams/marketing/routines/*/resume', async (route) => {
      const routineId = new URL(route.request().url()).pathname.split('/').at(-2);
      resumed.push(routineId);
      routines = routines.map((routine) => (routine.routine_id === routineId ? { ...routine, paused: false } : routine));
      await route.fulfill({ json: { team_id: 'marketing', routine_id: routineId, paused: false } });
    });
    await page.route('**/api/teams/marketing/routines/incidents/*/card', (route) => route.fulfill({
      json: recoveryCard(held, { nonce: '1'.repeat(32) }),
    }));
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    // No card resumes a Routine: the failed run's offers nothing, and the held one only opens its Routine's panel.
    await expect(rows.nth(1).getByRole('button')).toHaveAccessibleName('Open Routine');
    await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
    // A Routine an unresolved incident still holds offers no Resume: its panel is the recovery decision alone.
    await rows.nth(1).getByRole('button', { name: 'Open Routine' }).click();
    const heldPanel = page.getByRole('dialog', { name: heldRoutine.name });
    await expect.poll(() => choiceNames(heldPanel)).toEqual(['Run', 'Recreate', 'Delete']);
    await expect(heldPanel.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await heldPanel.getByRole('button', { name: 'Close' }).click();
    await expect(heldPanel).toHaveCount(0);

    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: /^Routines for Marketing/ }).click();
    await page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })
      .getByRole('button', { name: new RegExp(ROUTINE_VIEW.name) }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Resume' }).click();
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(resumed).toEqual([ROUTINE_VIEW.routine_id]);
  });

  test('decorations stay still while their control glitches on hover', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'hover is a pointer interaction');
    const held = 'b'.repeat(32);
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(held, 'held', { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }, { version: 2 })],
        before: null,
      },
    });
    // A paused Routine with a held run: the Team's Routines button carries the attention dot.
    await routeRoutines(page);
    await page.goto('/chat/?team=marketing');
    await expect(page.locator('.routine-run').getByRole('button', { name: 'Open Routine' })).toBeVisible();
    const routines = page.getByRole('button', { name: /^Routines for Marketing: one needs your attention$/ });
    await expect(routines).toBeVisible();
    // Each decoration's box is sampled through the whole glitch, which lasts 280ms after the pointer arrives.
    for (const [control, decoration] of [[routines, page.locator('.routines-slot .attention')]]) {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(400);
      const before = await decoration.boundingBox();
      expect(before).not.toBeNull();
      await control.hover();
      const during = [];
      for (let sample = 0; sample < 8; sample += 1) {
        during.push(await decoration.boundingBox());
        await page.waitForTimeout(40);
      }
      for (const box of during) expect(box).toEqual(before);
    }
  });

  test('an expired recovery card is withdrawn and only a person opens a fresh one', async ({ page }) => {
    const held = 'b'.repeat(32);
    await page.clock.install({ time: new Date('2026-10-01T12:05:00Z') });
    await routeReadyChat(page, {
      history: {
        entries: [routineRow(held, 'held', { assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' }, { version: 2 })],
        before: null,
      },
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [{ ...ROUTINE_VIEW, paused: true }], runs: [], incidents: [heldIncident(held)] },
    }));
    let opened = 0;
    const answers = [];
    await page.route('**/api/teams/marketing/routines/incidents/*/card', async (route) => {
      opened += 1;
      await route.fulfill({ json: recoveryCard(held, { nonce: String(opened).repeat(32) }) });
    });
    await page.route('**/api/teams/marketing/routines/incidents/*/answer', async (route) => {
      answers.push(route.request().postDataJSON());
      await route.fulfill({
        json: { team_id: 'marketing', incident_id: held, choice: 'run', status: 'requested' },
      });
    });
    await page.goto('/chat/?team=marketing');
    await page.locator('.routine-run').getByRole('button', { name: 'Open Routine' }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    const choices = panel.getByRole('group', { name: 'Recovery choices' }).getByRole('button');
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Recreate', 'Delete']);
    // Once Team's five minutes pass the card is withdrawn; nothing opens another until the person asks.
    await page.clock.runFor(300_000);
    await expect(choices).toHaveCount(0);
    await expect(panel.getByRole('status')).toHaveText('This recovery card expired.');
    await page.clock.runFor(600_000);
    expect(opened).toBe(1);
    await panel.getByRole('button', { name: 'Open the card again' }).click();
    await expect.poll(() => choiceNames(panel)).toEqual(['Run', 'Recreate', 'Delete']);
    await expect(panel.getByRole('status')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Run', exact: true }).click();
    // The answer carries the fresh card's nonce, never the expired one.
    expect(answers).toEqual([{ nonce: '2'.repeat(32), choice: 'run' }]);
  });

  test('a frozen run is approved in the panel its transcript card opens, with the chat approval dialog', async ({ page }) => {
    const run = 'd'.repeat(32);
    const waiting = 'e'.repeat(32);
    const audit = { ...ROUTINE_VIEW, routine_id: 'c'.repeat(32), name: 'Weekly DNS audit', quote: 'Every Monday, audit my DNS' };
    const frozenRow = (id, requestKind, routine) => routineRow(id, 'frozen', {
      request_kind: requestKind, assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record',
    }, { routine });
    await routeReadyChat(page, {
      history: { entries: [frozenRow(waiting, 'integrations', audit), frozenRow(run, 'human', ROUTINE_VIEW)], before: null },
    });
    let runs = [frozenRun(waiting, 'integrations', audit), frozenRun(run, 'human')];
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW, audit], runs, incidents: [] },
    }));
    const answers = [];
    const resumes = [];
    const openings = [];
    await page.route('**/api/teams/marketing/routines/runs/*/challenge', async (route) => {
      const runId = new URL(route.request().url()).pathname.split('/')[6];
      openings.push(route.request().postDataJSON());
      await route.fulfill({
        json: runId === run
          ? {
            team_id: 'marketing',
            run_id: run,
            status: 'human-required',
            challenge: {
              type: 'human-required',
              challenge_id: 'b'.repeat(32),
              expires_in: 300,
              assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
              action: { id: 'replace-dns-record', summary: 'Replace one reviewed DNS record.' },
              ...localizedChallenge(humanRequest('approval')),
            },
          }
          : { team_id: 'marketing', run_id: runId, status: 'integrations-required' },
      });
    });
    await page.route(`**/api/teams/marketing/routines/runs/${run}/human`, async (route) => {
      answers.push(route.request().postDataJSON());
      // The first approval resumes a run that freezes again for its next approval; the second completes it.
      const status = answers.length === 1 ? 'frozen' : 'done';
      if (status === 'done') runs = runs.filter((item) => item.run_id !== run);
      await route.fulfill({ json: { team_id: 'marketing', run_id: run, status } });
    });
    await page.route('**/api/teams/marketing/routines/runs/*/integrations', async (route) => {
      resumes.push(route.request().method());
      await route.fulfill({ json: { team_id: 'marketing', run_id: waiting, status: 'frozen' } });
    });
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    await expect(rows).toHaveCount(2);
    // The card itself offers no Review: its one action opens the Routine's panel.
    await expect(rows.nth(1).getByRole('button')).toHaveAccessibleName('Open Routine');
    expect(openings).toEqual([]);

    await rows.nth(1).getByRole('button', { name: 'Open Routine' }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
    await expect(dialog).toBeVisible();
    // Dismissing answers nothing: the run stays frozen and can be reviewed again.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await panel.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
    expect(answers).toEqual([]);
    const approval = { type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true };
    await panel.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toHaveText('The run continued: waiting for another answer');
    await panel.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toContainText('The run continued: Done');
    await expect(panel.getByRole('button', { name: 'Review' })).toHaveCount(0);
    expect(answers).toEqual([approval, approval]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);
    await expect(rows.nth(1).getByRole('button')).toHaveCount(0);

    await rows.nth(0).getByRole('button', { name: 'Open Routine' }).click();
    const auditPanel = page.getByRole('dialog', { name: audit.name });
    await auditPanel.getByRole('button', { name: 'Review' }).click();
    await expect(auditPanel).toContainText('Connect Shimpz Cloudflare from the Team\'s Store, then continue the run.');
    expect(resumes).toEqual([]);
    await auditPanel.getByRole('button', { name: 'Continue the run' }).click();
    await expect(auditPanel.getByRole('status')).toHaveText('The run continued: waiting for another answer');
    expect(resumes).toEqual(['POST']);
    // Every opening names the interface language the request copy is rendered in (ADR-0091).
    expect(openings).toEqual(Array(5).fill({ locale: 'en' }));
  });

  test('a Routine notice delivered after the chat opened becomes reviewable without a reload', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    const run = 'd'.repeat(32);
    const earlier = routineRow('c'.repeat(32), 'done', { actions: [['shimpz-cloudflare', 'list-zones']] });
    const frozen = routineRow(run, 'frozen', { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' });
    let history = { entries: [earlier], before: null };
    let runs = [];
    await routeReadyChat(page, { history });
    // Admin's scheduler writes notices durably on its own; these routes serve whatever it has written so far.
    await page.route('**/api/teams/marketing/chat/history**', (route) => route.fulfill({ json: history }));
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs, incidents: [] },
    }));
    await page.route(`**/api/teams/marketing/routines/runs/${run}/challenge`, (route) => route.fulfill({
      json: {
        team_id: 'marketing',
        run_id: run,
        status: 'human-required',
        challenge: {
          type: 'human-required',
          challenge_id: 'b'.repeat(32),
          expires_in: 300,
          assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
          action: { id: 'replace-dns-record', summary: 'Replace one reviewed DNS record.' },
          ...localizedChallenge(humanRequest('approval')),
        },
      },
    }));
    const answers = [];
    await page.route(`**/api/teams/marketing/routines/runs/${run}/human`, async (route) => {
      answers.push(route.request().postDataJSON());
      await route.fulfill({ json: { team_id: 'marketing', run_id: run, status: 'done' } });
    });
    await page.goto('/chat/?team=marketing');
    const rows = page.locator('.routine-run');
    await expect(rows).toHaveCount(1);
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await fillWhenReady(page, composer, 'A draft that must survive');

    // The scheduler delivers a frozen run while the conversation is open.
    history = { entries: [earlier, frozen], before: null };
    runs = [frozenRun(run, 'human')];
    await page.clock.fastForward(15_000);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Daily DNS zones awaiting approval');
    await expect(rows.nth(1)).toContainText('Shimpz Cloudflare · Replace DNS record');
    await expect(rows.nth(0)).toContainText('Shimpz Cloudflare · List zones');
    await expect(composer).toHaveValue('A draft that must survive');
    // The Team's Routines list shows the same run waiting.
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await page.getByRole('menuitem', { name: 'Routines' }).click();
    await expect(page.getByRole('dialog', { name: 'Which Marketing Routine do you want to open?' })).toContainText('Paused');
    await page.keyboard.press('Escape');
    if (page.viewportSize().width <= 820) await page.keyboard.press('Escape');

    await rows.nth(1).getByRole('button', { name: 'Open Routine' }).click();
    const panel = page.getByRole('dialog', { name: ROUTINE_VIEW.name });
    await panel.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
    await dialog.getByRole('button', { name: 'Approve action' }).click();
    await expect(panel.getByRole('status')).toContainText('The run continued: Done');
    expect(answers).toEqual([{ type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true }]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toHaveCount(0);

    // The run's newer version replaces its row instead of adding another; the draft is still there.
    const published = { actions: [['shimpz-cloudflare', 'replace-dns-record']] };
    history = { entries: [earlier, { ...frozen, outcome: 'done', detail: published, version: 2 }], before: null };
    runs = [];
    await page.clock.fastForward(15_000);
    await expect(rows.nth(1)).toContainText('done');
    await expect(rows.nth(1)).toContainText('Shimpz Cloudflare · Replace DNS record');
    await expect(rows).toHaveCount(2);
    await expect(composer).toHaveValue('A draft that must survive');
  });

  test('Routine notices written behind more than one page of newer history while the chat was away still arrive', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
    const done = { actions: [['shimpz-cloudflare', 'list-zones']] };
    const earlier = routineRow('c'.repeat(32), 'done', done);
    const gap = routineRow('d'.repeat(32), 'failed', { code: 'assistant-rpc-failed', actions: [] });
    const newest = routineRow('e'.repeat(32), 'done', done);
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
    await page.route('**/api/teams/marketing/chat/history**', (route) => {
      const before = new URL(route.request().url()).searchParams.get('before');
      requested.push(before);
      return route.fulfill({ json: pages[before] });
    });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] },
    }));
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
    await page.clock.fastForward(15_000);
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('assistant-rpc-failed');
    await expect(rows.nth(2)).toContainText('Shimpz Cloudflare · List zones');
    expect(requested).toEqual([null, 'AAAAAAAAAMg']);
    // The next refresh finds nothing new on the newest page and reads no further.
    requested.length = 0;
    await page.clock.fastForward(15_000);
    await expect.poll(() => requested).toEqual([null]);
    await expect(rows).toHaveCount(3);

    // More was written than one refresh reads: the transcript starts again from the newest rows, as a reload shows them,
    // and earlier history continues from where the refresh stopped, down to the notice written in between.
    const behind = routineRow('f'.repeat(32), 'done', done);
    const cursor = (index) => `AAAAAAAA${String(index).padStart(2, '0')}A`;
    pages = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      index === 0 ? 'null' : cursor(index),
      { entries: unrelated(1000 + (8 - index) * 64, 64), before: cursor(index + 1) },
    ]));
    pages[cursor(8)] = { entries: [newest, behind], before: null };
    requested.length = 0;
    await page.clock.fastForward(15_000);
    await expect(page.getByText(`Unrelated message ${1000 + 8 * 64 + 64}`, { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(0);
    expect(requested).toEqual([null, ...Array.from({ length: 7 }, (_, index) => cursor(index + 1))]);
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
    const done = { actions: [['shimpz-cloudflare', 'list-zones']] };
    const history = {
      entries: [
        ...exchange('a', 0, '2026-09-29T14:00:05Z'),
        at(routineRow('b'.repeat(32), 'done', done), '2026-09-29T15:00:00Z'),
        ...[0, 1, 2].flatMap((index) => exchange('c', index, `2026-09-29T2${index}:00:00Z`)),
        // Yesterday holds only stored messages: each row's own time gives it a day, with no Routine notice to borrow.
        ...[3, 4].flatMap((index) => exchange('c', index, `2026-09-30T1${index}:00:00Z`)),
        ...exchange('c', 5, '2026-10-01T02:30:00Z'),
        ...exchange('e', 0, '2026-10-01T13:00:00Z'),
        at(routineRow('f'.repeat(32), 'done', done), '2026-10-01T14:00:00Z'),
      ],
      before: null,
    };
    await routeReadyChat(page, { history, reply: 'Live answer' });
    await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
      json: { team_id: 'marketing', routines: [ROUTINE_VIEW], runs: [], incidents: [] },
    }));
    await page.goto('/chat/?team=marketing');
    const turns = page.locator('.turns');
    const days = turns.getByRole('heading', { level: 2 });
    const DAYS = ['September 29, 2026', 'Yesterday', 'Today'];
    await expect(days).toHaveText(DAYS);
    // The first stored message opens its own day.
    await expect(turns.locator('h2 + .exchange').first()).toContainText('Question a0');
    // Every message shows when it was sent and every reply when it was completed, to the second, in the viewer's
    // timezone; a Routine notice shows its own time to the second on its rail.
    const timeOf = (text) => turns.locator('article', { hasText: text }).locator('time');
    await expect(timeOf('Question a0')).toHaveText('11:00:05');
    await expect(timeOf('Question a0')).toHaveAttribute('datetime', '2026-09-29T14:00:05Z');
    await expect(timeOf('Answer a0')).toHaveText('11:00:14');
    await expect(timeOf('Answer a0')).toHaveAttribute('datetime', '2026-09-29T14:00:14Z');
    await expect(timeOf('Question c5')).toHaveText('23:30:00');
    await expect(timeOf('Answer c5')).toHaveText('23:30:09');
    await expect(turns.locator('.routine-run time').first()).toHaveText('12:00:00');

    // A message sent now belongs to today, under the header already there.
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await fillWhenReady(page, composer, 'Sent today');
    await page.getByRole('button', { name: 'Send' }).click();
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

  test('Hosted offers no Routines', async ({ page }) => {
    await routeReadyChat(page, { hostedSession: true });
    // Even with Routines available to fetch, Hosted never asks for them.
    await routeRoutines(page);
    await page.goto('/chat/?team=marketing');
    const navigation = await openTeamNavigation(page);
    await navigation.getByRole('button', { name: 'Actions for Marketing' }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete Team' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Routines' })).toHaveCount(0);
  });
});

const KEY_PAGE = 'https://dashboard.exa.ai/api-keys';
const TASK_PURPOSE = 'To bring today’s AI news I need to search the web with Shimpz Cloudflare.';

async function openHumanRequest(page, options) {
  const contract = await routeReadyChat(page, { humanKind: 'input:password', ...options });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Bring me today’s AI news');
  await page.getByRole('button', { name: 'Send' }).click();
  return contract;
}

test('a Stored Input request links its reviewed key page and sends the pasted key once', async ({ page }) => {
  const contract = await openHumanRequest(page, {
    humanStoredInput: 'exa-api-key',
    humanPurpose: TASK_PURPOSE,
    humanHelpUrl: KEY_PAGE,
  });
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toContainText(TASK_PURPOSE);
  const link = dialog.getByRole('link');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', KEY_PAGE);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const field = dialog.getByLabel('Shimpz Cloudflare API key');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('exa-secret-key');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  expect(contract.humanResponses()).toEqual([expect.objectContaining({
    type: 'human-response',
    challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    decision: 'submit',
    value: 'exa-secret-key',
  })]);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('exa-secret-key');
});

test('a Stored Input request without a key page or purpose names its Assistant and offers no link', async ({ page }) => {
  const contract = await openHumanRequest(page, { humanStoredInput: 'exa-api-key' });
  const dialog = page.getByRole('dialog', { name: 'Shimpz Cloudflare' });
  await expect(dialog).toContainText('Shimpz Cloudflare needs this key');
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
  expect(contract.humanResponses()).toEqual([expect.objectContaining({ decision: 'deny' })]);
  expect(contract.humanResponses()[0]).not.toHaveProperty('value');
});

test('any other request shows the Brain purpose beside its authorized scope and Assistant, never a key link', async ({ page }) => {
  await routeReadyChat(page, { humanKind: 'approval', humanPurpose: TASK_PURPOSE });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Publish the reviewed DNS changes');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog).toContainText(TASK_PURPOSE);
  // The purpose explains why; the Assistant's own description of what is authorized stays visible beside it.
  await expect(dialog).toContainText('Shimpz Cloudflare paused before continuing this exact Action.');
  await expect(dialog).toContainText('Shimpz Cloudflare · v0.4.1');
  await expect(dialog.getByRole('link')).toHaveCount(0);
});

test('every chat frame carries the interface language selected when it is sent', async ({ page }) => {
  const chat = await routeReadyChat(page);
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await fillWhenReady(page, composer, 'List my DNS zones');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(1);
  await expect(composer).toBeEnabled();

  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  const portuguese = page.getByRole('textbox', { name: 'Enviar', exact: true });
  await portuguese.fill('Liste minhas zonas DNS');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect.poll(() => chat.chatFrames().length).toBe(2);
  expect(chat.chatFrames().map((frame) => [frame.type, frame.locale])).toEqual([['chat', 'en'], ['chat', 'pt']]);
});

// ADR-0091: Team renders the Assistant's English catalog copy in the turn's interface language. The dialog shows only
// that rendered copy, while the answer is always the canonical option value Team fingerprinted.
for (const [language, shown] of [
  ['en', {
    send: 'Send', title: 'DNS changes to publish: 3. Zone: example.com.', submit: 'Send',
    scope: 'Choose how Shimpz Cloudflare publishes the reviewed records for example.com.',
    options: ['Proxied', 'DNS only'], hint: 'Route traffic through Cloudflare.',
  }],
  ['pt', {
    send: 'Enviar', title: 'Alterações de DNS a publicar: 3. Zona: example.com.', submit: 'Enviar',
    scope: 'Escolha como o Shimpz Cloudflare publica os registros revisados de example.com.',
    options: ['Com proxy', 'Somente DNS'], hint: 'Encaminhar o tráfego pela Cloudflare.',
  }],
]) {
  test(`an Action approval in ${language} shows its rendered copy and submits the canonical option value`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('shimpz_lang', lang), language);
    const scenario = await routeScenario(page, 'human-approval');
    await page.goto('/chat/?team=marketing');
    const composer = page.getByRole('textbox', { name: shown.send, exact: true });
    const send = page.getByRole('button', { name: shown.send, exact: true });
    await expect(async () => {
      await composer.fill('Publish my DNS changes');
      await expect(send).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await send.click();

    const dialog = page.getByRole('dialog', { name: shown.title });
    await expect(dialog).toContainText(shown.scope);
    await expect(dialog).toContainText('Shimpz Cloudflare · v0.4.1');
    await expect(dialog.getByRole('radio', { name: shown.options[0] })).toBeVisible();
    await expect(dialog).toContainText(shown.hint);
    if (language !== 'en') {
      // No Assistant-authored English reaches a localized dialog.
      for (const english of ['DNS changes to publish', 'Proxied', 'DNS only', 'Route traffic through Cloudflare.']) {
        await expect(dialog).not.toContainText(english);
      }
    }
    await dialog.getByRole('radio', { name: shown.options[1] }).check();
    await dialog.getByRole('button', { name: shown.submit, exact: true }).click();

    await expect(page.getByText('Done — published with dns-only.')).toBeVisible();
    const frames = scenario.chatFrames();
    expect(frames.filter((frame) => frame.type === 'chat').map((frame) => frame.locale)).toEqual([language]);
    expect(frames.filter((frame) => frame.type === 'human-response')).toEqual([{
      type: 'human-response',
      challenge_id: 'b'.repeat(32),
      decision: 'submit',
      value: 'dns-only',
    }]);
  });
}

test('a frozen Routine run opens in the interface language and answers with the canonical response', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  const run = 'd'.repeat(32);
  await routeReadyChat(page, {
    history: {
      entries: [{
        id: `${run}:routine`,
        kind: 'routine-run',
        notice_id: run,
        routine_id: 'a'.repeat(32),
        quote: 'Every day at 9, list my DNS zones',
        run_id: run,
        outcome: 'frozen',
        created_at: '2026-10-01T12:01:07Z',
        detail: { request_kind: 'human', assistant_id: 'shimpz-cloudflare', action: 'replace-dns-record' },
        version: 1,
      }],
      before: null,
    },
  });
  await page.route('**/api/teams/marketing/routines', (route) => route.fulfill({
    json: {
      team_id: 'marketing',
      routines: [ROUTINE_VIEW],
      runs: [{
        run_id: run,
        routine_id: ROUTINE_VIEW.routine_id,
        status: 'frozen',
        scheduled_at: '2026-10-01T12:00:00Z',
        request_kind: 'human',
        assistant_id: 'shimpz-cloudflare',
        action: 'replace-dns-record',
      }],
      incidents: [],
    },
  }));
  const openings = [];
  const answers = [];
  await page.route(`**/api/teams/marketing/routines/runs/${run}/challenge`, async (route) => {
    const opening = route.request().postDataJSON();
    openings.push(opening);
    await route.fulfill({
      json: {
        team_id: 'marketing',
        run_id: run,
        status: 'human-required',
        challenge: {
          type: 'human-required',
          challenge_id: 'b'.repeat(32),
          expires_in: 300,
          assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
          action: { id: 'replace-dns-record', summary: 'Replace one reviewed DNS record.' },
          // A Routine challenge carries no purpose: Team renders its request copy in the opening's language.
          ...localizedChallenge(humanRequest('approval'), {
            locale: opening.locale,
            shown: {
              title: 'Publicar as alterações de DNS revisadas?',
              description: 'O Shimpz Cloudflare pausou antes de continuar esta Ação exata.',
            },
          }),
        },
      },
    });
  });
  await page.route(`**/api/teams/marketing/routines/runs/${run}/human`, async (route) => {
    answers.push(route.request().postDataJSON());
    await route.fulfill({ json: { team_id: 'marketing', run_id: run, status: 'done' } });
  });
  await page.goto('/chat/?team=marketing');
  // The card opens its Routine's panel in the interface language; the panel offers the review.
  await page.locator('.routine-run').getByRole('button', { name: 'Abrir rotina' }).click();
  await page.getByRole('dialog', { name: ROUTINE_VIEW.name }).getByRole('button', { name: 'Revisar' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publicar as alterações de DNS revisadas?' });
  await expect(dialog).toContainText('O Shimpz Cloudflare pausou antes de continuar esta Ação exata.');
  await expect(dialog).not.toContainText('Publish reviewed DNS changes?');
  expect(openings).toEqual([{ locale: 'pt' }]);
  await dialog.getByRole('button', { name: 'Aprovar ação' }).click();
  await expect(dialog).toBeHidden();
  expect(answers).toEqual([{ type: 'human-response', challenge_id: 'b'.repeat(32), decision: 'submit', value: true }]);
});
