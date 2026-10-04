// Chat attachments in the built Admin (ADR-0093): files join a message from the picker, the clipboard, or a drop; they
// upload one at a time to the selected Team and reach the Team only as the message's file ids. Refusals are explained,
// an approval that delivers a file names it, and a reply names the Actions the message's files withheld.
import { expect, test } from '@playwright/test';

import { accessibilityViolations } from './axe.js';
import { routeScenario } from './scenarioRoutes.js';
import { messages } from '../src/lib/messages.js';

const EN = messages.en.attachments;
const AR = messages.ar.attachments;
const MIB = 1024 * 1024;

function textFile(name, text = `# ${name}\nPreview notes.\n`) {
  return { name, mimeType: 'text/markdown', buffer: Buffer.from(text) };
}

function chatMessages(scenario) {
  return scenario.chatFrames().filter((frame) => frame.type === 'chat');
}

async function openChat(page, scenarioName, locale = null) {
  if (locale) await page.addInitScript((lang) => localStorage.setItem('shimpz_lang', lang), locale);
  const scenario = await routeScenario(page, scenarioName);
  await page.goto('/chat/?team=marketing');
  const copy = messages[locale ?? 'en'];
  const composer = page.getByRole('textbox', { name: copy.chatPage.send, exact: true });
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  const attach = page.getByRole('button', { name: copy.attachments.attach, exact: true });
  await expect(attach).toBeEnabled();
  return { scenario, composer, attach, send: page.getByRole('button', { name: copy.chatPage.send, exact: true }) };
}

async function choose(page, attach, files) {
  const chooser = page.waitForEvent('filechooser');
  await attach.click();
  await (await chooser).setFiles(files);
}

function attachmentList(page, copy = EN) {
  return page.getByRole('list', { name: copy.list, exact: true });
}

test('files chosen from the button upload to the Team and reach it only as the message file ids', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await choose(page, attach, [textFile('notes.md'), textFile('brief.md')]);
  const list = attachmentList(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').filter({ hasText: 'notes.md' })).not.toHaveAttribute('aria-busy');
  await expect(list.getByRole('listitem').filter({ hasText: 'brief.md' })).not.toHaveAttribute('aria-busy');

  await composer.fill('When does the contract renew?');
  await send.click();
  await expect(page.getByText('I read the 2 files you attached.', { exact: false })).toBeVisible();
  const [frame] = chatMessages(scenario);
  expect(frame.message).toBe('When does the contract renew?');
  expect(frame.files).toHaveLength(2);
  expect(frame.files.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
  expect(new Set(frame.files).size).toBe(2);
  // The composer starts empty again; the sent message keeps a record of its files.
  await expect(page.getByRole('article', { name: messages.en.chatPage.you })
    .getByRole('list', { name: EN.list }).getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('#chat-composer')).toHaveValue('');
  await expect(page.locator('form').getByRole('list', { name: EN.list })).toHaveCount(0);

  // The reply names, by Assistant and Action, what the files withheld and how to use it without them.
  const note = page.getByRole('note', { name: EN.restricted.title });
  await expect(note.getByRole('listitem')).toHaveText([
    'Shimpz Cloudflare · Create Dns Record',
    'Shimpz Cloudflare · Purge Cache',
    '+1 more',
  ]);
  await expect(note).toContainText(EN.restricted.next);
  expect(await accessibilityViolations(page)).toEqual([]);
});

test('a pasted file and a dropped file join the message, and pasted text still reaches the draft', async ({
  page,
  context,
  browserName,
}) => {
  const { scenario, composer, send } = await openChat(page, 'attachments');
  await composer.evaluate((field) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'clip.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const dropped = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['dropped notes'], 'dropped.txt', { type: 'text/plain' }));
    return data;
  });
  await composer.dispatchEvent('dragenter', { dataTransfer: dropped });
  await composer.dispatchEvent('dragover', { dataTransfer: dropped });
  await composer.dispatchEvent('drop', { dataTransfer: dropped });
  const list = attachmentList(page);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').filter({ hasText: 'clip.png' })).not.toHaveAttribute('aria-busy');
  await expect(list.getByRole('listitem').filter({ hasText: 'dropped.txt' })).not.toHaveAttribute('aria-busy');

  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('Summarize these'));
    await composer.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(composer).toHaveValue('Summarize these');
  } else {
    await composer.fill('Summarize these');
  }
  await send.click();
  await expect(page.getByText('I read the 2 files you attached.', { exact: false })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toHaveLength(2);
});

