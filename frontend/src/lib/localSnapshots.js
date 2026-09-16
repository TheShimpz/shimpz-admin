function snapshotTime(snapshot) {
  const value = Date.parse(snapshot.created_at);
  if (!Number.isFinite(value)) throw new TypeError('Invalid Local Assistant snapshot timestamp.');
  return value;
}

/** Group every exact staged image by Assistant while keeping older builds selectable. */
export function groupLocalAssistantSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) return [];

  const grouped = new Map();
  for (const snapshot of snapshots) {
    snapshotTime(snapshot);
    const entries = grouped.get(snapshot.assistant_id) ?? [];
    entries.push(snapshot);
    grouped.set(snapshot.assistant_id, entries);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assistantId, entries]) => {
      const builds = [...entries].sort((left, right) => (
        snapshotTime(right) - snapshotTime(left) || right.image_id.localeCompare(left.image_id)
      ));
      return {
        assistant_id: assistantId,
        primary: builds[0],
        alternatives: builds.slice(1),
      };
    });
}
