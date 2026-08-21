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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function expectUniformLetterRhythm(boxes) {
  const pitches = boxes.slice(1).map((box, index) => box.x - boxes[index].x);
  expect(pitches).toHaveLength(5);
  expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThan(0.5);
  for (let index = 0; index < pitches.length; index += 1) {
    expect(Math.abs(pitches[index] - boxes[index].width)).toBeLessThan(0.25);
  }
}

async function routeSession(page, response, gate = null) {
  const requested = deferred();
  await page.route('**/api/session', async (route) => {
    requested.resolve();
    if (gate) await gate.promise;
    await json(route, response.body, response.status);
  });
  return requested;
}

async function routeReadyChat(page, { teamGate, inferenceGate }) {
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, {
      teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/files', (route) => json(route, { files: [] }));
  await page.route('**/api/model-providers', (route) => json(route, {
    providers: modelCatalog.providers.map(({ credential_validation: _credential, ...provider }) => ({
      ...provider,
      configured: true,
      masked: '••••1234',
    })),
  }));
  await page.route('**/api/teams/marketing/inference', async (route) => {
    await inferenceGate.promise;
    await json(route, { team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' });
  });
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    socket.onMessage((message) => {
      if (JSON.parse(message).type === 'sync') {
        socket.send(JSON.stringify({ type: 'sync-empty' }));
      }
    });
  });
}

test('shows only the centered animated Shimpz mark while the session is unresolved', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: localSession(),
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;

  const boot = page.locator('[data-slot="boot-screen"]');
  const composition = page.locator('[data-slot="boot-composition"]');
  const mark = page.locator('[data-slot="boot-mark"]');
  const wordmark = page.locator('[data-slot="boot-wordmark"]');
  const markImage = mark.locator('img');
  const letters = page.locator('[data-slot="boot-letter"]');
  await expect(boot).toBeVisible();
  await expect(page.locator('[data-slot="boot-label"]')).toHaveText(/\S/);
  await expect(page.locator('.initial-content')).toHaveAttribute('inert', '');
  await expect(page.locator('.auth-stage')).toBeHidden();
  await expect(boot).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(composition).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('[data-slot="binary-loader"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="binary-glyph"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="boot-brand"]')).toHaveCount(0);
  await expect(letters).toHaveText(['S', 'H', 'I', 'M', 'P', 'Z']);
  await expect(letters.first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect.poll(() => markImage.evaluate(
    (image) => image.complete && image.naturalWidth > 0,
  )).toBe(true);
  expect(await letters.first().evaluate(
    (element) => getComputedStyle(element).fontFamily.includes('IBM Plex Mono'),
  )).toBe(true);
  expect(await page.evaluate(async () => {
    await document.fonts.load('700 24px "IBM Plex Mono"', 'SHIMPZ');
    return document.fonts.check('700 24px "IBM Plex Mono"', 'SHIMPZ');
  })).toBe(true);
  await expect(wordmark).toHaveText('SHIMPZ');
  const [bootBox, compositionBox, markBox, wordmarkBox, letterBoxes, viewport] = await Promise.all([
    boot.boundingBox(),
    composition.boundingBox(),
    mark.boundingBox(),
    wordmark.boundingBox(),
    letters.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })),
    page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    })),
  ]);
  expect(bootBox).not.toBeNull();
  expect(compositionBox).not.toBeNull();
  expect(markBox).not.toBeNull();
  expect(wordmarkBox).not.toBeNull();
  expect(Math.abs(bootBox.x)).toBeLessThan(1);
  expect(Math.abs(bootBox.y)).toBeLessThan(1);
  expect(Math.abs(bootBox.width - viewport.width)).toBeLessThan(1);
  expect(Math.abs(bootBox.height - viewport.height)).toBeLessThan(1);
  expect(Math.abs(
    compositionBox.x + (compositionBox.width / 2) - (viewport.width / 2),
  )).toBeLessThan(1);
  expect(Math.abs(
    compositionBox.y + (compositionBox.height / 2) - (viewport.height / 2),
  )).toBeLessThan(1);
  expect(Math.abs(
    markBox.x + (markBox.width / 2) - wordmarkBox.x - (wordmarkBox.width / 2),
  )).toBeLessThan(1);
  const letterSpacing = await wordmark.evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).letterSpacing),
  );
  const opticalLeft = letterBoxes[0].x;
  const opticalRight = letterBoxes.at(-1).x + letterBoxes.at(-1).width - letterSpacing;
  expect(Math.abs(
    ((opticalLeft + opticalRight) / 2) - markBox.x - (markBox.width / 2),
  )).toBeLessThan(0.5);
  const markToWordmarkGap = wordmarkBox.y - markBox.y - markBox.height;
  expect(Math.abs(markToWordmarkGap - 2.8)).toBeLessThan(0.25);
  const animatedLetterCenter = letterBoxes.reduce(
    (total, box) => total + box.y + (box.height / 2),
    0,
  ) / letterBoxes.length;
  expect(Math.abs(
    animatedLetterCenter - wordmarkBox.y - (wordmarkBox.height / 2),
  )).toBeLessThan(1);
  expectUniformLetterRhythm(letterBoxes);
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: originalViewport.height });
  const [fluidMarkBox, fluidWordmarkFontSize] = await Promise.all([
    mark.boundingBox(),
    wordmark.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  expect(fluidMarkBox).not.toBeNull();
  expect(Math.abs(fluidMarkBox.width - 112)).toBeLessThan(0.25);
  expect(Math.abs(fluidWordmarkFontSize - 22.4)).toBeLessThan(0.25);
  await page.setViewportSize(originalViewport);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const rtlLetterBoxes = await letters.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  expectUniformLetterRhythm(rtlLetterBoxes);
  const [rtlMarkBox, rtlWordmarkBox] = await Promise.all([
    mark.boundingBox(),
    wordmark.boundingBox(),
  ]);
  expect(rtlMarkBox).not.toBeNull();
  expect(rtlWordmarkBox).not.toBeNull();
  expect(Math.abs(
    rtlWordmarkBox.x + (rtlWordmarkBox.width / 2) - rtlMarkBox.x - (rtlMarkBox.width / 2),
  )).toBeLessThan(1);
  await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page).toHaveScreenshot('boot-screen.png', visualContract);
  sessionGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('moves all six Shimpz letters vertically in exact counterphase', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: localSession(),
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const letters = page.locator('[data-slot="boot-letter"]');
  await expect(letters).toHaveText(['S', 'H', 'I', 'M', 'P', 'Z']);
  expect(await letters.evaluateAll((elements) => elements.every(
    (element) => getComputedStyle(element).animationName.endsWith('letter-swing'),
  ))).toBe(true);
  const motion = await letters.evaluateAll((elements) => {
    const mark = document.querySelector('[data-slot="boot-mark"]');
    const wordmark = document.querySelector('[data-slot="boot-wordmark"]');
    const animations = elements.map((element) => element.getAnimations()[0]);
    animations.forEach((animation) => animation.pause());
    const sample = (time) => {
      animations.forEach((animation) => { animation.currentTime = time; });
      const markBox = mark.getBoundingClientRect();
      const wordmarkBox = wordmark.getBoundingClientRect();
      const centers = elements.map((element) => {
        const box = element.getBoundingClientRect();
        return box.y + (box.height / 2);
      });
      return {
        centers,
        centroid: centers.reduce((total, center) => total + center, 0) / centers.length,
        axis: wordmarkBox.y + (wordmarkBox.height / 2),
        opticalGap: Math.min(...elements.map(
          (element) => element.getBoundingClientRect().y,
        )) - markBox.bottom,
      };
    };
    const start = sample(0);
    const midpoint = sample(250);
    const opposite = sample(500);
    animations.forEach((animation) => animation.cancel());
    return { start, midpoint, opposite };
  });
  for (const sample of [motion.start, motion.midpoint, motion.opposite]) {
    expect(Math.abs(sample.centroid - sample.axis)).toBeLessThan(1);
  }
  expect(Math.abs(motion.start.opticalGap - 2.8)).toBeLessThan(0.25);
  expect(Math.abs(motion.opposite.opticalGap - 2.8)).toBeLessThan(0.25);
  expect(Math.abs(motion.midpoint.opticalGap - 7.55)).toBeLessThan(0.25);
  for (let index = 0; index < motion.start.centers.length; index += 1) {
    expect(Math.abs(Math.abs(
      motion.start.centers[index] - motion.start.axis,
    ) - 4.75)).toBeLessThan(0.1);
    expect(Math.abs(Math.abs(
      motion.opposite.centers[index] - motion.opposite.axis,
    ) - 4.75)).toBeLessThan(0.1);
    expect(Math.abs(
      motion.midpoint.centers[index] - motion.midpoint.axis,
    )).toBeLessThan(0.1);
  }
  for (const sample of [motion.start, motion.opposite]) {
    for (let index = 1; index < sample.centers.length; index += 1) {
      expect(Math.sign(sample.centers[index - 1] - sample.axis)).toBe(
        -Math.sign(sample.centers[index] - sample.axis),
      );
    }
  }
  sessionGate.resolve();
});

