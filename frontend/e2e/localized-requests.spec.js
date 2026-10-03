// ADR-0091 in the built Admin: an Action's human request reads in the interface language from Team's rendered block,
// while the answer stays the canonical value Team fingerprinted. A request rendered in another language than the one
// selected is never answered: Admin obtains a fresh challenge in the selected language first.
import { expect, test } from '@playwright/test';

import { humanRequestMessages } from '../src/lib/humanRequestMessages.js';
import { LOCALES } from '../src/lib/locales.js';
import { messages } from '../src/lib/messages.js';
import { localizedChallenge } from './localizedRequest.js';
import { routeScenario } from './scenarioRoutes.js';

const PASSWORD = 'violet otter lantern quartz 92';
const KINDS = ['approval', 'auth:password', 'input:choice'];

// The Assistant's English catalog copy; Team renders it, and every other language is a distinct rendered block.
const ENGLISH = {
  approval: {
    title: 'Publish the reviewed DNS changes?',
    description: 'Shimpz Cloudflare publishes 3 reviewed records to example.com.',
  },
  'auth:password': {
    title: 'Confirm the DNS publication',
    description: 'Your Supervisor password authorizes this exact Action.',
  },
  'input:choice': {
    title: 'Publishing mode for example.com',
    description: 'Choose how the reviewed records are published.',
    label: 'Publishing mode',
    options: [
      { label: 'Proxied', description: 'Route traffic through Cloudflare.' },
      { label: 'DNS only', description: null },
    ],
  },
};
const OPTION_VALUES = ['proxied', 'dns-only'];

function plainRequest(kind) {
  const copy = ENGLISH[kind];
  const request = { kind, ordinal: 0, title: copy.title, description: copy.description, fingerprint: 'c'.repeat(64) };
  if (kind !== 'input:choice') return request;
  return {
    ...request,
    label: copy.label,
    required: true,
    options: copy.options.map((option, index) => ({ value: OPTION_VALUES[index], ...option })),
  };
}

// The copy Team renders for one language: the English catalog itself, or text in that language for every field.
function renderedCopy(kind, locale) {
  if (locale === 'en') return ENGLISH[kind];
  const name = LOCALES.find((entry) => entry.code === locale).name;
  const mark = `${name} ${KINDS.indexOf(kind) + 1}`;
  const copy = { title: `${mark} · 1`, description: `${mark} · 2` };
  if (kind !== 'input:choice') return copy;
  return {
    ...copy,
    label: `${mark} · 3`,
    options: [{ label: `${mark} · 4`, description: `${mark} · 5` }, { label: `${mark} · 6`, description: null }],
  };
}

function englishCopy(kind) {
  const copy = ENGLISH[kind];
  return [copy.title, copy.description, copy.label, ...(copy.options ?? []).flatMap((option) => [option.label, option.description])]
    .filter(Boolean);
}

/**
 * Answer the chat socket like Team: one pending request per Team, rendered in the language a chat or sync frame names.
 * A frame naming another language than the pending request's reissues it as a fresh challenge whose earlier id stops
 * answering. `hold` defers the reply to the named frame types until the test releases it; `defer` lets Team act on
 * them at once and holds only the delivery of what it answered.
 */
