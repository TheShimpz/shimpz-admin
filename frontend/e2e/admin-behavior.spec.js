import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/modelCatalog.json', import.meta.url), 'utf8'),
);

const visualContract = {
  animations: 'allow',
  fullPage: true,
  maxDiffPixels: 100,
  stylePath: new URL('./visual-contract.css', import.meta.url).pathname,
};

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

async function expectVisuallyHidden(locator) {
  await expect(locator).toHaveClass(/visually-hidden/);
  expect(await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, clipPath: style.clipPath };
  })).toEqual({ width: 1, height: 1, clipPath: 'inset(50%)' });
}

async function expectTaskMediaBesideTitle(task) {
  const [mediaBox, titleBox] = await Promise.all([
    task.locator('[data-slot="chat-task-media"]').boundingBox(),
    task.locator('[data-slot="chat-task-title"]').boundingBox(),
  ]);
  if (!mediaBox || !titleBox) throw new Error('Chat task media or title has no rendered bounds');
  const gap = titleBox.x - (mediaBox.x + mediaBox.width);
  const overlap = Math.min(mediaBox.y + mediaBox.height, titleBox.y + titleBox.height)
    - Math.max(mediaBox.y, titleBox.y);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThanOrEqual(24);
  expect(overlap).toBeGreaterThan(0);
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
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><button type="button">Uninstall</button><script>
      parent.postMessage({ type: 'shimpz:assistant-store-frame', version: 2, height: 420 }, '*');
      document.querySelector('button').addEventListener('click', () => parent.postMessage({
        type: 'shimpz:assistant-uninstall', version: 2, assistant: 'shimpz-cloudflare'
      }, '*'));
    </script></body></html>`,
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

async function routeReadyChat(page, {
  assistantPlan = false,
  holdAssistantPlan = false,
  holdAssistantIcon = false,
  assistantSummary = 'Safely manage Cloudflare DNS records through OAuth.',
  assistantUninstall = false,
  assistantUninstallWasRemoved = true,
  holdAssistantUninstall = false,
  holdAssistantInventoryRefresh = false,
  disconnectHumanResponse = false,
  holdHumanResponse = false,
  humanKind = '',
  humanExpiresIn = 300,
  redeliverExpiredHuman = false,
  humanRejections = [],
  integrationChallenge = false,
  integrationStatus = 'connected',
  integrationRequirements,
  missingInference = false,
  holdInferenceWrite = false,
  multipleIntegrations = false,
  oauthCompletionMode = 'automatic',
  holdReply = false,
  terminalError = false,
  whatsappInstalled = false,
  reply,
} = {}) {
  let inferenceWrites = 0;
  const humanResponses = [];
  let chatConnections = 0;
  let disconnectHumanSocket = () => {};
  let releaseHumanResponse = () => {};
  let humanPending = false;
  let humanRejectionIndex = 0;
  let syncFrames = 0;
  let expiredHumanRedelivered = false;
  let assistantInstalled = assistantUninstall || !assistantPlan;
  let cloudflareInstalled = assistantInstalled;
  let uninstallProposed = false;
  let advanceAssistantPlan = () => {};
  let releaseAssistantPlan = () => {};
  let releaseAssistantUninstall = () => {};
  let releaseReply = () => {};
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
  const chatFrames = [];
  const assistantIconRequests = [];
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(authenticatedLocalSession({ oauth_completion_mode: oauthCompletionMode })),
  }));
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
          summary: 'Safely manage Cloudflare DNS records through OAuth.',
        },
        {
          id: 'whatsapp',
          title: 'WhatsApp',
          summary: 'Send reviewed WhatsApp messages.',
        },
        ...(multipleIntegrations ? [{
          id: 'shimpz-slack',
          title: 'Shimpz Slack',
          summary: 'Send reviewed Slack messages from your Team.',
        }] : []),
      ],
    }),
  }));
  await page.route('**/api/teams/marketing/assistants', async (route) => {
    if (holdAssistantInventoryRefresh && assistantInstalled) await assistantInventoryHold;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assistants: assistantInstalled ? [
          {
            assistant: 'shimpz-cloudflare',
            assistant_version: '0.4.1',
            status: 'running',
          },
          ...(assistantPlan || whatsappInstalled ? [{
            assistant: 'whatsapp',
            assistant_version: '0.1.0',
            status: 'running',
          }] : []),
          ...(multipleIntegrations ? [{
            assistant: 'shimpz-slack',
            assistant_version: '1.2.3',
            status: 'running',
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
  await page.route('**/api/model-providers', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      providers: modelCatalog.providers.map(({ credential_validation: _credential, ...provider }) => ({
        ...provider,
        configured: true,
        masked: '••••1234',
      })),
    }),
  }));
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
      if (holdInferenceWrite) await inferenceWriteHold;
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' }),
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
          assistant_summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
          id: 'cloudflare',
          provider: 'cloudflare',
          name: 'Cloudflare',
          summary: 'Reads reviewed zone and DNS metadata.',
          scopes: ['dns.read', 'dns.write', 'offline_access', 'zone.read'],
          status: integrationStatus,
          integration: { id: 'account-1', name: 'Shimpz', username: null },
          expires_at: '2026-08-31T12:00:00.000Z',
        },
        ...(multipleIntegrations ? [{
          assistant_id: 'shimpz-slack',
          assistant_name: 'Shimpz Slack',
          assistant_version: '0.1.0',
          assistant_summary: 'Send reviewed messages to Slack.',
          id: 'slack',
          provider: 'slack',
          name: 'Slack',
          summary: 'Sends reviewed messages to Slack.',
          scopes: ['chat:write'],
          status: 'connected',
          integration: { id: 'account-2', name: 'Shimpz', username: null },
          expires_at: '2026-08-31T12:00:00.000Z',
        }] : []),
      ],
    }),
  }));
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    const connection = chatConnections;
    chatConnections += 1;

    const sendHumanChallenge = (expiresIn = humanExpiresIn) => socket.send(JSON.stringify({
      type: 'human-required',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expires_in: expiresIn,
      assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
      action: { id: 'list-zones', summary: 'List reviewed Cloudflare zones.' },
      request: humanRequest(humanKind),
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
      } else if (frame.type === 'chat') {
        chatFrames.push(frame);
        if (assistantPlan && !assistantInstalled) {
          const planId = 'd'.repeat(32);
          const assistants = [
            {
              id: 'shimpz-cloudflare',
              name: 'Shimpz Cloudflare',
              summary: assistantSummary,
              providers: ['cloudflare'],
            },
            {
              id: 'whatsapp',
              name: 'WhatsApp',
              summary: 'Send reviewed WhatsApp messages.',
              providers: ['whatsapp'],
            },
          ];
          const sendPlan = (state, statuses) => socket.send(JSON.stringify({
            type: 'assistant-install-plan',
            state,
            plan_id: planId,
            team_id: 'marketing',
            assistants: assistants.map((assistant, index) => ({
              ...assistant,
              status: statuses[index],
            })),
          }));
          sendPlan('planned', ['pending', 'pending']);
          sendPlan('installing', ['installing', 'pending']);
          advanceAssistantPlan = () => {
            cloudflareInstalled = true;
            sendPlan('installing', ['installed', 'installing']);
          };
          releaseAssistantPlan = () => {
            assistantInstalled = true;
            sendPlan('installed', ['installed', 'installed']);
            socket.send(JSON.stringify({
              type: 'done',
              team_id: 'marketing',
              team_name: 'Marketing',
              reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
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
              assistant: {
                id: 'shimpz-cloudflare',
                name: 'Shimpz Cloudflare',
                summary: assistantSummary,
                version: '0.4.1',
              },
            }));
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
              summary: 'Reads reviewed zone and DNS metadata.',
              scopes: ['dns.read', 'dns.write', 'offline_access', 'zone.read'],
              actions: [{ id: 'list-zones', name: 'List zones', summary: 'Lists Cloudflare zones.' }],
            }],
          }));
          return;
        }
        if (humanKind) {
          humanPending = true;
          sendHumanChallenge();
          return;
        }
        socket.send(JSON.stringify({
          type: 'progress',
          seq: 1,
          origin: 'admin',
          phase: 'admin-preparation',
          state: 'finished',
          elapsed_ms: 19,
        }));
        const completeReply = () => socket.send(JSON.stringify(terminalError
          ? { type: 'error', status: 503, detail: 'synthetic runtime failure' }
          : {
              type: 'done',
              team_id: 'marketing',
              team_name: 'Marketing',
              reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
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
        socket.send(JSON.stringify({ type: 'stopped' }));
      }
    });
  });
  return {
    assistantIconRequests: () => assistantIconRequests,
    chatFrames: () => chatFrames,
    disconnectHumanSocket: () => disconnectHumanSocket(),
    humanResponses: () => humanResponses,
    inferenceWrites: () => inferenceWrites,
    advanceAssistantPlan: () => advanceAssistantPlan(),
    releaseAssistantPlan: () => releaseAssistantPlan(),
    releaseAssistantUninstall: () => releaseAssistantUninstall(),
    releaseAssistantInventory: () => releaseAssistantInventory(),
    releaseAssistantIcon: () => releaseAssistantIcon(),
    releaseInferenceWrite: () => releaseInferenceWrite(),
    releaseHumanResponse: () => releaseHumanResponse(),
    releaseReply: () => releaseReply(),
    syncFrames: () => syncFrames,
  };
}

test('setup surface is accessible and never overflows its viewport', async ({ page }) => {
  await routeSetup(page);
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
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

  await expect(page.locator('.provider-gate')).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(requests.inferenceWrites()).toBe(1);
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
  await expect(notices.nth(0)).toHaveClass(/shimpz-notice--success/);
  await expect(notices.nth(1)).toHaveClass(/shimpz-notice--warning/);
  await expect(notices.nth(2)).toHaveClass(/shimpz-notice--error/);
  await expect(notices.nth(0).locator('[data-slot="notice-icon"] circle')).toHaveCount(1);
  await expect(notices.nth(1).locator('[data-slot="notice-icon"] circle')).toHaveCount(0);
  await expect(notices.nth(2).locator('[data-slot="notice-icon"] path')).toHaveCount(2);
  expect((await new AxeBuilder({ page }).include('.shimpz-message--assistant').analyze()).violations)
    .toEqual([]);
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(notices.nth(0)).toHaveCSS('border-left-color', 'rgb(0, 0, 0)');
  await expect(page.getByText(/1 execution stages completed/i)).toBeVisible();
});

test('installs a composed Assistant plan automatically and continues the original task', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const chat = await routeReadyChat(page, {
    assistantPlan: true,
    holdAssistantPlan: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Configure my Cloudflare domain and send the result on WhatsApp');
  await page.getByRole('button', { name: 'Send' }).click();

  const tasks = page.locator('.assistant-install-plan [data-slot="chat-task"]');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.nth(0)).toContainText('Shimpz Cloudflare');
  await expect(tasks.nth(0)).toHaveAttribute('data-state', 'working');
  await expect(tasks.nth(1)).toContainText('WhatsApp');
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'pending');
  await expect(tasks.nth(0).locator('img')).toHaveAttribute(
    'src',
    '/api/assistants/shimpz-cloudflare/catalog-icon',
  );
  await expect(tasks.nth(1).locator('img')).toHaveAttribute(
    'src',
    '/api/assistants/whatsapp/catalog-icon',
  );
  await expect(page.getByRole('button', { name: /install/i })).toHaveCount(0);
  await expect(page.getByText(/confirmation required/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(await tasks.nth(0).evaluate((element) => getComputedStyle(element, '::after').backgroundColor))
    .toBe('rgb(252, 238, 10)');
  await expect(page.getByRole('group', { name: 'Assistant installation' })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

  chat.advanceAssistantPlan();
  await expect(tasks.nth(0)).toHaveAttribute('data-state', 'complete');
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'working');
  chat.releaseAssistantPlan();
  await expect(tasks.nth(1)).toHaveAttribute('data-state', 'complete');
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

test('uninstalls an Assistant from the inline proposal and confirms Team absence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await routeReadyChat(page, {
    assistantUninstall: true,
    holdAssistantIcon: true,
    holdAssistantUninstall: true,
  });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
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
  await expect(task).toContainText('Assistant uninstall');
  await expect(task).toContainText('Confirmation required');
  await expect(task).toContainText(
    'This removes the running Assistant, its Integration authorizations, and any pending work for it in this Team.',
  );
  const confirmation = task.getByText('Uninstall this Assistant from this Team?', { exact: true });
  await expect(confirmation).toHaveCSS('text-align', 'right');
  const icon = task.locator('img');
  await expect(icon).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  await expectTaskMediaBesideTitle(task);
  await expect(task.getByRole('button', { name: 'Cancel uninstalling Shimpz Cloudflare' }))
    .toBeEnabled();
  const uninstall = task.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeEnabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);

  await uninstall.click();
  await expect(task).toHaveAttribute('data-state', 'pending');
  expect(chat.chatFrames()).toHaveLength(1);
  chat.releaseAssistantIcon();
  await expect(page.getByText('yes', { exact: true })).toHaveCount(0);
  await expect(task).toHaveAttribute('data-state', 'working');
  expect(await task.evaluate((element) => getComputedStyle(element, '::after').backgroundColor))
    .toBe('rgb(252, 238, 10)');
  await expect(task).toBeFocused();
  chat.releaseAssistantUninstall();

  await expect(task).toHaveAttribute('data-state', 'complete');
  await expect(task).toContainText('Uninstalled');
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
  await expect(outcome).toContainText('You can install it again whenever you want.');
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

  await page.getByRole('button', { name: /Brain GPT-5\.6 Terra/i }).click();
  const brainDialog = page.getByRole('dialog', { name: 'Choose a Brain' });
  await brainDialog.getByText('GPT-5.6 Sol', { exact: true }).click();
  await expect.poll(chat.inferenceWrites).toBe(1);
  await expect.poll(
    () => chat.assistantIconRequests().some((url) => url.includes('/catalog-icon')),
  ).toBe(false);

  chat.releaseInferenceWrite();
});

test('cancels an Assistant uninstall without projecting a confirmation reply', async ({ page }) => {
  await routeReadyChat(page, { assistantUninstall: true });
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
});

test('renders the integrations drawer as a responsive Sheet surface', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-slot', 'drawer');
  await expect(drawer.getByRole('heading', { name: 'Shimpz Cloudflare' })).toBeVisible();
  await expect(drawer.getByText('v0.4.2', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Connected', { exact: true })).toHaveCount(0);
  await expect(drawer.locator('.integration-content')).not.toHaveAttribute('aria-live');
  await expect(drawer.locator('.integration-status')).toHaveAttribute('aria-live', 'polite');
  await expect(drawer.locator('.integration-status .assistant-groups')).toHaveCount(0);
  const toggle = drawer.locator('button[aria-controls="assistant-integration-group-shimpz-cloudflare"]');
  await expect(toggle).toHaveAccessibleName('Expand Shimpz Cloudflare');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveCSS('color', 'rgb(0, 240, 255)');
  await expect(toggle).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(drawer.getByText('Inspect Cloudflare zones and safely manage common DNS records through OAuth.', { exact: true })).toBeHidden();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox.width).toBeLessThanOrEqual((page.viewportSize().width * 0.92) + 1);
  const collapsedAxe = await new AxeBuilder({ page }).analyze();
  expect(collapsedAxe.violations).toEqual([]);
  await expect(drawer).toHaveScreenshot('integrations-drawer.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName('Collapse Shimpz Cloudflare');
  await expect(drawer.getByText('Inspect Cloudflare zones and safely manage common DNS records through OAuth.', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Safely manage Cloudflare DNS records through OAuth.', { exact: true })).toHaveCount(0);
  await expect(drawer.getByText('Reads reviewed zone and DNS metadata.', { exact: true })).toHaveCount(0);
  await expect(drawer.getByText('Permissions', { exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  const expandedAxe = await new AxeBuilder({ page }).analyze();
  expect(expandedAxe.violations).toEqual([]);
  await expect(drawer).toHaveScreenshot('integrations-drawer-expanded.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await page.getByRole('button', { name: 'Close integrations' }).click();
  await expect(drawer).toBeHidden();
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

for (const integrationStatus of ['missing', 'reauthorization-required', 'expired']) {
  test(`keeps ${integrationStatus} Integration metadata out of the Assistant summary card`, async ({ page }) => {
    await routeReadyChat(page, { integrationStatus });
    await page.goto('/chat/');

    await page.getByRole('button', { name: 'Assistant integrations' }).click();
    const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
    await drawer.getByRole('button', { name: 'Expand Shimpz Cloudflare' }).click();
    await expect(drawer.getByText('Inspect Cloudflare zones and safely manage common DNS records through OAuth.')).toBeVisible();
    await expect(drawer.getByText('Missing', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Reconnect required', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Expired', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Connected', { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  });
}

test('uses text actions and one semantic selected state in the Assistant chooser', async ({ page }) => {
  await routeReadyChat(page);
  let uninstalled = false;
  const uninstallMethods = [];
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', async (route) => {
    uninstallMethods.push(route.request().method());
    uninstalled = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: true }),
    });
  });
  await page.route('**/api/teams/marketing/assistants', (route) => {
    if (!uninstalled) return route.fallback();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ assistants: [] }),
    });
  });
  await page.goto('/chat/');

  await page.locator('.context-controls').getByRole('button').nth(2).click();
  const dialog = page.getByRole('dialog', { name: 'Choose Assistants' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  const selectAll = dialog.getByRole('button', { name: 'Select all', exact: true });
  const unselectAll = dialog.getByRole('button', { name: 'Unselect all', exact: true });
  await expect(selectAll).toHaveClass(/shimpz-text-action/);
  await expect(unselectAll).toHaveClass(/shimpz-text-action/);
  await expect(selectAll.locator('[data-slot="text-action-icon"]')).toBeVisible();
  const choice = dialog.getByRole('button', { name: 'Shimpz Cloudflare v0.4.1' });
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(choice.locator('img')).toHaveAttribute(
    'src',
    '/api/teams/marketing/assistants/shimpz-cloudflare/icon',
  );
  const uninstall = dialog.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' });
  await expect(uninstall).toBeVisible();
  const [choiceBox, uninstallBox] = await Promise.all([choice.boundingBox(), uninstall.boundingBox()]);
  expect(choiceBox).not.toBeNull();
  expect(uninstallBox).not.toBeNull();
  expect(uninstallBox.x).toBeGreaterThan(choiceBox.x + choiceBox.width);
  expect(Math.min(choiceBox.y + choiceBox.height, uninstallBox.y + uninstallBox.height)
    - Math.max(choiceBox.y, uninstallBox.y)).toBeGreaterThan(0);
  await expect(dialog).toHaveScreenshot('assistant-chooser.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await unselectAll.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'false');
  await expect(choice.locator('.selection-mark')).toHaveCount(0);

  await uninstall.click();
  let confirmation = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await expect(dialog).toBeHidden();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(choice).toBeVisible();

  await dialog.getByRole('button', { name: 'Uninstall Shimpz Cloudflare' }).click();
  confirmation = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await confirmation.getByRole('button', { name: 'Uninstall Assistant' }).click();
  await expect(confirmation).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('No running Assistants are available in this Team.');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(page.locator('[data-slot="toast"]')).toContainText(
    'Shimpz Cloudflare is no longer installed in Marketing.',
  );
  expect(uninstallMethods).toEqual(['DELETE']);
  const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(results.violations).toEqual([]);
});

test('keeps localized Assistant uninstall actions bounded and label-in-name compatible', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  for (const [locale, visibleLabel, direction] of [
    ['de', 'Deinstallieren', 'ltr'],
    ['ja', 'アンインストール', 'ltr'],
    ['ar', 'إلغاء التثبيت', 'rtl'],
  ]) {
    await page.evaluate((language) => localStorage.setItem('shimpz_lang', language), locale);
    await page.reload();
    await page.locator('.context-controls').getByRole('button').nth(2).click();
    const dialog = page.locator('dialog[open]');
    const row = dialog.locator('.assistant-choice-row');
    const choice = row.getByRole('button').first();
    const uninstall = row.getByRole('button').last();
    await expect(uninstall).toHaveText(visibleLabel);
    await expect(uninstall).toHaveAttribute('aria-label', new RegExp(visibleLabel));
    await expect(page.locator('html')).toHaveAttribute('dir', direction);
    expect(await uninstall.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const [dialogBox, choiceBox, uninstallBox] = await Promise.all([
      dialog.boundingBox(),
      choice.boundingBox(),
      uninstall.boundingBox(),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(choiceBox).not.toBeNull();
    expect(uninstallBox).not.toBeNull();
    expect(uninstallBox.x).toBeGreaterThanOrEqual(dialogBox.x);
    expect(uninstallBox.x + uninstallBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
    expect(
      Math.min(choiceBox.x + choiceBox.width, uninstallBox.x + uninstallBox.width)
      - Math.max(choiceBox.x, uninstallBox.x),
    ).toBeLessThanOrEqual(0);
    await dialog.getByRole('button', { name: {
      de: 'Schließen',
      ja: '閉じる',
      ar: 'إغلاق',
    }[locale] }).click();
  }
});

test('renders the fail-closed Integration challenge dialog', async ({ page }) => {
  await routeReadyChat(page, { integrationChallenge: true });
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('List the Cloudflare zones');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your Cloudflare account' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(
    'Action list-zones from the Shimpz Cloudflare v0.4.1 Assistant requires you to securely connect this Shimpz installation to your Cloudflare account, granting the Assistant these permissions:',
    { exact: true },
  )).toBeVisible();
  await expect(dialog.getByText('dns.read', { exact: true })).toBeVisible();
  const dynamicAction = dialog.locator('.context strong').first();
  await expect(dynamicAction).toHaveText('list-zones');
  await expect(dynamicAction).toHaveCSS('color', 'rgb(0, 240, 255)');
  await expect(dynamicAction).toHaveCSS('font-weight', '700');
  await expect(dialog.locator('[data-slot="card"]')).toHaveCount(0);
  const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(results.violations).toEqual([]);
  await expect(dialog).toHaveScreenshot('integration-required-dialog.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
});

test('renders dynamic Integration data in the current language', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'pt'));
  await routeReadyChat(page, {
    integrationChallenge: true,
    integrationRequirements: [{
      assistant_id: 'shimpz-cloudflare',
      assistant_name: 'Social Publisher',
      integration_id: 'x-integration',
      provider: 'x',
      name: 'X',
      summary: 'Publica posts aprovados.',
      scopes: ['tweet.read', 'tweet.write'],
      actions: [{ id: 'publish-post', name: 'Publicar post', summary: 'Publica um post aprovado.' }],
    }],
  });
  await page.goto('/chat/');

  await page.getByRole('textbox', { name: 'Enviar', exact: true }).fill('Publique o post');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Conecte sua conta X' });
  await expect(dialog).toContainText(
    'A ação publish-post do assistente Social Publisher v0.4.1 requer que você conecte esta instalação da Shimpz à sua conta X de forma segura',
  );
  await expect(dialog.getByText('tweet.write', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Autorizar no X' })).toBeVisible();
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
        summary: 'Reads reviewed Cloudflare zones.',
        scopes: ['zone.read'],
        actions: [{ id: 'list-zones', name: 'List zones', summary: 'Lists Cloudflare zones.' }],
      },
      {
        assistant_id: 'whatsapp',
        assistant_name: 'WhatsApp',
        integration_id: 'whatsapp-messages',
        provider: 'whatsapp',
        name: 'WhatsApp messages',
        summary: 'Sends reviewed WhatsApp messages.',
        scopes: ['messages.write'],
        actions: [{ id: 'send-message', name: 'Send message', summary: 'Sends one reviewed message.' }],
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
  test(`renders and completes the ${kind} Action request`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
    const contract = await routeReadyChat(page, { humanKind: kind });
    await page.goto('/chat/');
    const composer = page.getByRole('textbox', { name: 'Send', exact: true });
    await composer.fill('Continue with the reviewed Action');
    await page.getByRole('button', { name: 'Send' }).click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'Action list-zones from Shimpz Cloudflare v0.4.1 needs human validation. Expires in 300 seconds.',
    );
    await expect(dialog.locator('.request-context strong')).toHaveText([
      'list-zones',
      'Shimpz Cloudflare',
      'v0.4.1',
    ]);
    await expect(dialog.locator('.request-context strong').first()).toHaveCSS('color', 'rgb(0, 240, 255)');
    await expect(dialog).toContainText('Shimpz Cloudflare paused before continuing this exact Action.');
    await expect(dialog.getByText('Required', { exact: true })).toHaveCount(0);
    if (kind.startsWith('input:') && kind !== 'input:choice' && kind !== 'input:choices') {
      await expectVisuallyHidden(dialog.locator('label[for="human-request-value"]'));
    } else if (kind === 'input:choice' || kind === 'input:choices') {
      await expectVisuallyHidden(dialog.locator('fieldset legend'));
    } else if (kind === 'auth:password' || kind === 'auth:totp') {
      await expectVisuallyHidden(dialog.locator('label[for="human-request-auth"]'));
    }
    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations).toEqual([]);
    await expect(dialog).toHaveScreenshot(`human-${kind.replaceAll(':', '-')}.png`, {
      animations: 'disabled',
      maxDiffPixels: 150,
    });

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
          : kind.startsWith('auth:') ? 'Confirm authorization' : 'Send response',
    }).click();
    await expect(page.getByText('The reviewed human response was accepted.')).toBeVisible();
    expect(contract.humanResponses()).toHaveLength(1);
    expect(contract.humanResponses()[0]).toMatchObject({
      type: 'human-response',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      decision: 'submit',
    });
  });
}

test('updates the Action human request countdown without a page refresh', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
  await routeReadyChat(page, { humanKind: 'approval' });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog).toContainText('Expires in 300 seconds.');
  await page.clock.fastForward(1_000);
  await expect(dialog).toContainText('Expires in 299 seconds.');
  await page.clock.fastForward(2_000);
  await expect(dialog).toContainText('Expires in 297 seconds.');
});

test('closes and reconciles an expired Action human request', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
  const contract = await routeReadyChat(page, { humanKind: 'approval', humanExpiresIn: 3 });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();

  const dialog = page.getByRole('dialog', { name: 'Publish reviewed DNS changes?' });
  await expect(dialog).toContainText('Expires in 3 seconds.');
  await page.clock.fastForward(1_000);
  await expect(dialog).toContainText('Expires in 2 seconds.');
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
  await expect(dialog).toContainText('Expires in 3 seconds.');
  await page.clock.fastForward(3_000);

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Expires in 2 seconds.');
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
  await expect(dialog.getByRole('button', { name: 'Negar e interromper' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Confirmar autorização' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Estou processando...' })).toHaveCount(0);
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(dialog).toHaveScreenshot('human-auth-password-validating.png', {
    animations: 'disabled',
    maxDiffPixels: 150,
  });

  contract.releaseHumanResponse();

  const validation = page.getByRole('dialog', { name: 'Senha do Supervisor não confirmada' });
  await expect(validation).toBeVisible();
  await expect.poll(() => originalDialog?.evaluate((element) => element.isConnected)).toBe(true);
  await expect(validation).toContainText('Restam 2 tentativas antes de um bloqueio temporário.');
  await expect(validation.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled();
  await expect.poll(() => validation.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(validation).toHaveScreenshot('human-auth-password-validation.png', {
    animations: 'disabled',
    maxDiffPixels: 150,
  });
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
  await expect(locked).toHaveScreenshot('human-auth-password-locked.png', {
    animations: 'disabled',
    maxDiffPixels: 150,
  });
});

test('keeps authorization modal until Team progress proves password continuation', async ({ page }) => {
  const contract = await routeReadyChat(page, { humanKind: 'auth:password', holdHumanResponse: true });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Create the reviewed DNS record');
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
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Create the reviewed DNS record');
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

test('shows an accessible processing shimmer and honors display preferences', async ({ page }) => {
  const contract = await routeReadyChat(page, { holdReply: true });
  await page.goto('/chat/');
  await page.getByRole('button', { name: 'Language: English' }).click();
  await page.getByRole('menuitemradio', { name: 'Português' }).click();
  await page.getByRole('textbox', { name: 'Enviar', exact: true }).fill('Liste minhas zonas DNS');
  await page.getByRole('button', { name: 'Enviar' }).click();

  const processing = page.getByRole('group', { name: 'Estou processando...' });
  const label = processing.locator('strong');
  await expect(processing).toBeVisible();
  await expect(label).toHaveText('Estou processando...');
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).animationName))
    .toMatch(/text-shimmer$/);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).animationName))
    .toBe('none');
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).webkitTextFillColor))
    .not.toBe('rgba(0, 0, 0, 0)');

  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' });
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).animationName))
    .toBe('none');
  await expect.poll(() => label.evaluate((element) => getComputedStyle(element).webkitTextFillColor))
    .not.toBe('rgba(0, 0, 0, 0)');

  contract.releaseReply();
  await expect(page.getByText('Rendered answer')).toBeVisible();
  await expect(processing).toHaveCount(0);
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
  await routeReadyChat(page, { reply: longReply });
  await page.goto('/chat/');
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
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

test('keeps compact controls and stacked dialog actions usable at 360 pixels', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await routeReadyChat(page);
  await page.goto('/chat/');
  await page.getByRole('button', { name: /Team Marketing/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a Team' });
  const [closeBox, addBox, dialogBox] = await Promise.all([
    dialog.getByRole('button', { name: 'Close' }).boundingBox(),
    dialog.getByRole('button', { name: 'Add Team' }).boundingBox(),
    dialog.boundingBox(),
  ]);
  expect(closeBox).not.toBeNull();
  expect(addBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox.width).toBeLessThanOrEqual(328);
  expect(Math.abs(closeBox.width - addBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(closeBox.x - addBox.x)).toBeLessThanOrEqual(1);
  expect(addBox.y).toBeLessThan(closeBox.y);
});

test('keeps the empty Chat composer inside a reduced mobile viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile viewport contract');
  await routeReadyChat(page);
  await page.goto('/chat/');
  await page.setViewportSize({ width: 390, height: 520 });

  const input = page.getByRole('textbox', { name: 'Send', exact: true });
  const composer = page.locator('.composer');
  const main = page.locator('[data-slot="workspace-main"]');
  const tabs = page.locator('[data-slot="workspace-sidebar"]');
  await input.focus();
  await expect(input).toBeFocused();

  const [composerBox, mainBox, tabsBox] = await Promise.all([
    composer.boundingBox(),
    main.boundingBox(),
    tabs.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(composerBox.y).toBeGreaterThanOrEqual(mainBox.y);
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height);
  expect(Math.abs((mainBox.y + mainBox.height) - tabsBox.y)).toBeLessThan(1);
  expect(Math.abs((tabsBox.y + tabsBox.height) - page.viewportSize().height)).toBeLessThan(1);

  const overflow = await page.locator('html').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
});

test('reports confirmed Team deletion as animated success above Chat', async ({ page }) => {
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
  await page.getByRole('button', { name: /Team Marketing/i }).click();
  await page.getByRole('dialog', { name: 'Choose a Team' })
    .getByRole('button', { name: 'Delete Support' })
    .click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Team' });
  await deleteDialog.getByLabel('Confirm Team name').fill('Support');
  await deleteDialog.getByLabel('Supervisor password').fill('private-password');
  await deleteDialog.getByRole('button', { name: 'Delete Team' }).click();

  await expect(deleteDialog).toBeHidden();
  expect(deletionBody).toEqual({ team_name: 'Support', password: 'private-password' });
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Team deleted');
  await expect(toast).toContainText('Support and all of its data were securely deleted.');
  const progressStyle = await toast.locator('[data-slot="toast-progress"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.animationDuration, name: style.animationName };
    });
  expect(progressStyle.name).not.toBe('none');
  expect(progressStyle.duration).toBe('10s');
  const [toastBox, chatBox, mainBox, sidebarBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.chat-route').boundingBox(),
    page.locator('[data-slot="workspace-main"]').boundingBox(),
    page.locator('[data-slot="workspace-sidebar"]').boundingBox(),
  ]);
  expect(toastBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(Math.abs(toastBox.x - mainBox.x)).toBeLessThan(1);
  expect(Math.abs(toastBox.y - mainBox.y)).toBeLessThan(1);
  expect(Math.abs(toastBox.width - mainBox.width)).toBeLessThan(1);
  if (page.viewportSize().width <= 820) {
    expect(Math.abs(toastBox.x)).toBeLessThan(1);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(sidebarBox.y);
  } else {
    expect(Math.abs(toastBox.x - (sidebarBox.x + sidebarBox.width))).toBeLessThan(1);
    expect(Math.abs(toastBox.y)).toBeLessThan(1);
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    await expect(toast).toHaveCSS(`border-${side}-width`, '0px');
  }
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(chatBox.y);
  await expect(page).toHaveScreenshot('team-deletion-alert.png', visualContract);
});

test('keeps Assistant lifecycle feedback clear of Chat actions', async ({ page }) => {
  await routeReadyChat(page);
  await routeAssistantStoreUninstall(page);
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: false }),
  }));

  await page.goto('/assistants/');
  await page.frameLocator('iframe').getByRole('button', { name: 'Uninstall' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Shimpz Cloudflare is no longer installed in Marketing.');
  await expect(toast).toHaveCSS('position', 'relative');
  const [toastOnStoreBox, introBox, mainBox, sidebarBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.shimpz-page-intro').boundingBox(),
    page.locator('[data-slot="workspace-main"]').boundingBox(),
    page.locator('[data-slot="workspace-sidebar"]').boundingBox(),
  ]);
  expect(toastOnStoreBox).not.toBeNull();
  expect(introBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(Math.abs(toastOnStoreBox.x - mainBox.x)).toBeLessThan(1);
  expect(Math.abs(toastOnStoreBox.y - mainBox.y)).toBeLessThan(1);
  expect(Math.abs(toastOnStoreBox.width - mainBox.width)).toBeLessThan(1);
  if (page.viewportSize().width <= 820) {
    expect(Math.abs(toastOnStoreBox.x)).toBeLessThan(1);
    expect(toastOnStoreBox.y + toastOnStoreBox.height).toBeLessThanOrEqual(sidebarBox.y);
  } else {
    expect(Math.abs(toastOnStoreBox.x - (sidebarBox.x + sidebarBox.width))).toBeLessThan(1);
    expect(Math.abs(toastOnStoreBox.y)).toBeLessThan(1);
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    await expect(toast).toHaveCSS(`border-${side}-width`, '0px');
  }
  expect(toastOnStoreBox.y + toastOnStoreBox.height).toBeLessThanOrEqual(introBox.y);
  await expect(page).toHaveScreenshot('assistant-lifecycle-alert.png', visualContract);
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  const [toastBox, actionsBox, chatBox] = await Promise.all([
    toast.boundingBox(),
    page.locator('.composer-actions').boundingBox(),
    page.locator('.chat-route').boundingBox(),
  ]);
  expect(toastBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(chatBox.y);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(page.viewportSize().height);
  const intersectsActions = (
    toastBox.x < actionsBox.x + actionsBox.width &&
    toastBox.x + toastBox.width > actionsBox.x &&
    toastBox.y < actionsBox.y + actionsBox.height &&
    toastBox.y + toastBox.height > actionsBox.y
  );
  expect(intersectsActions).toBe(false);
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
  await page.frameLocator('iframe').getByRole('button', { name: 'Uninstall' }).click();
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
            summary: 'Safely manage Cloudflare DNS records through OAuth.',
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
          }]
          : [],
      }),
    });
  });
  await page.route('**/api/teams/marketing/files', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ files: [] }),
  }));
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body data-status="loading" data-installed="">
      <button type="button">Install</button>
      <script>
        parent.postMessage({ type: 'shimpz:assistant-store-frame', version: 2, height: 420 }, '*');
        window.addEventListener('message', (event) => {
          if (event.data?.type !== 'shimpz:assistant-store-state') return;
          document.body.dataset.status = event.data.status;
          document.body.dataset.installed = event.data.installed.join(',');
        });
        document.querySelector('button').addEventListener('click', () => parent.postMessage({
          type: 'shimpz:assistant-install',
          version: 2,
          assistant: 'shimpz-cloudflare',
          source_digest: 'sha256:${'4'.repeat(64)}'
        }, '*'));
      </script>
    </body></html>`,
  }));

  await page.goto('/assistants/');
  await page.frameLocator('iframe').getByRole('button', { name: 'Install' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install this Assistant?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm install' }).click();

  await expect(page.locator('[data-slot="toast"]')).toContainText(
    'Shimpz Cloudflare is ready in Marketing.',
  );
  await expect(page.getByText('The installed Assistant inventory is invalid.', { exact: true })).toHaveCount(0);
  await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute('data-status', 'ready');
  await expect(page.frameLocator('iframe').locator('body')).toHaveAttribute(
    'data-installed',
    'shimpz-cloudflare',
  );
  expect(catalogReads).toBeGreaterThanOrEqual(2);
});