test('keeps one boot surface through Team and model hydration, then focuses usable Chat', async ({ page }) => {
  const teamGate = deferred();
  const inferenceGate = deferred();
  await routeReadyChat(page, { teamGate, inferenceGate });

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  await expect(page.locator('.chat-route')).toBeHidden();

  const inferenceRequest = page.waitForRequest('**/api/teams/marketing/inference');
  teamGate.resolve();
  await inferenceRequest;
  await expect(boot).toBeVisible();
  await expect(page.locator('.chat-route')).toBeHidden();

  inferenceGate.resolve();
  const composer = page.getByRole('textbox', { name: 'Send', exact: true });
  await expect(boot).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
});

test('releases to the empty-Team final state without waiting for a model request', async ({ page }) => {
  const teamGate = deferred();
  let inferenceRequests = 0;
  page.on('request', (request) => {
    if (/\/api\/teams\/[^/]+\/inference$/.test(new URL(request.url()).pathname)) {
      inferenceRequests += 1;
    }
  });
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { teams: [] });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Create a Team below to start chatting.')).toBeVisible();
  expect(inferenceRequests).toBe(0);
});

test('keeps boot visible across the authenticated root redirect', async ({ page }) => {
  const teamGate = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { teams: [] });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect(page.locator('.chat-route')).toBeHidden();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Create a Team below to start chatting.')).toBeVisible();
});