async function routeLocalizedTeam(page, { purpose = false } = {}) {
  await routeScenario(page, 'ready');
  const frames = [];
  const held = [];
  const team = { pending: null, issued: 0, turns: 0, hold: new Set(), defer: new Set(), socket: null };
  const challenge = () => ({
    type: 'human-required',
    challenge_id: team.pending.id,
    expires_in: 300,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'publish-dns', summary: 'Publish reviewed DNS changes.' },
    ...localizedChallenge(plainRequest(team.pending.kind), {
      locale: team.pending.locale,
      shown: renderedCopy(team.pending.kind, team.pending.locale),
    }),
    // A purpose is written in its turn's language and projected only in a challenge of that language.
    ...(purpose && team.pending.locale === team.pending.turnLocale
      ? { purpose: `${LOCALES.find((entry) => entry.code === team.pending.turnLocale).name} 0` }
      : {}),
  });
  const issue = (locale) => {
    team.issued += 1;
    team.pending.id = team.issued.toString(16).padStart(32, '0');
    team.pending.locale = locale;
  };
  const reply = (frame) => {
    if (frame.type === 'human-response') {
      if (frame.challenge_id !== team.pending?.id) return [{ type: 'error', status: 409, detail: 'human-request-expired' }];
      team.pending = null;
      return [{
        type: 'done', team_id: 'marketing', team_name: 'Marketing', reply: `Done ${team.turns}.`,
        clarification: null,
      }];
    }
    if (frame.type === 'chat' && !team.pending) {
      team.pending = { kind: KINDS[team.turns % KINDS.length], turnLocale: frame.locale };
      team.turns += 1;
      issue(frame.locale);
      return [challenge()];
    }
    if (!team.pending) return [{ type: 'sync-empty' }];
    if (team.pending.locale !== frame.locale) issue(frame.locale);
    return [challenge()];
  };
  await page.routeWebSocket('**/api/teams/marketing/chat/ws', (socket) => {
    team.socket = socket;
    socket.onMessage((message) => {
      const frame = JSON.parse(message);
      frames.push(frame);
      const deliver = () => {
        for (const event of reply(frame)) socket.send(JSON.stringify(event));
      };
      if (team.hold.has(frame.type)) held.push(deliver);
      else if (team.defer.has(frame.type)) {
        const events = reply(frame);
        held.push(() => events.forEach((event) => socket.send(JSON.stringify(event))));
      } else deliver();
    });
  });
  return {
    frames,
    team,
    of: (type) => frames.filter((frame) => frame.type === type),
    release: () => held.splice(0).forEach((deliver) => deliver()),
    heldCount: () => held.length,
  };
}

async function sendMessage(page, locale, message) {
  const label = messages[locale].chatPage.send;
  const composer = page.getByRole('textbox', { name: label, exact: true });
  const send = page.getByRole('button', { name: label, exact: true });
  await expect(async () => {
    await composer.fill(message);
    await expect(send).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await send.click();
}

async function switchLanguage(page, from, to) {
  const name = (code) => LOCALES.find((entry) => entry.code === code).name;
  await page.getByRole('button', { name: messages[from].shell.languageCurrent.replace('{name}', name(from)) }).click();
  await page.getByRole('menuitemradio', { name: name(to) }).click();
}

// The open request makes the page behind it inert, so a language change while it is shown is driven through the
// menu's own handlers, as any change of the interface language that does not pass through the person's pointer.
async function switchLanguageBehindRequest(page, from, to) {
  const name = (code) => LOCALES.find((entry) => entry.code === code).name;
  await page.getByRole('button', { name: messages[from].shell.languageCurrent.replace('{name}', name(from)) })
    .dispatchEvent('click');
  await page.getByRole('menuitemradio', { name: name(to) }).dispatchEvent('click');
}

// Answer one open request with the person's choice; `value` is what the browser frame must carry.
async function answer(dialog, kind, locale) {
  const labels = humanRequestMessages[locale];
  if (kind === 'approval') {
    await dialog.getByRole('button', { name: labels.approve, exact: true }).click();
    return true;
  }
  if (kind === 'auth:password') {
    await dialog.getByLabel(labels.passwordLabel, { exact: true }).fill(PASSWORD);
    await dialog.getByRole('button', { name: labels.authorize, exact: true }).click();
    return PASSWORD;
  }
  await dialog.getByRole('radio', { name: renderedCopy(kind, locale).options[1].label }).check();
  await dialog.getByRole('button', { name: labels.submit, exact: true }).click();
  return OPTION_VALUES[1];
}

for (const { code } of LOCALES) {
  test(`approval, authentication, and input requests in ${code} show their rendered copy and answer canonically`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('shimpz_lang', lang), code);
    const chat = await routeLocalizedTeam(page, { purpose: true });
    await page.goto('/chat/?team=marketing');

    const answers = [];
    for (const [index, kind] of KINDS.entries()) {
      await sendMessage(page, code, `Publish my DNS changes ${index + 1}`);
      const shown = renderedCopy(kind, code);
      const dialog = page.getByRole('dialog', { name: shown.title });
      // The localized scope stays visible beside the purpose written in the same language.
      await expect(dialog).toContainText(shown.description);
      await expect(dialog).toContainText(`${LOCALES.find((entry) => entry.code === code).name} 0`);
      if (kind === 'input:choice') {
        await expect(dialog).toContainText(shown.label);
        await expect(dialog.getByRole('radio', { name: shown.options[0].label })).toBeVisible();
        await expect(dialog).toContainText(shown.options[0].description);
      }
      if (code !== 'en') {
        // No Assistant-authored English reaches a dialog whose rendered copy is in another language.
        for (const english of englishCopy(kind)) await expect(dialog).not.toContainText(english);
      }
      answers.push(await answer(dialog, kind, code));
      await expect(dialog).toBeHidden();
      await expect(page.getByText(`Done ${index + 1}.`)).toBeVisible();
    }

    expect(chat.of('chat').map((frame) => frame.locale)).toEqual([code, code, code]);
    expect(chat.of('human-response')).toEqual(answers.map((value, index) => ({
      type: 'human-response',
      challenge_id: (index + 1).toString(16).padStart(32, '0'),
      decision: 'submit',
      value,
    })));
  });
}

