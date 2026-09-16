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

/** Hide a publication whenever this Local machine stages the same Assistant identity. */
export function withoutLocallyStagedAssistants(published, localGroups) {
  if (!Array.isArray(published) || !Array.isArray(localGroups)) return [];
  const localIds = new Set(localGroups.map((group) => group.assistant_id));
  return published.filter((assistant) => !localIds.has(assistant.assistant_id));
}
