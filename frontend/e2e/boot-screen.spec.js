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

function expectCompactHorizontalRhythm(boxes) {
  const pitches = boxes.slice(1).map((box, index) => box.x - boxes[index].x);
  expect(pitches).toHaveLength(5);
  expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThan(0.5);
  for (const pitch of pitches) {
    expect(pitch).toBeGreaterThan(9.5);
    expect(pitch).toBeLessThan(10.25);
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
    body: {
      profile: 'local',
      authenticated: true,
      origin_admitted: true,
      oauth_completion_mode: 'automatic',
    },
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

test('shows only the centered Shimpz binary boot screen while the session is unresolved', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: { profile: 'local', authenticated: false, initialized: false },
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;

  const boot = page.locator('[data-slot="boot-screen"]');
  const composition = page.locator('[data-slot="boot-composition"]');
  const mark = page.locator('[data-slot="boot-mark"]');
  const wordmark = page.locator('[data-slot="boot-wordmark"]');
  const loader = page.locator('[data-slot="binary-loader"]');
  const markImage = mark.locator('img');
  const glyphs = page.locator('[data-slot="binary-glyph"]');
  await expect(boot).toBeVisible();
  await expect(page.locator('.initial-content')).toHaveAttribute('inert', '');
  await expect(page.locator('.auth-stage')).toBeHidden();
  await expect(boot).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(glyphs).toHaveText(['0', '1', '0', '1', '0', '1']);
  await expect(glyphs.first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect.poll(() => markImage.evaluate(
    (image) => image.complete && image.naturalWidth > 0,
  )).toBe(true);
  expect(await glyphs.first().evaluate(
    (element) => getComputedStyle(element).fontFamily.includes('IBM Plex Mono'),
  )).toBe(true);
  expect(await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('600 14px "IBM Plex Mono"', '01'),
      document.fonts.load('700 24px "IBM Plex Mono"', 'SHIMPZ'),
    ]);
    return document.fonts.check('600 14px "IBM Plex Mono"', '01')
      && document.fonts.check('700 24px "IBM Plex Mono"', 'SHIMPZ');
  })).toBe(true);
  await expect(wordmark).toHaveText('SHIMPZ');
  const [bootBox, compositionBox, markBox, wordmarkBox, loaderBox, glyphBoxes] = await Promise.all([
    boot.boundingBox(),
    composition.boundingBox(),
    mark.boundingBox(),
    wordmark.boundingBox(),
    loader.boundingBox(),
    glyphs.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })),
  ]);
  expect(bootBox).not.toBeNull();
  expect(compositionBox).not.toBeNull();
  expect(markBox).not.toBeNull();
  expect(wordmarkBox).not.toBeNull();
  expect(loaderBox).not.toBeNull();
  expect(Math.abs(
    compositionBox.x + (compositionBox.width / 2) - bootBox.x - (bootBox.width / 2),
  )).toBeLessThan(1);
  expect(Math.abs(
    compositionBox.y + (compositionBox.height / 2) - bootBox.y - (bootBox.height / 2),
  )).toBeLessThan(1);
  expect(Math.abs(
    markBox.x + (markBox.width / 2) - loaderBox.x - (loaderBox.width / 2),
  )).toBeLessThan(1);
  expect(Math.abs(
    wordmarkBox.x + (wordmarkBox.width / 2) - loaderBox.x - (loaderBox.width / 2),
  )).toBeLessThan(1);
  const animatedGlyphCenter = glyphBoxes.reduce(
    (total, box) => total + box.y + (box.height / 2),
    0,
  ) / glyphBoxes.length;
  expect(Math.abs(
    animatedGlyphCenter - loaderBox.y - (loaderBox.height / 2),
  )).toBeLessThan(1);
  expectCompactHorizontalRhythm(glyphBoxes);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const rtlGlyphBoxes = await glyphs.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  expectCompactHorizontalRhythm(rtlGlyphBoxes);
  const rtlWordmarkBox = await wordmark.boundingBox();
  expect(rtlWordmarkBox).not.toBeNull();
  expect(Math.abs(
    rtlWordmarkBox.x + (rtlWordmarkBox.width / 2) - loaderBox.x - (loaderBox.width / 2),
  )).toBeLessThan(1);
  await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page).toHaveScreenshot('boot-screen.png', visualContract);
  sessionGate.resolve();
  await expect(boot).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create password' })).toBeVisible();
});