test('a request that arrives after the language changed is answered only through a fresh challenge in it', async ({ page }) => {
  const chat = await routeLocalizedTeam(page, { purpose: true });
  chat.team.hold = new Set(['chat']);
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'en', 'Publish my DNS changes');
  await expect.poll(() => chat.heldCount()).toBe(1);

  // The person switches the interface language while the turn that pauses for a request is still running.
  await switchLanguage(page, 'en', 'pt');
  chat.team.hold = new Set(['sync']);
  chat.release();
  const stale = page.getByRole('dialog', { name: ENGLISH.approval.title });
  await expect(stale.getByRole('button', { name: humanRequestMessages.pt.approve, exact: true })).toBeDisabled();
  await expect.poll(() => chat.of('sync').map((frame) => frame.locale)).toEqual(['en', 'pt']);

  chat.team.hold = new Set();
  chat.release();
  const dialog = page.getByRole('dialog', { name: renderedCopy('approval', 'pt').title });
  await expect(dialog).toContainText(renderedCopy('approval', 'pt').description);
  // The purpose was written in English, so the Portuguese challenge shows only its localized scope.
  await expect(dialog).not.toContainText('English 0');
  await dialog.getByRole('button', { name: humanRequestMessages.pt.approve, exact: true }).click();
  await expect(page.getByText('Done 1.')).toBeVisible();
  expect(chat.of('human-response')).toEqual([
    { type: 'human-response', challenge_id: '2'.padStart(32, '0'), decision: 'submit', value: true },
  ]);
});

