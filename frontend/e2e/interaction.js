// What a person does in the built Admin, as more than one browser test does it.
import { expect } from '@playwright/test';

import { messages } from '../src/lib/i18n/catalogs.js';
import { LOCALES } from '../src/lib/i18n/locales.js';

const languageName = (code) => LOCALES.find((entry) => entry.code === code).name;

/** Writes `message` in the chat composer of the `locale` interface once Send accepts it, then sends it. */
export async function sendMessage(page, message, locale = 'en') {
  const label = messages[locale].chatPage.send;
  const composer = page.getByRole('textbox', { name: label, exact: true });
  const send = page.getByRole('button', { name: label, exact: true });
  await expect(async () => {
    await composer.fill(message);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await send.click();
}

/** The language menu's button while `from` is the interface language, and the menu item that selects `to`. */
export function languageMenu(page, from, to) {
  const current = messages[from].shell.languageCurrent.replace('{name}', languageName(from));
  return {
    button: page.getByRole('button', { name: current }),
    item: page.getByRole('menuitemradio', { name: languageName(to) }),
  };
}

/** Changes the interface language from `from` to `to` through the language menu. */
export async function switchLanguage(page, from, to) {
  const { button, item } = languageMenu(page, from, to);
  await button.click();
  await item.click();
}