test('moves all six binary glyphs vertically in exact counterphase', async ({ page }) => {
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: { profile: 'local', authenticated: false, initialized: false },
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const glyphs = page.locator('[data-slot="binary-glyph"]');
  await expect(glyphs).toHaveCount(6);
  expect(await glyphs.evaluateAll((elements) => elements.every(
    (element) => getComputedStyle(element).animationName.endsWith('binary-swing'),
  ))).toBe(true);
  const motion = await glyphs.evaluateAll((elements) => {
    const loader = document.querySelector('[data-slot="binary-loader"]');
    const animations = elements.map((element) => element.getAnimations()[0]);
    animations.forEach((animation) => animation.pause());
    const sample = (time) => {
      animations.forEach((animation) => { animation.currentTime = time; });
      const loaderBox = loader.getBoundingClientRect();
      const centers = elements.map((element) => {
        const box = element.getBoundingClientRect();
        return box.y + (box.height / 2);
      });
      return {
        centers,
        centroid: centers.reduce((total, center) => total + center, 0) / centers.length,
        axis: loaderBox.y + (loaderBox.height / 2),
        glyphHeight: elements[0].getBoundingClientRect().height,
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
    for (const center of sample.centers) {
      expect(Math.abs(center - sample.axis)).toBeLessThan(sample.glyphHeight / 2);
    }
  }
  for (let index = 0; index < motion.start.centers.length; index += 1) {
    expect(Math.abs(
      motion.start.centers[index] - motion.opposite.centers[index],
    )).toBeGreaterThan(1);
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
    body: {
      profile: 'local',
      authenticated: true,
      origin_admitted: true,
      oauth_completion_mode: 'automatic',
    },
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
    body: {
      profile: 'local',
      authenticated: true,
      origin_admitted: true,
      oauth_completion_mode: 'automatic',
    },
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
    body: {
      profile: 'local',
      authenticated: true,
      origin_admitted: true,
      oauth_completion_mode: 'automatic',
    },
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
    body: {
      profile: 'local',
      authenticated: true,
      origin_admitted: true,
      oauth_completion_mode: 'automatic',
    },
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

test('keeps a stable binary composition when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const sessionGate = deferred();
  const sessionRequested = await routeSession(page, {
    body: { profile: 'local', authenticated: false, initialized: false },
  }, sessionGate);

  await page.goto('/');
  await sessionRequested.promise;
  const loader = page.locator('[data-slot="binary-loader"]');
  const glyphs = page.locator('[data-slot="binary-glyph"]');
  await expect(glyphs).toHaveCount(6);
  expect(await glyphs.evaluateAll((elements) => elements.every(
    (element) => getComputedStyle(element).animationName === 'none',
  ))).toBe(true);
  const [loaderBox, glyphBoxes] = await Promise.all([
    loader.boundingBox(),
    glyphs.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })),
  ]);
  expect(loaderBox).not.toBeNull();
  for (const box of glyphBoxes) {
    expect(Math.abs(box.y + (box.height / 2) - (loaderBox.y + (loaderBox.height / 2)))).toBeLessThan(1);
  }
  for (let index = 1; index < glyphBoxes.length; index += 1) {
    expect(glyphBoxes[index - 1].x + glyphBoxes[index - 1].width).toBeLessThanOrEqual(
      glyphBoxes[index].x,
    );
  }
  expectCompactHorizontalRhythm(glyphBoxes);
  sessionGate.resolve();
});