test('releases to the final Chat error when Team hydration fails', async ({ page }) => {
  const teamGate = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, { detail: 'Team catalog unavailable.' }, 503);
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));

  await page.goto('/chat/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  teamGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Local chat data is unavailable.')).toBeVisible();
  await expect(page.getByText('Technical detail: Team catalog unavailable.')).toBeVisible();
});

test('releases a non-Chat route after Team hydration without waiting for a model', async ({ page }) => {
  const teamGate = deferred();
  const inferenceGate = deferred();
  await page.route('**/api/**', (route) => json(
    route,
    { detail: 'Unavailable outside this boot contract.' },
    503,
  ));
  await routeSession(page, {
    body: authenticatedLocalSession({ oauth_completion_mode: 'automatic' }),
  });
  await page.route('**/api/teams', async (route) => {
    await teamGate.promise;
    await json(route, {
      teams: [{ team_id: 'marketing', team_name: 'Marketing', status: 'running' }],
    });
  });
  await page.route('**/api/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/assistants', (route) => json(route, { assistants: [] }));
  await page.route('**/api/teams/marketing/files', (route) => json(route, { files: [] }));
  await page.route('**/api/model-providers', (route) => json(route, {
    providers: modelCatalog.providers.map(({ credential_validation: _credential, ...provider }) => ({
      ...provider,
      configured: true,
      masked: '••••1234',
    })),
  }));
  await page.route('**/api/teams/marketing/inference', async (route) => {
    await inferenceGate.promise;
    await json(route, { team_id: 'marketing', provider: 'openai', model: 'gpt-5.6-terra' });
  });
  await page.route('https://shimpz.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0;background:#000"></body></html>',
  }));

  await page.goto('/assistants/');
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  const inferenceRequest = page.waitForRequest('**/api/teams/marketing/inference');
  teamGate.resolve();
  await inferenceRequest;
  await expect(boot).toHaveCount(0);
  await expect(page.getByText('Loading the Assistant Store…')).toBeVisible();
  inferenceGate.resolve();
});

test('releases to retry when the session check reaches an error', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    status: 503,
    body: { detail: 'Unavailable' },
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const boot = page.locator('[data-slot="boot-screen"]');
  await expect(boot).toBeVisible();
  sessionGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('keeps a stable Shimpz wordmark when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: localSession(),
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const wordmark = page.locator('[data-slot="boot-wordmark"]');
  const letters = page.locator('[data-slot="boot-letter"]');
  await expect(letters).toHaveText(['S', 'H', 'I', 'M', 'P', 'Z']);
  expect(await letters.evaluateAll((elements) => elements.every(
    (element) => getComputedStyle(element).animationName === 'none',
  ))).toBe(true);
  const [wordmarkBox, letterBoxes] = await Promise.all([
    wordmark.boundingBox(),
    letters.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })),
  ]);
  expect(wordmarkBox).not.toBeNull();
  for (const box of letterBoxes) {
    expect(Math.abs(box.y + (box.height / 2) - (wordmarkBox.y + (wordmarkBox.height / 2)))).toBeLessThan(1);
  }
  for (let index = 1; index < letterBoxes.length; index += 1) {
    expect(letterBoxes[index - 1].x + letterBoxes[index - 1].width).toBeLessThanOrEqual(
      letterBoxes[index].x,
    );
  }
  expect(Math.abs(
    wordmarkBox.height - letterBoxes[0].height - 9.5,
  )).toBeLessThan(0.25);
  expectUniformLetterRhythm(letterBoxes);
  sessionGate.resolve();
});
