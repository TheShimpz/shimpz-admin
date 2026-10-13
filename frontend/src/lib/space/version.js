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