test('a file removed from the message is not sent with it', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await choose(page, attach, [textFile('keep.md'), textFile('drop.md')]);
  const list = attachmentList(page);
  await expect(list.locator('[aria-busy]')).toHaveCount(0);
  await list.getByRole('button', { name: 'Remove drop.md from message' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/keep\.md/]);
  await composer.fill('Read this one');
  await send.click();
  await expect(page.getByText('I read the file you attached.', { exact: false })).toBeVisible();
  const [frame] = chatMessages(scenario);
  expect(frame.files).toHaveLength(1);
});

test('a reloaded chat still shows which files each message carried', async ({ page }) => {
  const { composer, attach, send } = await openChat(page, 'attachments');
  await choose(page, attach, [textFile('notes.md'), textFile('brief.md')]);
  await expect(attachmentList(page).locator('[aria-busy]')).toHaveCount(0);
  await composer.fill('When does the contract renew?');
  await send.click();
  await expect(page.getByText('I read the 2 files you attached.', { exact: false })).toBeVisible();

  await page.reload();
  await expect(page.getByText('I read the 2 files you attached.', { exact: false })).toBeVisible({ timeout: 20_000 });
  const sent = page.getByRole('article', { name: messages.en.chatPage.you })
    .filter({ hasText: 'When does the contract renew?' });
  await expect(sent.getByRole('list', { name: EN.list }).getByRole('listitem')).toHaveText([/notes\.md/, /brief\.md/]);
  // A saved record offers nothing to do with its files.
  await expect(sent.getByRole('list', { name: EN.list }).getByRole('button')).toHaveCount(0);
});

test('removing a file never deletes it, and attaching the same file again reuses the stored copy', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  const deletions = [];
  const uploaded = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletions.push(request.url());
  });
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith('/api/teams/marketing/files')) {
      uploaded.push((await response.json()).file.id);
    }
  });
  const list = attachmentList(page);
  await choose(page, attach, [textFile('keep.md')]);
  await expect(list.locator('[aria-busy]')).toHaveCount(0);
  await list.getByRole('button', { name: 'Remove keep.md from message' }).click();
  await expect(list).toHaveCount(0);
  // Chosen again, and once more while it is already in the message: the Team answers the same stored file.
  await choose(page, attach, [textFile('keep.md')]);
  await expect(list.locator('[aria-busy]')).toHaveCount(0);
  await choose(page, attach, [textFile('keep.md')]);
  await expect.poll(() => uploaded.length).toBe(3);
  await expect(list.locator('[aria-busy]')).toHaveCount(0);
  await expect(list.getByRole('listitem')).toHaveText([/keep\.md/]);
  expect(new Set(uploaded).size).toBe(1);

  await composer.fill('Read it again');
  await send.click();
  await expect(page.getByText('I read the file you attached.', { exact: false })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toEqual([uploaded[0]]);
  expect(deletions).toEqual([]);
});

test('upload refusals are explained in plain words and leave nothing in the message', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  const alert = page.getByRole('alert');

  await choose(page, attach, [{ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25 * MIB + 1) }]);
  await expect(alert).toHaveText(EN.errors['too-large'].replace('{name}', 'huge.bin'));
  await choose(page, attach, [{ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
  await expect(alert).toHaveText(EN.errors.empty.replace('{name}', 'empty.txt'));
  await choose(page, attach, [textFile('bad.refused')]);
  await expect(alert).toHaveText(EN.errors.invalid.replace('{name}', 'bad.refused'));
  await expect(attachmentList(page)).toHaveCount(0);

  const nine = Array.from({ length: 9 }, (_, index) => textFile(`part-${index + 1}.md`));
  await choose(page, attach, nine);
  await expect(alert).toHaveText(EN.errors['too-many']);
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(8);
  await expect(attachmentList(page).locator('[aria-busy]')).toHaveCount(0);
  await expect(attach).toBeDisabled();

  await composer.fill('Read them');
  await send.click();
  await expect(page.getByText('I read the 8 files you attached.', { exact: false })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toHaveLength(8);
});

test('a full Team storage refuses the upload and the message is sent without files', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments-full');
  await choose(page, attach, [textFile('notes.md')]);
  await expect(page.getByRole('alert')).toHaveText(EN.errors.quota.replace('{name}', 'notes.md'));
  await expect(attachmentList(page)).toHaveCount(0);
  await composer.fill('Hello');
  await send.click();
  await expect(page.getByText('Preview reply to: Hello')).toBeVisible();
  expect(chatMessages(scenario)[0].files).toEqual([]);
});

test('cancelling stops the uploads in flight and sending waits for none of them', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  const held = [];
  await page.route('**/api/teams/marketing/files', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    held.push(route);
    return undefined;
  });
  await choose(page, attach, [textFile('first.md'), textFile('second.md')]);
  await expect(page.getByText(EN.uploading.replace('{current}', '1').replace('{total}', '2'))).toBeVisible();
  await composer.fill('Hello');
  await expect(send).toBeDisabled();
  await page.getByRole('button', { name: EN.cancelUpload }).click();
  await expect(attachmentList(page)).toHaveCount(0);
  await expect(send).toBeEnabled();
  // An answer that arrives after the cancel adds nothing to the message.
  await held[0].fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"late"}' }).catch(() => {});
  await send.click();
  await expect(page.getByText('Preview reply to: Hello')).toBeVisible();
  expect(chatMessages(scenario)[0].files).toEqual([]);
  expect(held).toHaveLength(1);
});

