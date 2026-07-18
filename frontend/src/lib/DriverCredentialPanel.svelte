<script>
  import {
    CredentialFormError,
    buildCreatePayload,
    buildRemovePayload,
    buildRotatePayload,
    clearSecretValues,
    emptyProfileValues,
    newIdempotencyKey,
    normalizeDriverCredentialDocument,
    sendCredentialMutation,
  } from "$lib/driverCredentials.js";

  let { teamId, driverId } = $props();

  let credentialData = $state(null);
  let loaded = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let panelError = $state("");
  let notice = $state("");
  let mode = $state(""); // "" | create | rotate
  let selectedProfileId = $state("");
  let editingCredential = $state(null);
  let credentialLabel = $state("");
  let values = $state({});
  let idempotencyKey = $state("");

  let keyProfiles = $derived(
    credentialData?.credential_form.profiles.filter((profile) => profile.kind === "secret-fields") ?? [],
  );
  let activeProfile = $derived(
    keyProfiles.find((profile) => profile.id === selectedProfileId) ?? keyProfiles[0] ?? null,
  );
  let title = $derived(credentialData?.driver.title ?? driverId.toUpperCase());
  let canCreate = $derived(
    !!credentialData &&
      keyProfiles.length > 0 &&
      (credentialData.credential_form.cardinality === "many" || credentialData.credentials.length === 0),
  );
  let baseUrl = $derived(
    `/api/teams/${encodeURIComponent(teamId)}/drivers/${encodeURIComponent(driverId)}`,
  );

  function safeFailure(action, status = 0) {
    if (status === 409) return "The credential changed. Close this form, reopen it, and try again.";
    if (status === 401) return "Your Admin session expired. Sign in again before retrying.";
    return `Could not ${action}. Try again.`;
  }

  async function loadCredentials() {
    if (loading) return;
    loading = true;
    panelError = "";
    try {
      const response = await fetch(baseUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        panelError = safeFailure("load Driver credentials", response.status);
        return;
      }
      const raw = await response.json();
      credentialData = normalizeDriverCredentialDocument(raw, driverId);
      loaded = true;
    } catch {
      panelError = safeFailure("load Driver credentials");
    } finally {
      loading = false;
    }
  }

  function closeEditor() {
    if (activeProfile) values = clearSecretValues(activeProfile, values);
    mode = "";
    selectedProfileId = "";
    editingCredential = null;
    credentialLabel = "";
    values = {};
    idempotencyKey = "";
  }

  function panelToggle(event) {
    if (event.currentTarget.open) loadCredentials();
    else closeEditor();
  }

  function openCreate() {
    notice = "";
    panelError = "";
    try {
      const profile = keyProfiles[0];
      selectedProfileId = profile.id;
      values = emptyProfileValues(profile);
      idempotencyKey = newIdempotencyKey();
      credentialLabel = "";
      editingCredential = null;
      mode = "create";
    } catch {
      panelError = "A secure create request could not be prepared.";
      closeEditor();
    }
  }

  function selectProfile(event) {
    const profile = keyProfiles.find((candidate) => candidate.id === event.currentTarget.value);
    if (!profile) return;
    if (activeProfile) values = clearSecretValues(activeProfile, values);
    selectedProfileId = profile.id;
    values = emptyProfileValues(profile);
  }

  function openRotate(credential) {
    const profile = keyProfiles.find((candidate) => candidate.id === credential.profile_id);
    if (!profile) return;
    if (activeProfile) values = clearSecretValues(activeProfile, values);
    notice = "";
    panelError = "";
    selectedProfileId = profile.id;
    values = emptyProfileValues(profile);
    credentialLabel = credential.label;
    editingCredential = credential;
    idempotencyKey = "";
    mode = "rotate";
  }

  async function submitCredential() {
    if (busy || !activeProfile || !["create", "rotate"].includes(mode)) return;
    const profile = activeProfile;
    busy = true;
    panelError = "";
    notice = "";
    let succeeded = false;
    try {
      const creating = mode === "create";
      const payload = creating
        ? buildCreatePayload(profile, credentialLabel, values, idempotencyKey)
        : buildRotatePayload(
            profile,
            credentialLabel,
            values,
            editingCredential?.generation,
          );
      const response = await sendCredentialMutation(fetch, baseUrl, creating ? "create" : "rotate", {
        credentialId: editingCredential?.id,
        payload,
      });
      if (!response.ok) {
        panelError = safeFailure(creating ? "create credential" : "rotate credential", response.status);
        return;
      }
      succeeded = true;
    } catch (error) {
      panelError =
        error instanceof CredentialFormError
          ? "Check the label and every required field, then try again."
          : safeFailure(mode === "create" ? "create credential" : "rotate credential");
    } finally {
      // Secret inputs are write-only and leave component state after every submit outcome.
      values = clearSecretValues(profile, values);
      busy = false;
    }
    if (succeeded) {
      const completedAction = mode === "create" ? "created" : "rotated";
      closeEditor();
      await loadCredentials();
      notice = `Credential ${completedAction}.`;
    }
  }

  async function verifyCredential(credential) {
    if (busy) return;
    busy = true;
    panelError = "";
    notice = "";
    try {
      const response = await sendCredentialMutation(fetch, baseUrl, "verify", {
        credentialId: credential.id,
      });
      if (!response.ok) {
        panelError = safeFailure("verify credential", response.status);
        return;
      }
      await loadCredentials();
      notice = "Credential verified.";
    } catch {
      panelError = safeFailure("verify credential");
    } finally {
      busy = false;
    }
  }

  async function removeCredential(credential) {
    if (busy || !confirm(`Remove credential "${credential.label}" from this Team?`)) return;
    busy = true;
    panelError = "";
    notice = "";
    try {
      const payload = buildRemovePayload(credential.generation);
      const response = await sendCredentialMutation(fetch, baseUrl, "remove", {
        credentialId: credential.id,
        payload,
      });
      if (!response.ok) {
        panelError = safeFailure("remove credential", response.status);
        return;
      }
      if (editingCredential?.id === credential.id) closeEditor();
      await loadCredentials();
      notice = "Credential removed.";
    } catch {
      panelError = safeFailure("remove credential");
    } finally {
      busy = false;
    }
  }
