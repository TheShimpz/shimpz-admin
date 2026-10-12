// Where Admin serves an Assistant's icon: an installed Assistant's from its Team, a publication's from the catalog.

/** The icon of the Assistant installed in a Team, as that Team runs it. */
export function installedIconUrl(teamId, assistantId) {
  return `/api/teams/${encodeURIComponent(teamId)}/assistants/${encodeURIComponent(assistantId)}/icon`;
}

/** The icon of a public catalog entry. */
export function catalogIconUrl(assistantId) {
  return `/api/assistants/${encodeURIComponent(assistantId)}/catalog-icon`;
}
