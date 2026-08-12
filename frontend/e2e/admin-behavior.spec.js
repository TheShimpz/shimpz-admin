import { readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const modelCatalog = JSON.parse(
  readFileSync(new URL('../src/lib/modelCatalog.json', import.meta.url), 'utf8'),
);

const visualContract = {
  animations: 'disabled',
  fullPage: true,
  maxDiffPixels: 100,
};

async function expectVisuallyHidden(locator) {
  await expect(locator).toHaveClass(/visually-hidden/);
  expect(await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, clipPath: style.clipPath };
  })).toEqual({ width: 1, height: 1, clipPath: 'inset(50%)' });
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
    body: JSON.stringify({ profile: 'local', authenticated: false, initialized: false }),
  }));
}

function humanRequest(kind) {
  const base = {
    kind,
    ordinal: 0,
    title: {
      approval: 'Publish reviewed DNS changes?',
      'auth:reauth': 'Confirm with your Supervisor password',
      'auth:second-factor': 'Confirm with your second factor',
      'auth:phishing-resistant': 'Confirm with your passkey',
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
  disconnectHumanResponse = false,
  holdHumanResponse = false,
  humanKind = '',
  humanRejections = [],
  integrationChallenge = false,
  integrationRequirements,
  missingInference = false,
  reply,
} = {}) {
  let inferenceWrites = 0;
  const humanResponses = [];
  let chatConnections = 0;
  let disconnectHumanSocket = () => {};
  let releaseHumanResponse = () => {};
  let humanPending = false;
  let humanRejectionIndex = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Unavailable outside this rendered contract.' }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
  }));
  await page.route('**/api/teams', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }] }),
  }));
  await page.route('**/api/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistants: [{ id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare' }] }),
  }));
  await page.route('**/api/teams/marketing/assistants', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      assistants: [{
        assistant: 'shimpz-cloudflare',
        assistant_version: '0.4.1',
        status: 'running',
      }],
    }),
  }));
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare/icon', (route) => route.fulfill({
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
  await page.route('**/api/teams/marketing/inference', (route) => {
    if (missingInference && route.request().method() === 'GET') {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'not configured' }),
      });
    }
    if (route.request().method() === 'PUT') inferenceWrites += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' }),
    });
  });
  await page.route('**/api/teams/marketing/assistant-integrations', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      integrations: [{
        assistant_id: 'shimpz-cloudflare',
        assistant_name: 'Shimpz Cloudflare',
        id: 'cloudflare',
        provider: 'cloudflare',
        name: 'Cloudflare',
        summary: 'Reads reviewed zone and DNS metadata.',
        scopes: ['dns.read', 'dns.write', 'offline_access', 'zone.read'],
        status: 'connected',
        integration: { id: 'account-1', name: 'Shimpz', username: null },
        expires_at: '2026-08-31T12:00:00.000Z',
      }],
    }),
  }));
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    const connection = chatConnections;
    chatConnections += 1;

    const sendHumanChallenge = () => socket.send(JSON.stringify({
      type: 'human-required',
      challenge_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expires_in: 300,
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
        if (disconnectHumanResponse && connection > 0 && humanPending) {
          sendHumanChallenge();
          return;
        }
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      } else if (frame.type === 'chat') {
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
        socket.send(JSON.stringify({
          type: 'done',
          team_id: 'marketing',
          team_name: 'Marketing',
          reply: reply ?? '**Rendered answer** with a [safe link](https://example.com).',
        }));
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
      }
    });
  });
  return {
    disconnectHumanSocket: () => disconnectHumanSocket(),
    humanResponses: () => humanResponses,
    inferenceWrites: () => inferenceWrites,
    releaseHumanResponse: () => releaseHumanResponse(),
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
  await routeReadyChat(page);
  await page.goto('/chat/');

  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Show the rendered response');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Rendered answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com/');
  await expect(page.getByText(/1 execution stages completed/i)).toBeVisible();
});

