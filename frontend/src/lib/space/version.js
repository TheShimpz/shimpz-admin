const EPOCH = /^[1-9][0-9]{0,11}$/;
const REVISION = /^[0-9a-f]{40}$/;

/**
 * The Admin version a build shows: its commit's UTC date and short revision, which the image build supplies as
 * SOURCE_DATE_EPOCH and SOURCE_REVISION, or `dev` for a build of a working tree that names no revision.
 */
export function buildVersion(epoch, revision) {
  if (!revision) return 'dev';
  if (!EPOCH.test(epoch ?? '') || !REVISION.test(revision)) throw new Error('the Admin build revision is invalid');
  const date = new Date(Number(epoch) * 1000).toISOString().slice(0, 10).replaceAll('-', '.');
  return `v${date}-${revision.slice(0, 7)}`;
}

/** The full commit a build names, or null for a build that names none; a malformed one fails as `buildVersion` does. */
export function buildRevision(epoch, revision) {
  buildVersion(epoch, revision);
  return revision || null;
}

/**
 * Whether the Admin serving this tab runs the build the tab was loaded from: `current` when both name the same commit,
 * `stale` when they differ (the tab outlived an update or a rollback), and `unknown` while either names none.
 */
export function versionState(own, served) {
  if (!own || !served) return 'unknown';
  return own === served ? 'current' : 'stale';
}
