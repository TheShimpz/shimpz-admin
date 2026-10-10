// Team's confirmation of a mutating Action (ADR-0112) in the built Admin with scenario fixtures (ADR-0087): Admin words
// the card, shows the Action's validated input exactly as Team rendered it, and answers with `true` or a denial.
import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { routeScenario } from './scenarioRoutes.js';
import { humanRequestMessages } from '../src/lib/humanRequestMessages.js';
import { messages } from '../src/lib/messages.js';

const copy = humanRequestMessages.en;

async function sendMessage(page, message) {
  const label = messages.en.chatPage.send;
  const composer = page.getByRole('textbox', { name: label, exact: true });
  const send = page.getByRole('button', { name: label, exact: true });
  await expect(async () => {
    await composer.fill(message);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await send.click();
}

async function openConfirmation(page) {
  const scenario = await routeScenario(page, 'action-confirmation');
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'Add the SPF record for example.com');
  const dialog = page.getByRole('dialog', { name: copy.confirmationTitle });
  await expect(dialog).toBeVisible();
  return { scenario, dialog };
}

test('Team confirmation lists every input row as literal text, marks a shortened row, and counts the rest', async ({ page }) => {
  const { scenario, dialog } = await openConfirmation(page);
  const input = dialog.getByRole('region', { name: copy.inputLabel });
  // Sixteen rows in Team's order; markup in a value is text, never an element.
  await expect(input.getByRole('term')).toHaveCount(16);
  await expect(input.getByRole('term').first()).toHaveText('comment');
  await expect(input.getByRole('definition').first()).toContainText('"<b>Set by Shimpz</b>"');
  await expect(input.locator('b')).toHaveCount(0);
  // The escaped bidirectional control stays visible, and the row Team cut says so.
  const content = input.getByRole('definition').nth(1);
  await expect(content).toContainText('\\u202e');
  await expect(content).toContainText(copy.inputTruncated);
  await expect(input.getByRole('definition').first()).not.toContainText(copy.inputTruncated);
  // The arguments past the sixteenth row are counted, never dropped silently.
  await expect(input).toContainText(copy.inputOmitted.replace('{count}', '3'));
  // The confirmation card's one accessibility scan.
  expect(await accessibilityViolations(page)).toEqual([]);

  await dialog.getByRole('button', { name: copy.confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Done — the DNS record was created.')).toBeVisible();
  const responses = scenario.chatFrames().filter((frame) => frame.type === 'human-response');
  expect(responses).toEqual([
    { type: 'human-response', challenge_id: 'f'.repeat(32), decision: 'submit', value: true },
  ]);
});

test('Cancel answers Team confirmation with a denial', async ({ page }) => {
  const { scenario, dialog } = await openConfirmation(page);
  await dialog.getByRole('button', { name: copy.cancel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Ok — I stopped that Action.')).toBeVisible();
  const responses = scenario.chatFrames().filter((frame) => frame.type === 'human-response');
  expect(responses).toEqual([{ type: 'human-response', challenge_id: 'f'.repeat(32), decision: 'deny' }]);
});
