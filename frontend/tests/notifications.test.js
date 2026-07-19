import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ASSISTANT_RUNTIME_UPDATED_EVENT,
  clearNotifications,
  dispatchAssistantRuntimeUpdated,
  getNotifications,
  parseNotificationEnvelope,
  parseNotificationSyncEnvelope,
  readAllNotifications,
  readNotification,
  syncNotifications,
} from '../src/lib/notifications.js';

const notification = Object.freeze({
  id: '0123456789abcdef0123456789abcdef',
  assistant_id: 'shimpz-assistant',
  sequence: 3,
  headline: 'Shimpz Assistant 0.3 is ready',
  changelog: '# Faster forecasts\n\nThe weather Power now returns clearer results.',
  published_at: '2026-07-19T12:30:00Z',
  read_at: null,
});

const envelope = Object.freeze({ notifications: [notification], unread_count: 1 });

test('accepts only a bounded, internally consistent notification envelope', () => {
  const parsed = parseNotificationEnvelope(envelope);
  assert.deepEqual(parsed, envelope);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.notifications));
  assert.ok(Object.isFrozen(parsed.notifications[0]));

  assert.throws(() => parseNotificationEnvelope({ ...envelope, unexpected: true }), /invalid notifications response/);
  assert.throws(() => parseNotificationEnvelope({ ...envelope, unread_count: 0 }), /invalid unread notification count/);
  assert.throws(
    () => parseNotificationEnvelope({ notifications: [notification, notification], unread_count: 2 }),
    /duplicate notification id/,
  );
  assert.throws(
    () => parseNotificationEnvelope({ notifications: [{ ...notification, changelog: 'bad\u0000markdown' }], unread_count: 1 }),
    /invalid notification changelog/,
  );
  assert.doesNotThrow(() => parseNotificationEnvelope({
    notifications: [{ ...notification, changelog: 'x'.repeat(9 * 1024) }],
    unread_count: 1,
  }));
  assert.throws(
    () => parseNotificationEnvelope({
      notifications: [{ ...notification, changelog: 'x'.repeat((32 * 1024) + 1) }],
      unread_count: 1,
    }),
    /invalid notification changelog/,
  );
});

test('validates the exact non-executable sync summary contract', () => {
  const sync = {
    ...envelope,
    sync: { status: 'partial', updated_assistants: 1, notifications_added: 1, failed_updates: 1 },
  };
  assert.deepEqual(parseNotificationSyncEnvelope(sync), sync);
  assert.throws(
    () => parseNotificationSyncEnvelope({ ...sync, sync: { ...sync.sync, status: 'queued' } }),
    /invalid notification sync status/,
  );
  assert.throws(
    () => parseNotificationSyncEnvelope({ ...sync, sync: { ...sync.sync, failed_updates: [] } }),
    /invalid notification sync count/,
  );
});

test('uses the narrow same-origin notification API with the intended methods', async () => {
  const calls = [];
  const fetchEnvelope = async (path, init) => {
    calls.push({ path, init });
    return { ok: true, status: 200, json: async () => envelope };
  };

  await getNotifications(fetchEnvelope);
  await readNotification(fetchEnvelope, notification.id);
  await readAllNotifications(fetchEnvelope);
  await clearNotifications(fetchEnvelope);

  const fetchSync = async (path, init) => {
    calls.push({ path, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...envelope,
        sync: { status: 'ok', updated_assistants: 1, notifications_added: 1, failed_updates: 0 },
      }),
    };
  };
  await syncNotifications(fetchSync);

  assert.deepEqual(calls.map(({ path, init }) => [path, init.method]), [
    ['/api/notifications', 'GET'],
    [`/api/notifications/${notification.id}/read`, 'POST'],
    ['/api/notifications/read-all', 'POST'],
    ['/api/notifications', 'DELETE'],
    ['/api/notifications/sync', 'POST'],
  ]);
  for (const { init } of calls) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
  }
  assert.throws(() => readNotification(fetchEnvelope, '../session'), /invalid notification id/);
});

test('dispatches one metadata-free internal event after a runtime upgrade', () => {
  const target = new EventTarget();
  const received = [];
  target.addEventListener(ASSISTANT_RUNTIME_UPDATED_EVENT, (event) => received.push(event));

  assert.equal(dispatchAssistantRuntimeUpdated(target), true);
  assert.equal(dispatchAssistantRuntimeUpdated(undefined), false);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'shimpz:assistant-runtime-updated');
  assert.equal(received[0] instanceof CustomEvent, false);
});

test('mounts an accessible localized drawer beside the Admin brand and renders closed-AST Markdown', () => {
  const component = readFileSync(new URL('../src/lib/NotificationCenter.svelte', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../src/lib/AdminShell.svelte', import.meta.url), 'utf8');

  assert.match(shell, /import NotificationCenter from '\$lib\/NotificationCenter\.svelte';/);
  assert.match(shell, /<ShimpzBrand product="Admin"[^>]*\/>\s*<NotificationCenter \/>/);
  assert.match(component, /import HelpMarkdown from '\$lib\/HelpMarkdown\.svelte';/);
  assert.match(component, /<HelpMarkdown markdown=\{selected\.changelog\} \/>/);
  assert.doesNotMatch(component, /\{@html|innerHTML|outerHTML/);
  assert.match(component, /aria-haspopup="dialog"/);
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /<dialog[\s\S]*aria-labelledby="notification-center-title"/);
  assert.match(component, /height: 100dvh;/);
  assert.match(component, /onMount\(\(\) => \{\s*void initialize\(\);/);
  assert.match(component, /applySnapshot\(await getNotifications\(fetch\)\)/);
  assert.match(component, /const snapshot = await syncNotifications\(fetch\);/);
  assert.match(component, /if \(snapshot\.sync\.updated_assistants > 0\) dispatchAssistantRuntimeUpdated\(\);/);
  assert.match(component, /readNotification\(fetch, notification\.id\)/);
  assert.match(component, /readAllNotifications\(fetch\)/);
  assert.match(component, /clearNotifications\(fetch\)/);
  for (const code of ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar']) {
    assert.match(component, new RegExp(`\\n    ${code}: \\{`));
  }
});
