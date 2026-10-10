// Trusted Types in the built Admin under the policy backend/browser.py sends (e2e/serveBuild.mjs serves it): every main
// screen renders through Svelte's own template policy, and a string reaching an HTML or script sink fails closed.
import { expect, test } from '@playwright/test';

import { routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/messages.js';

async function recordViolations(page) {
  await page.addInitScript(() => {
    window.policyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.policyViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => window.policyViolations);
}

test('every main screen renders under the enforced Trusted Types policy @browser-sensitive', async ({ page }) => {
  const violations = await recordViolations(page);
  await routeScenario(page, 'catalog');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ }).first()).toBeVisible();
  await page.goto('/chat/?team=marketing');
  await expect(page.getByRole('textbox', { name: messages.en.chatPage.send, exact: true })).toBeVisible();
  await page.goto('/assistants/?team=marketing');
  await page.getByRole('link', { name: /Cloudflare/ }).first().click();
  await expect(page).toHaveURL(/\/assistants\/[^/?]+\?team=marketing$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('a string reaching an HTML or script sink is refused at runtime @browser-sensitive', async ({ page }) => {
  const violations = await recordViolations(page);
  await routeScenario(page, 'ready');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^(New Team|Open the Team list)$/ }).first()).toBeVisible();

  const outcome = await page.evaluate(() => {
    const attempt = (run) => {
      try {
        run();
        return 'accepted';
      } catch (error) {
        return error.name;
      }
    };
    const target = document.createElement('div');
    const script = document.createElement('script');
    return {
      html: attempt(() => { target.innerHTML = '<img src="/x" onerror="alert(1)">'; }),
      adjacent: attempt(() => target.insertAdjacentHTML('beforeend', '<b>injected</b>')),
      scriptSource: attempt(() => { script.src = '/injected.js'; }),
      // No other policy may be created, and Svelte's own name is already taken.
      policy: attempt(() => window.trustedTypes.createPolicy('injected', { createHTML: (value) => value })),
      duplicate: attempt(() => window.trustedTypes.createPolicy('svelte-trusted-html', { createHTML: (value) => value })),
      parsed: target.childNodes.length,
      loaded: script.src,
    };
  });

  expect(outcome).toEqual({
    html: 'TypeError',
    adjacent: 'TypeError',
    scriptSource: 'TypeError',
    policy: 'TypeError',
    duplicate: 'TypeError',
    parsed: 0,
    loaded: '',
  });
  await expect.poll(violations).toEqual(expect.arrayContaining([expect.stringMatching(/^require-trusted-types-for /)]));
});