test('switching back while a reissue is undelivered never answers the request Team replaced', async ({ page }) => {
  const chat = await routeLocalizedTeam(page);
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'en', 'Publish my DNS changes');
  const english = page.getByRole('dialog', { name: ENGLISH.approval.title });
  const approve = english.getByRole('button', { name: humanRequestMessages.en.approve, exact: true });
  await expect(approve).toBeEnabled();

  // Team reissues the request in Portuguese at once, but its fresh challenge has not reached Admin yet.
  chat.team.defer = new Set(['sync']);
  await switchLanguageBehindRequest(page, 'en', 'pt');
  await expect.poll(() => chat.heldCount()).toBe(1);
  expect(chat.team.pending).toMatchObject({ locale: 'pt', id: '2'.padStart(32, '0') });

  // Back in English, the shown request reads in the selected language again, yet Team no longer answers its id.
  await switchLanguageBehindRequest(page, 'pt', 'en');
  await expect(english).toBeVisible();
  await expect(approve).toBeDisabled();
  await approve.click({ force: true });
  expect(chat.of('human-response')).toEqual([]);

  // The Portuguese challenge arrives and is reconciled to English; until that reissue lands nothing is answerable.
  chat.release();
  await expect.poll(() => chat.of('sync').map((frame) => frame.locale)).toEqual(['en', 'pt', 'en']);
  await expect.poll(() => chat.heldCount()).toBe(1);
  const portuguese = page.getByRole('dialog', { name: renderedCopy('approval', 'pt').title });
  await expect(portuguese.getByRole('button', { name: humanRequestMessages.en.approve, exact: true })).toBeDisabled();
  expect(chat.of('human-response')).toEqual([]);

  chat.team.defer = new Set();
  chat.release();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText('Done 1.')).toBeVisible();
  expect(chat.of('human-response')).toEqual([
    { type: 'human-response', challenge_id: '3'.padStart(32, '0'), decision: 'submit', value: true },
  ]);
});

test('a reconnect restores the pending request in the language selected while the socket was down', async ({ page }) => {
  const chat = await routeLocalizedTeam(page);
  await page.goto('/chat/?team=marketing');
  await sendMessage(page, 'en', 'Publish my DNS changes');
  await expect(page.getByRole('dialog', { name: ENGLISH.approval.title })).toBeVisible();

  chat.team.hold = new Set(['sync']);
  chat.team.socket.close();
  await expect(page.getByRole('dialog')).toBeHidden();
  await switchLanguage(page, 'en', 'de');
  await expect.poll(() => chat.heldCount()).toBeGreaterThan(0);
  chat.team.hold = new Set();
  chat.release();

  const dialog = page.getByRole('dialog', { name: renderedCopy('approval', 'de').title });
  await expect(dialog).toContainText(renderedCopy('approval', 'de').description);
  await dialog.getByRole('button', { name: humanRequestMessages.de.approve, exact: true }).click();
  await expect(page.getByText('Done 1.')).toBeVisible();
  const syncs = chat.of('sync').map((frame) => frame.locale);
  expect(syncs.at(-1)).toBe('de');
  expect(chat.of('human-response')).toEqual([
    { type: 'human-response', challenge_id: chat.team.issued.toString(16).padStart(32, '0'), decision: 'submit', value: true },
  ]);
  expect(chat.team.issued).toBe(2);
});

test('a restored continuation opens in the selected language and answers its canonical value', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shimpz_lang', 'ja'));
  const chat = await routeLocalizedTeam(page);
  // Team already holds a request a French turn paused for, as after a restart.
  chat.team.pending = { kind: 'input:choice', turnLocale: 'fr', locale: 'fr', id: '1'.padStart(32, '0') };
  chat.team.issued = 1;
  chat.team.turns = 3;
  await page.goto('/chat/?team=marketing');

  const shown = renderedCopy('input:choice', 'ja');
  const dialog = page.getByRole('dialog', { name: shown.title });
  await expect(dialog).toContainText(shown.description);
  for (const french of Object.values(renderedCopy('input:choice', 'fr')).filter((value) => typeof value === 'string')) {
    await expect(dialog).not.toContainText(french);
  }
  expect(chat.of('sync').map((frame) => frame.locale)).toEqual(['ja']);
  const value = await answer(dialog, 'input:choice', 'ja');
  await expect(page.getByText('Done 3.')).toBeVisible();
  expect(chat.of('human-response')).toEqual([
    { type: 'human-response', challenge_id: '2'.padStart(32, '0'), decision: 'submit', value },
  ]);
});