</script>

<details class="driver-panel" ontoggle={panelToggle}>
  <summary>
    <span class="driver-name">{title}</span>
    <span class="driver-purpose">Team credentials</span>
  </summary>

  <div class="panel-body" aria-busy={loading || busy}>
    {#if loading && !loaded}
      <p class="muted">Loading credentials…</p>
    {:else if !loaded}
      <p class="error" role="alert">{panelError || "Driver credentials are unavailable."}</p>
      <button class="secondary" type="button" onclick={loadCredentials}>Retry</button>
    {:else}
      {#if credentialData.driver.summary}<p class="summary">{credentialData.driver.summary}</p>{/if}

      <div class="credential-heading">
        <span>
          {credentialData.credentials.length} credential{credentialData.credentials.length === 1 ? "" : "s"}
        </span>
        {#if canCreate && !mode}
          <button type="button" onclick={openCreate} disabled={busy}>Add credential</button>
        {/if}
      </div>

      {#if credentialData.credentials.length === 0}
        <p class="muted">No Team override is configured.</p>
      {:else}
        <ul class="credentials">
          {#each credentialData.credentials as credential (credential.id)}
            <li>
              <div class="credential-meta">
                <strong>{credential.label}</strong>
                <span>{credential.status} · generation {credential.generation}</span>
              </div>
              <div class="credential-actions">
                <button
                  class="secondary"
                  type="button"
                  onclick={() => verifyCredential(credential)}
                  disabled={busy}
                >
                  Verify
                </button>
                <button
                  class="secondary"
                  type="button"
                  onclick={() => openRotate(credential)}
                  disabled={busy || !keyProfiles.some((profile) => profile.id === credential.profile_id)}
                >
                  Rotate
                </button>
                <button
                  class="danger"
                  type="button"
                  onclick={() => removeCredential(credential)}
                  disabled={busy}
                >
                  Remove
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if mode && activeProfile}
        <form onsubmit={(event) => (event.preventDefault(), submitCredential())} autocomplete="off">
          <div class="form-heading">
            <div>
              <strong>{mode === "create" ? "Add credential" : `Rotate ${editingCredential.label}`}</strong>
              <span>{activeProfile.title}</span>
            </div>
            <button class="quiet" type="button" onclick={closeEditor} disabled={busy}>Cancel</button>
          </div>

          {#if mode === "create" && keyProfiles.length > 1}
            <label class="field">
              <span>Authentication profile</span>
              <select value={selectedProfileId} onchange={selectProfile} disabled={busy}>
                {#each keyProfiles as profile (profile.id)}
                  <option value={profile.id}>{profile.title}</option>
                {/each}
              </select>
            </label>
          {/if}

          {#if activeProfile.summary}<p class="profile-summary">{activeProfile.summary}</p>{/if}

          <!-- Credential labels belong to the platform engine, never to Driver-supplied executable UI. -->
          <label class="field">
            <span>Credential label</span>
            <input
              type="text"
              value={credentialLabel}
              oninput={(event) => (credentialLabel = event.currentTarget.value)}
              maxlength="80"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              required
              disabled={busy}
            />
          </label>

          {#each activeProfile.fields as field (field.id)}
            <label class="field">
              <span>{field.label}{field.required ? " *" : ""}</span>
              {#if field.type === "select"}
                <select
                  value={values[field.id] ?? ""}
                  onchange={(event) => (values[field.id] = event.currentTarget.value)}
                  required={field.required}
                  disabled={busy}
                >
                  <option value="" disabled>Select an option</option>
                  {#each field.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else}
                <input
                  type={field.type === "secret" ? "password" : "text"}
                  value={values[field.id] ?? ""}
                  oninput={(event) => (values[field.id] = event.currentTarget.value)}
                  minlength={field.min_length}
                  maxlength={field.max_length}
                  required={field.required}
                  autocomplete={field.type === "secret" ? "new-password" : "off"}
                  autocapitalize="none"
                  spellcheck={false}
                  disabled={busy}
                />
              {/if}
              {#if field.help}<small>{field.help}</small>{/if}
            </label>
          {/each}

          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : mode === "create" ? "Create credential" : "Rotate credential"}
          </button>
        </form>
      {/if}

      {#if panelError}<p class="error" role="alert">{panelError}</p>{/if}
      {#if notice}<p class="notice" role="status">{notice}</p>{/if}
    {/if}
  </div>
</details>

<style>
  .driver-panel {
    border-top: 1px solid var(--border);
    margin-top: 0.85rem;
    padding-top: 0.75rem;
  }

  summary {
    display: flex;
    min-height: 2.55rem;
    align-items: center;
    gap: 0.55rem;
    color: var(--text-dim);
    cursor: pointer;
    font-family: var(--font-mono);
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    display: grid;
    width: 1.55rem;
    height: 1.55rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    color: var(--accent);
    content: '+';
    font-family: var(--font-mono);
    font-size: 0.85rem;
  }

  details[open] summary::before {
    border-color: rgba(0, 240, 255, 0.5);
    content: '−';
  }

  .driver-name {
    color: var(--text);
    font-size: 0.73rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .driver-purpose,
  .muted,
  .summary,
  .profile-summary,
  .credential-meta span,
  small {
    color: var(--text-dim);
  }

  .driver-purpose,
  .credential-meta span,
  small {
    font-size: 0.7rem;
  }

  .driver-purpose {
    margin-inline-start: auto;
    color: var(--text-faint);
  }

  .panel-body {
    padding: 0.85rem 0 0.1rem;
  }

  .summary,
  .profile-summary {
    margin: 0 0 0.75rem;
    font-size: 0.75rem;
    line-height: 1.55;
  }

  .credential-heading,
  .form-heading,
  .credentials li,
  .credential-actions {
    align-items: center;
    display: flex;
  }

  .credential-heading,
  .form-heading {
    justify-content: space-between;
  }

  .credential-heading {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    margin-bottom: 0.6rem;
    text-transform: uppercase;
  }

  .credentials {
    display: grid;
    gap: 0.55rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .credentials li {
    gap: 0.8rem;
    justify-content: space-between;
    padding: 0.7rem;
    background: var(--bg);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .credential-meta {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }

  .credential-meta strong {
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: 0.72rem;
  }

  .credential-actions {
    gap: 0.35rem;
  }

  form {
    display: grid;
    gap: 0.85rem;
    margin-top: 0.9rem;
    padding: 0.9rem;
    background: var(--bg);
    clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }

  .form-heading div {
    display: grid;
    gap: 0.1rem;
  }

  .form-heading strong {
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .form-heading span {
    color: var(--text-dim);
    font-size: 0.7rem;
  }

  .field {
    display: grid;
    gap: 0.35rem;
  }

  .field > span {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  input,
  select {
    width: 100%;
    min-width: 0;
    min-height: 2.7rem;
    border: 0;
    padding: 0.62rem 0.72rem;
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    outline: none;
  }

  input:focus,
  select:focus {
    box-shadow: inset 0 0 0 1px var(--accent);
    filter: drop-shadow(0 0 6px rgba(0, 240, 255, 0.18));
  }

  button {
    min-height: 2.35rem;
    border: 0;
    padding: 0.4rem 0.65rem;
    background: linear-gradient(100deg, var(--accent), var(--accent-alt));
    clip-path: polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px);
    color: var(--accent-ink);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  button.secondary,
  button.quiet,
  button.danger {
    background: transparent;
  }

  button.secondary,
  button.quiet {
    border: 1px solid var(--border-strong);
    color: var(--text-dim);
  }

  button.secondary:hover:not(:disabled),
  button.quiet:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  button.danger {
    border: 1px solid color-mix(in srgb, var(--danger), transparent 60%);
    color: var(--danger);
  }

  button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .error,
  .notice {
    padding-inline-start: 0.6rem;
    border-inline-start: 2px solid currentColor;
    font-size: 0.72rem;
    margin: 0.75rem 0 0;
  }

  .error {
    color: var(--danger);
  }

  .notice {
    color: var(--success);
  }

  @media (max-width: 640px) {
    .credentials li {
      align-items: stretch;
      flex-direction: column;
    }
    .credential-actions {
      flex-wrap: wrap;
    }
  }
</style>
