const TOKEN_PATTERN = /(\{actions\}|\{assistants\}|\{provider\}|\{providers\})/u;

export function assistantIntegrationMessageParts(template, values) {
  const replacements = {
    '{actions}': values.actions,
    '{assistants}': values.assistants,
    '{provider}': values.provider,
    '{providers}': values.providers,
  };
  return template
    .split(TOKEN_PATTERN)
    .filter(Boolean)
    .map((token) => ({
      text: replacements[token] ?? token,
      emphasized: Object.hasOwn(replacements, token),
    }));
}

export function localizedIntegrationList(values, locale) {
  const unique = [...new Set(values)];
  if (unique.length < 2) return unique[0] ?? '';
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(unique);
}

export function assistantIntegrationLabels(requirements, installedAssistants) {
  const versions = new Map(installedAssistants.map((entry) => [
    entry.assistant,
    entry.assistant_version,
  ]));
  const seen = new Set();
  const identities = requirements.flatMap((requirement) => {
    if (seen.has(requirement.assistant_id)) return [];
    seen.add(requirement.assistant_id);
    const version = versions.get(requirement.assistant_id);
    return [{
      id: requirement.assistant_id,
      label: `${requirement.assistant_name}${version ? ` v${version}` : ''}`,
    }];
  });
  const labelCounts = new Map();
  for (const { label } of identities) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  return identities.map(({ id, label }) => (
    labelCounts.get(label) > 1 ? `${label} (${id})` : label
  ));
}