// Holds every file read the page starts once `holdAttachmentReads` is set, until `releaseAttachmentReads` runs; the
// release settles after the held reads and the work they resume have finished. `releaseAttachmentReads(true)` makes
// the held reads fail instead.
async function holdFileReads(page) {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    const held = [];
    window.heldAttachmentReads = () => held.length;
    window.releaseAttachmentReads = async (fail = false) => {
      await Promise.all(held.splice(0).map((release) => release(fail)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    Blob.prototype.arrayBuffer = function arrayBuffer() {
      if (!window.holdAttachmentReads) return read.call(this);
      return new Promise((resolve, reject) => held.push((fail) => {
        if (fail) return reject(new DOMException('held read failed', 'NotReadableError'));
        const bytes = read.call(this);
        resolve(bytes);
        return bytes;
      }));
    };
  });
}

test('a message waits for a file that is still being read and leaves with it', async ({ page }) => {
  await holdFileReads(page);
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await page.evaluate(() => { window.holdAttachmentReads = true; });
  await choose(page, attach, [textFile('late.md')]);
  await expect.poll(() => page.evaluate(() => window.heldAttachmentReads())).toBe(1);
  await composer.fill('Read this');
  await composer.press('Enter');
  await expect(send).toBeDisabled();
  await expect(composer).toHaveValue('Read this');

  await page.evaluate(() => window.releaseAttachmentReads());
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(1);
  await expect(attachmentList(page).locator('[aria-busy]')).toHaveCount(0);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect.poll(() => chatMessages(scenario).length).toBe(1);
  const [frame] = chatMessages(scenario);
  expect(frame.message).toBe('Read this');
  expect(frame.files).toHaveLength(1);
});

test('cancelling while a file is still being read leaves it out of the message', async ({ page }) => {
  await holdFileReads(page);
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await choose(page, attach, [textFile('first.md')]);
  await expect(attachmentList(page).locator('[aria-busy]')).toHaveCount(0);
  await page.evaluate(() => { window.holdAttachmentReads = true; });
  await choose(page, attach, [textFile('second.md'), textFile('third.md')]);
  await expect.poll(() => page.evaluate(() => window.heldAttachmentReads())).toBe(1);
  await page.evaluate(() => window.releaseAttachmentReads());
  // second.md waits for its upload while third.md is still being read.
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.heldAttachmentReads())).toBe(1);
  await page.getByRole('button', { name: EN.cancelUpload }).click();
  await page.evaluate(() => window.releaseAttachmentReads());
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(1);
  await composer.fill('Hello');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText('I read the file you attached.', { exact: false })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toHaveLength(1);
});

test('the first file of a message can be cancelled while its read stalls, and the message leaves without it', async ({ page }) => {
  await holdFileReads(page);
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await page.evaluate(() => { window.holdAttachmentReads = true; });
  await choose(page, attach, [textFile('stalled.md')]);
  await expect.poll(() => page.evaluate(() => window.heldAttachmentReads())).toBe(1);
  await composer.fill('Hello');
  await expect(send).toBeDisabled();

  await page.getByRole('button', { name: EN.cancelUpload }).click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => chatMessages(scenario).length).toBe(1);
  expect(chatMessages(scenario)[0].files ?? []).toHaveLength(0);
  // The read that finishes after the cancel belongs to no message.
  await page.evaluate(() => window.releaseAttachmentReads());
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(0);
});

