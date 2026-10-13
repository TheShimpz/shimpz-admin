// An uninstall card keeps showing the Assistant's icon after Team removed it: a snapshot of the installed icon, taken
// while the Assistant is still installed, kept in the card as a data: URL.
import { installedIconUrl } from '../../assistants/icons.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function imageDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Assistant icon snapshot failed'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

/**
 * The icon of the Assistant installed in a Team as a PNG data: URL, or undefined when Admin answers no PNG icon of at
 * most 1 MiB. Read past every cache; `signal` aborts it, and a failed or aborted read rejects.
 */
export async function snapshotIcon(teamId, assistantId, signal) {
  const response = await fetch(installedIconUrl(teamId, assistantId), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'image/png') return undefined;
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_SNAPSHOT_BYTES || blob.type !== 'image/png') return undefined;
  const snapshot = await imageDataUrl(blob);
  return typeof snapshot === 'string' && snapshot.startsWith('data:image/png;base64,') ? snapshot : undefined;
}
