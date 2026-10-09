// Assistant page fixtures shared by the browser tests: a public catalog entry and a Team details answer, each with the
// page copy and declarations Assistant Spec v1 displays (description, Creator links, Actions, credentials).

export const PAGE_COPY = Object.freeze({
  description: 'Reads your zones and records, shows exactly what will change, and applies a change only after your approval.',
  links: { site: 'https://shimpz.com/', github: 'https://github.com/TheShimpz' },
  actions: [
    { id: 'ensure-dns-record', effect: 'mutating', description: 'Create or correct one DNS record.' },
    { id: 'list-zones', effect: 'read_only', description: 'List your domains.' },
  ],
  integrations: [{ id: 'cloudflare', provider: 'cloudflare' }],
  stored_inputs: [],
});

/** One public catalog entry as `/api/assistant-catalog` lists it. */
export function publicAssistant(overrides = {}) {
  return {
    assistant_id: 'shimpz-cloudflare',
    assistant_version: '0.4.5',
    creators: ['@shimpz'],
    icon_digest: `sha256:${'e'.repeat(64)}`,
    name: 'Shimpz Cloudflare',
    source_digest: `sha256:${'f'.repeat(64)}`,
    summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
    ...structuredClone(PAGE_COPY),
    ...overrides,
  };
}

/** One Assistant page as Team answers it for a staged snapshot or an installed binding. */
export function assistantDetails(overrides = {}) {
  return {
    locale: 'en',
    assistant_id: 'shimpz-cloudflare',
    assistant_version: '0.4.5',
    name: 'Shimpz Cloudflare',
    creators: ['@shimpz'],
    summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
    ...structuredClone(PAGE_COPY),
    ...overrides,
  };
}

/** One staged snapshot as `/api/local-assistants` lists it. */
export function stagedSnapshot(overrides = {}) {
  return {
    assistant_id: 'shimpz-cloudflare',
    assistant_version: '0.4.5',
    name: 'Shimpz Cloudflare',
    summary: 'Inspect Cloudflare zones and safely manage common DNS records through OAuth.',
    actions: ['ensure-dns-record', 'list-zones'],
    integrations: ['cloudflare'],
    declared_creators: ['@shimpz'],
    created_at: '2026-09-17T07:00:00Z',
    image_id: `sha256:${'b'.repeat(64)}`,
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
    ...overrides,
  };
}