test('matches the ready Chat visual contract without horizontal overflow', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await expect(page.getByRole('textbox', { name: 'Send', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  await expect(page).toHaveScreenshot('chat-ready.png', visualContract);

  await page.getByRole('button', { name: /Brain GPT-5\.6 Terra/i }).click();
  const brainDialog = page.getByRole('dialog', { name: 'Choose a Brain' });
  await expect(brainDialog).toBeVisible();
  await expect(brainDialog.getByText('Current', { exact: true })).toHaveCount(0);
  const selectedModel = brainDialog.getByText('GPT-5.6 Terra', { exact: true });
  const selectedProvider = brainDialog.getByText('OpenAI', { exact: true }).nth(1);
  const [modelBox, providerBox] = await Promise.all([
    selectedModel.boundingBox(),
    selectedProvider.boundingBox(),
  ]);
  expect(modelBox).not.toBeNull();
  expect(providerBox).not.toBeNull();
  expect(providerBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('brain-chooser.png', visualContract);

  await brainDialog.getByRole('button', { name: 'Close' }).click();
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  const userMessage = page.getByRole('article', { name: 'You' });
  await expect(userMessage).toBeVisible();
  expect(await userMessage.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  const [messageBox, exchangeBox] = await Promise.all([
    userMessage.boundingBox(),
    userMessage.locator('xpath=..').boundingBox(),
  ]);
  expect(messageBox).not.toBeNull();
  expect(exchangeBox).not.toBeNull();
  expect(Math.abs((messageBox.x + messageBox.width) - (exchangeBox.x + exchangeBox.width)))
    .toBeLessThanOrEqual(1);
  const receipt = page.locator('.receipt');
  await expect(receipt).toHaveCSS('border-top-width', '0px');
  await expect(page).toHaveScreenshot('chat-completed.png', visualContract);
});