test('renders the integrations drawer as a responsive Sheet surface', async ({ page }) => {
  await routeReadyChat(page);
  await page.goto('/chat/');

  await page.getByRole('button', { name: 'Assistant integrations' }).click();
  const drawer = page.getByRole('complementary', { name: 'Connected integrations' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-slot', 'drawer');
  await expect(drawer.getByRole('heading', { name: 'Shimpz Cloudflare' })).toBeVisible();
  await expect(drawer.getByText('Connected', { exact: true })).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox.width).toBeLessThanOrEqual((page.viewportSize().width * 0.92) + 1);
  const drawerAxe = await new AxeBuilder({ page }).analyze();
  expect(drawerAxe.violations).toEqual([]);
  await expect(drawer).toHaveScreenshot('integrations-drawer.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await page.getByRole('button', { name: 'Close integrations' }).click();
  await expect(drawer).toBeHidden();
});

test('uses text actions and one semantic selected state in the Assistant chooser', async ({ page }) => {
  await routeReadyChat(page);
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
  await expect(dialog).toHaveScreenshot('assistant-chooser.png', {
    animations: 'disabled',
    maxDiffPixels: 100,
  });
  await unselectAll.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'false');
  await expect(choice.locator('.selection-mark')).toHaveCount(0);
  const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
  expect(results.violations).toEqual([]);
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

test('presents one dynamic authorization at a time for a shared provider', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeOpen = window.open;
    window.open = function captureAuthorizationState(...args) {
      const buttons = document.querySelectorAll('dialog[open] button');
      const authorizeButton = buttons.item(buttons.length - 1);
      window.authorizationStateAtOpen = {
        disabled: authorizeButton?.disabled ?? false,
        text: authorizeButton?.textContent?.trim() ?? '',
      };
      return nativeOpen.apply(this, args);
    };
  });
  await routeReadyChat(page, {
    integrationChallenge: true,
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
        assistant_id: 'shimpz-cloudflare',
        assistant_name: 'Shimpz Cloudflare',
        integration_id: 'cloudflare-dns',
        provider: 'cloudflare',
        name: 'Cloudflare DNS',
        summary: 'Changes reviewed Cloudflare DNS records.',
        scopes: ['dns.write'],
        actions: [{ id: 'change-dns', name: 'Change DNS', summary: 'Changes one DNS record.' }],
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
  await expect(dialog).toContainText('Start with Cloudflare, using only these reviewed permissions');
  await expect(dialog.getByText('zone.read', { exact: true })).toBeVisible();
  await expect(dialog.getByText('dns.write', { exact: true })).toHaveCount(0);
  const authorize = dialog.getByRole('button', { name: 'Authorize next integration' });
  const popupPromise = page.waitForEvent('popup');
  await authorize.click();
  const popup = await popupPromise;
  expect(await page.evaluate(() => window.authorizationStateAtOpen)).toEqual({
    disabled: true,
    text: 'Opening Cloudflare…',
  });
  await expect(dialog.getByRole('button', { name: 'Opening Cloudflare…' })).toBeDisabled();
  await expect.poll(() => Boolean(authorizeRoute)).toBe(true);
  await authorizeRoute.abort();
  await popup.close();
});

test('navigates the built Local app through its exact OAuth handoff', async ({ page }) => {
  const challengeId = 'b'.repeat(32);
  const authorizationUrl = 'https://shimpz.com/api/oauth/cloudflare/start?'
    + `state=${'s'.repeat(43)}&code_challenge=${'c'.repeat(43)}`
    + '&scope=dns.read+dns.write+offline_access+zone.read&callback=out-of-band';
  await routeReadyChat(page, { integrationChallenge: true });
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
  await routeReadyChat(page, { integrationChallenge: true });
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
  ['auth:reauth', 'Confirm with your Supervisor password'],
  ['auth:second-factor', 'Confirm with your second factor'],
  ['auth:phishing-resistant', 'Confirm with your passkey'],
];

for (const [kind, title] of humanPresentations) {
  test(`renders and completes the ${kind} Action request`, async ({ page }) => {
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
    await expect(dialog).not.toContainText('List reviewed Cloudflare zones.');
    await expect(dialog.getByText('Required', { exact: true })).toHaveCount(0);
    if (kind.startsWith('input:') && kind !== 'input:choice' && kind !== 'input:choices') {
      await expectVisuallyHidden(dialog.locator('label[for="human-request-value"]'));
    } else if (kind === 'input:choice' || kind === 'input:choices') {
      await expectVisuallyHidden(dialog.locator('fieldset legend'));
    } else if (kind === 'auth:reauth' || kind === 'auth:second-factor') {
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
    } else if (kind === 'auth:reauth') {
      await dialog.getByLabel('Confirm authorization').fill('supervisor-password');
    } else if (kind === 'auth:second-factor') {
      await dialog.getByLabel('Verification code').fill('123456');
    }
    await dialog.getByRole('button', {
      name: kind === 'approval'
        ? 'Approve action'
        : kind === 'auth:phishing-resistant'
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

test('restores Supervisor reauthentication as a focused validation modal', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    holdHumanResponse: true,
    humanKind: 'auth:reauth',
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
  await dialog.getByLabel('Confirmar autorização').fill('senha-incorreta');
  await dialog.getByRole('button', { name: 'Confirmar autorização' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirmando a senha do Supervisor…');
  await expect(dialog.getByLabel('Confirmar autorização')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Negar e interromper' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Confirmar autorização' })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Seu Time está pensando…' })).toHaveCount(0);
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(dialog).toHaveScreenshot('human-auth-reauth-validating.png', {
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
  await expect(validation).toHaveScreenshot('human-auth-reauth-validation.png', {
    animations: 'disabled',
    maxDiffPixels: 150,
  });
  await expect(page.getByText(/Detalhe técnico/)).toHaveCount(0);
  expect(contract.humanResponses()).toHaveLength(1);

  await validation.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
});

test('blocks Supervisor reauthentication retry behind the server countdown', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-09T12:00:00Z') });
  await routeReadyChat(page, {
    humanKind: 'auth:reauth',
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
  await request.getByLabel('Confirm authorization').fill('incorrect-password');
  await request.getByRole('button', { name: 'Confirm authorization' }).click();

  const locked = page.getByRole('dialog', { name: 'Password attempts temporarily blocked' });
  await expect(locked).toBeVisible();
  await expect(locked.getByRole('button', { name: 'Try again in 60 s' })).toBeDisabled();
  await expect(locked).toContainText('may expire before reauthentication is completed');
  await expect(locked).toHaveScreenshot('human-auth-reauth-locked.png', {
    animations: 'disabled',
    maxDiffPixels: 150,
  });
});

test('keeps authorization modal until Team progress proves reauthentication continued', async ({ page }) => {
  const contract = await routeReadyChat(page, { humanKind: 'auth:reauth', holdHumanResponse: true });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Create the reviewed DNS record');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Confirm authorization').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await expect(dialog.getByLabel('Confirm authorization')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Your Team is thinking…' })).toHaveCount(0);
  contract.releaseHumanResponse();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Your Team is thinking…' })).toBeVisible();
  expect(contract.humanResponses()).toHaveLength(1);
});

test('reopens the Team-owned human request when reconnect sync proves it is still pending', async ({ page }) => {
  const contract = await routeReadyChat(page, {
    disconnectHumanResponse: true,
    humanKind: 'auth:reauth',
  });
  await page.goto('/chat/');
  await page.getByRole('textbox', { name: 'Send', exact: true }).fill('Create the reviewed DNS record');
  await page.getByRole('button', { name: 'Send' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with your Supervisor password' });
  await dialog.getByLabel('Confirm authorization').fill('supervisor-password');
  await dialog.getByRole('button', { name: 'Confirm authorization' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Confirming your Supervisor password…');
  await expect(page.getByRole('group', { name: 'Your Team is thinking…' })).toHaveCount(0);
  contract.disconnectHumanSocket();
  await expect(page.getByRole('dialog', { name: 'Confirm with your Supervisor password' })).toBeVisible();
  expect(contract.humanResponses()).toHaveLength(1);
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
    expect(Math.abs(toastBox.y - (sidebarBox.y + sidebarBox.height))).toBeLessThan(1);
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
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><button type="button">Uninstall</button><script>
      parent.postMessage({ type: 'shimpz:assistant-store-frame', version: 2, height: 420 }, '*');
      document.querySelector('button').addEventListener('click', () => parent.postMessage({
        type: 'shimpz:assistant-uninstall', version: 2, assistant: 'shimpz-cloudflare'
      }, '*'));
    </script></body></html>`,
  }));
  await page.route('**/api/teams/marketing/assistants/shimpz-cloudflare', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ assistant: 'shimpz-cloudflare', uninstalled: true }),
  }));

  await page.goto('/assistants/');
  await page.frameLocator('iframe').getByRole('button', { name: 'Uninstall' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall Shimpz Cloudflare?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Uninstall Assistant' }).click();
  const toast = page.locator('[data-slot="toast"]');
  await expect(toast).toContainText('Shimpz Cloudflare was removed from Marketing.');
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
    expect(Math.abs(toastOnStoreBox.y - (sidebarBox.y + sidebarBox.height))).toBeLessThan(1);
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
    body: JSON.stringify({ profile: 'local', authenticated: true, origin_admitted: true }),
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
          ? [{ id: 'shimpz-cloudflare', title: 'Shimpz Cloudflare' }]
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
