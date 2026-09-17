import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupLocalAssistantSnapshots,
  projectPublishedAssistants,
  withoutLocallyStagedAssistants,
} from '../src/lib/localSnapshots.js';

function snapshot(assistantId, createdAt, imageCharacter) {
  return {
    assistant_id: assistantId,
    assistant_version: '0.2.1',
    name: assistantId === 'whatsapp' ? 'WhatsApp Automation' : 'Shimpz Cloudflare',
    summary: 'Automate trusted work from this machine.',
    actions: ['run-task'],
    integrations: [],
    declared_creators: ['@shimpz'],
    created_at: createdAt,
    image_id: `sha256:${imageCharacter.repeat(64)}`,
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
  };
}

test('groups Local snapshots by Assistant and keeps every exact build selectable', () => {
  const newest = snapshot('whatsapp', '2026-09-15T01:00:00-07:00', 'b');
  const older = snapshot('whatsapp', '2026-09-15T07:30:00Z', 'a');
  const cloudflare = snapshot('shimpz-cloudflare', '2026-09-15T08:00:00Z', 'c');
  const input = [older, newest, cloudflare];

  assert.deepEqual(groupLocalAssistantSnapshots(input), [
    {
      assistant_id: 'shimpz-cloudflare',
      primary: cloudflare,
      alternatives: [],
    },
    {
      assistant_id: 'whatsapp',
      primary: newest,
      alternatives: [older],
    },
  ]);
  assert.deepEqual(input, [older, newest, cloudflare]);
});

test('uses the image ID as a deterministic equal-time tie-breaker', () => {
  const first = snapshot('whatsapp', '2026-09-15T08:00:00Z', 'a');
  const second = snapshot('whatsapp', '2026-09-15T08:00:00Z', 'b');

  const [group] = groupLocalAssistantSnapshots([first, second]);

  assert.equal(group.primary.image_id, second.image_id);
  assert.deepEqual(group.alternatives, [first]);
});

test('fails closed on a timestamp outside the validated Local API contract', () => {
  assert.throws(
    () => groupLocalAssistantSnapshots([snapshot('whatsapp', 'not-a-time', 'a')]),
    /Invalid Local Assistant snapshot timestamp/,
  );
});

test('a staged Local identity shadows the matching Store publication', () => {
  const localGroups = groupLocalAssistantSnapshots([
    snapshot('shimpz-cloudflare', '2026-09-15T08:00:00Z', 'c'),
  ]);
  const published = [
    { assistant_id: 'shimpz-cloudflare' },
    { assistant_id: 'another-assistant' },
  ];

  assert.deepEqual(withoutLocallyStagedAssistants(published, localGroups), [
    { assistant_id: 'another-assistant' },
  ]);
});

test('withholds publications until the first Local snapshot inventory settles', () => {
  const published = [
    { assistant_id: 'shimpz-cloudflare' },
    { assistant_id: 'another-assistant' },
  ];
  const localGroups = groupLocalAssistantSnapshots([
    snapshot('shimpz-cloudflare', '2026-09-15T08:00:00Z', 'c'),
  ]);

  assert.deepEqual(projectPublishedAssistants(published, [], false), []);
  assert.deepEqual(projectPublishedAssistants(published, [], true), published);
  assert.deepEqual(projectPublishedAssistants(published, localGroups, true), [
    { assistant_id: 'another-assistant' },
  ]);
});