test('a selection cancelled while its read fails reads none of its later files', async ({ page }) => {
  await holdFileReads(page);
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await page.evaluate(() => { window.holdAttachmentReads = true; });
  await choose(page, attach, [textFile('first.md'), textFile('second.md'), textFile('third.md')]);
  await expect.poll(() => page.evaluate(() => window.heldAttachmentReads())).toBe(1);

  await page.getByRole('button', { name: EN.cancelUpload }).click();
  await page.evaluate(() => window.releaseAttachmentReads(true));
  // The failed read ends the cancelled selection: second.md and third.md are never read.
  expect(await page.evaluate(() => window.heldAttachmentReads())).toBe(0);
  await expect(attachmentList(page).getByRole('listitem')).toHaveCount(0);
  await composer.fill('Hello');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => chatMessages(scenario).length).toBe(1);
  expect(chatMessages(scenario)[0].files ?? []).toHaveLength(0);
});

async function selectTeam(page, name) {
  if (page.viewportSize().width <= 820) {
    await page.getByRole('button', { name: 'Open the Team list' }).click();
    await page.getByRole('dialog', { name: 'Teams' }).getByRole('link', { name, exact: true }).click();
  } else {
    await page.locator('.shell-sidebar').getByRole('link', { name, exact: true }).click();
  }
}

test('an upload that answers after a Team change never joins a later message', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'ready');
  const held = [];
  await page.route('**/api/teams/marketing/files', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    held.push(route);
    return undefined;
  });
  await choose(page, attach, [textFile('marketing.md')]);
  await expect.poll(() => held.length).toBe(1);
  await selectTeam(page, 'Trinity');
  await expect(page).toHaveURL(/team=trinity/);
  // The upload started for Marketing is answered only after the Team changed; the change already let it go.
  await held[0].fallback().catch(() => {});
  await selectTeam(page, 'Marketing');
  await expect(composer).toBeEnabled({ timeout: 20_000 });
  await expect(attachmentList(page)).toHaveCount(0);
  await composer.fill('Hello');
  await send.click();
  await expect(page.getByText('Preview reply to: Hello')).toBeVisible();
  expect(chatMessages(scenario).at(-1).files).toEqual([]);
});

test('an install request with files is answered with the attachment-free next step', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments');
  await choose(page, attach, [textFile('setup.md')]);
  await expect(attachmentList(page).locator('[aria-busy]')).toHaveCount(0);
  await composer.fill('Install the WhatsApp Assistant');
  await send.click();
  await expect(page.getByText('Send that request again without attachments.', { exact: false })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toHaveLength(1);
});

test('an approval that delivers a file names it and what it carries before anything runs', async ({ page }) => {
  const { scenario, composer, send } = await openChat(page, 'attachment-approval');
  await composer.fill('Upload the contract to R2');
  await send.click();
  const dialog = page.getByRole('dialog', { name: 'Upload Contract.pdf to the R2 bucket “contracts”?' });
  const file = dialog.getByRole('list', { name: EN.consent.file });
  await expect(file.getByRole('listitem')).toContainText('Contract.pdf');
  await expect(dialog).toContainText(
    EN.consent.disclosure.replace('{action}', 'Upload Object').replace('{assistant}', 'Shimpz Cloudflare'),
  );
  expect(await accessibilityViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: messages.en.humanRequest.approve }).click();
  await expect(page.getByText('Done — Contract.pdf is in the R2 bucket “contracts”.')).toBeVisible();
  const response = scenario.chatFrames().find((frame) => frame.type === 'human-response');
  expect(response.decision).toBe('submit');
});

test('attachments work in a right-to-left interface', async ({ page }) => {
  const { scenario, composer, attach, send } = await openChat(page, 'attachments', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await choose(page, attach, [textFile('ملاحظات.md'), textFile('extra.md')]);
  const list = attachmentList(page, AR);
  await expect(list.locator('[aria-busy]')).toHaveCount(0);
  await list.getByRole('button', { name: AR.removeNamed.replace('{name}', 'extra.md') }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await composer.fill('لخّص الملف');
  await send.click();
  await expect(page.getByRole('note', { name: AR.restricted.title })).toBeVisible();
  expect(chatMessages(scenario)[0].files).toHaveLength(1);
});
