const PROFILE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIELD_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DRIVER_ID = PROFILE_ID;
const TEAM_ID = /^[a-z0-9_]{1,40}$/;
const CREDENTIAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const OAUTH_SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TEXT_FORMAT_MAX = Object.freeze({
  "plain-text": 256,
  "account-id": 128,
  "bucket-name": 63,
  hostname: 253,
  region: 64,
  "tenant-id": 128,
  username: 128,
});

const SECRET_FORMAT_MAX = Object.freeze({
  "access-key-id": 256,
  "api-key": 4096,
  password: 1024,
  "private-key": 16384,
  "secret-access-key": 4096,
  "secret-token": 4096,
});

export class CredentialFormError extends Error {
  constructor(code = "invalid-form") {
    super("Driver credential form rejected");
    this.name = "CredentialFormError";
    this.code = code;
  }
}

function reject(code) {
  throw new CredentialFormError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closedRecord(value, required, optional = []) {
  if (!isRecord(value)) reject();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) reject();
  if (Object.keys(value).some((key) => !allowed.has(key))) reject();
  return value;
}

function boundedText(value, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    reject();
  }
  return value;
}

function identifier(value, pattern, maximum) {
  const text = boundedText(value, maximum);
  if (!pattern.test(text)) reject();
  return text;
}

function exactBoolean(value) {
  if (typeof value !== "boolean") reject();
  return value;
}

function declaredLengths(field, formatMaximum, { secret = false } = {}) {
  const minimum = field.min_length;
  const maximum = field.max_length;
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < (secret ? 1 : 0) ||
    maximum < 1 ||
    minimum > maximum ||
    maximum > formatMaximum
  ) {
    reject();
  }
  return { min_length: minimum, max_length: maximum };
}

function commonField(field) {
  return {
    id: identifier(field.id, FIELD_ID, 80),
    type: field.type,
    label: boundedText(field.label, 80),
    ...(field.help === undefined ? {} : { help: boundedText(field.help, 240, { optional: true }) }),
    required: exactBoolean(field.required),
    format: field.format,
  };
}

function normalizeTextField(raw) {
  const field = closedRecord(
    raw,
    ["id", "type", "label", "required", "format", "min_length", "max_length"],
    ["help"],
  );
  if (field.type !== "text" || !Object.hasOwn(TEXT_FORMAT_MAX, field.format)) reject();
  return {
    ...commonField(field),
    ...declaredLengths(field, TEXT_FORMAT_MAX[field.format]),
  };
}

function normalizeSecretField(raw) {
  const field = closedRecord(
    raw,
    ["id", "type", "label", "required", "format", "min_length", "max_length", "write_only"],
    ["help"],
  );
  if (field.type !== "secret" || field.write_only !== true || !Object.hasOwn(SECRET_FORMAT_MAX, field.format)) {
    reject();
  }
  return {
    ...commonField(field),
    ...declaredLengths(field, SECRET_FORMAT_MAX[field.format], { secret: true }),
    write_only: true,
  };
}

function normalizeSelectField(raw) {
  const field = closedRecord(raw, ["id", "type", "label", "required", "format", "options"], ["help"]);
  if (field.type !== "select" || field.format !== "option" || !Array.isArray(field.options)) reject();
  if (field.options.length < 1 || field.options.length > 64) reject();
  const values = new Set();
  const options = field.options.map((rawOption) => {
    const option = closedRecord(rawOption, ["value", "label"]);
    const value = identifier(option.value, OPTION_VALUE, 80);
    if (values.has(value)) reject();
    values.add(value);
    return { value, label: boundedText(option.label, 80) };
  });
  return { ...commonField(field), options };
}

function normalizeSecretFieldsProfile(raw) {
  const profile = closedRecord(raw, ["id", "kind", "title", "fields"], ["summary"]);
  if (profile.kind !== "secret-fields" || !Array.isArray(profile.fields)) reject();
  if (profile.fields.length < 1 || profile.fields.length > 32) reject();
  const ids = new Set();
  const fields = profile.fields.map((rawField) => {
    if (!isRecord(rawField)) reject();
    let field;
    if (rawField.type === "text") field = normalizeTextField(rawField);
    else if (rawField.type === "secret") field = normalizeSecretField(rawField);
    else if (rawField.type === "select") field = normalizeSelectField(rawField);
    else reject();
    if (ids.has(field.id)) reject();
    ids.add(field.id);
    return field;
  });
  return {
    id: identifier(profile.id, PROFILE_ID, 80),
    kind: profile.kind,
    title: boundedText(profile.title, 80),
    ...(profile.summary === undefined
      ? {}
      : { summary: boundedText(profile.summary, 240, { optional: true }) }),
    fields,
  };
}

function normalizeOAuthProfile(raw) {
  const profile = closedRecord(
    raw,
    ["id", "kind", "title", "adapter_id", "scopes", "pkce"],
    ["summary"],
  );
  if (
    profile.kind !== "oauth2-authorization-code" ||
    profile.pkce !== "S256" ||
    !Array.isArray(profile.scopes) ||
    profile.scopes.length < 1 ||
    profile.scopes.length > 32
  ) {
    reject();
  }
  const scopes = profile.scopes.map((scope) => identifier(scope, OAUTH_SCOPE, 256));
  if (new Set(scopes).size !== scopes.length) reject();
  return {
    id: identifier(profile.id, PROFILE_ID, 80),
    kind: profile.kind,
    title: boundedText(profile.title, 80),
    ...(profile.summary === undefined
      ? {}
      : { summary: boundedText(profile.summary, 240, { optional: true }) }),
    adapter_id: identifier(profile.adapter_id, PROFILE_ID, 80),
    scopes,
    pkce: "S256",
  };
}

export function normalizeCredentialForm(raw) {
  const form = closedRecord(raw, ["schema_version", "owner_scope", "cardinality", "profiles"]);
  if (
    form.schema_version !== 1 ||
    form.owner_scope !== "team" ||
    !["one", "many"].includes(form.cardinality) ||
    !Array.isArray(form.profiles) ||
    form.profiles.length < 1 ||
    form.profiles.length > 16
  ) {
    reject();
  }
  const ids = new Set();
  const profiles = form.profiles.map((rawProfile) => {
    if (!isRecord(rawProfile)) reject();
    let profile;
    if (rawProfile.kind === "secret-fields") profile = normalizeSecretFieldsProfile(rawProfile);
    else if (rawProfile.kind === "oauth2-authorization-code") profile = normalizeOAuthProfile(rawProfile);
    else reject();
    if (ids.has(profile.id)) reject();
    ids.add(profile.id);
    return profile;
  });
  return {
    schema_version: 1,
    owner_scope: "team",
    cardinality: form.cardinality,
    profiles,
  };
}

function normalizeDriver(raw, expectedDriverId) {
  if (!isRecord(raw)) reject();
  const id = identifier(raw.id, DRIVER_ID, 80);
  if (id !== expectedDriverId) reject();
  return {
    id,
    title: boundedText(raw.title, 80),
    ...(raw.summary === undefined ? {} : { summary: boundedText(raw.summary, 240, { optional: true }) }),
  };
}

function normalizeCredentials(raw, form) {
  if (!Array.isArray(raw) || raw.length > 256) reject();
  if (form.cardinality === "one" && raw.length > 1) reject();
  const profileIds = new Set(form.profiles.map((profile) => profile.id));
  const credentialIds = new Set();
  return raw.map((item) => {
    if (!isRecord(item)) reject();
    const id = identifier(item.id, CREDENTIAL_ID, 64);
    const profileId = identifier(item.profile_id, PROFILE_ID, 80);
    if (credentialIds.has(id) || !profileIds.has(profileId)) reject();
    if (!Number.isSafeInteger(item.generation) || item.generation < 1) reject();
    credentialIds.add(id);

    // Projection is intentional: even a broken Driver response cannot place values, ciphertext,
    // tokens, or other undeclared material into long-lived component state.
    return {
      id,
      profile_id: profileId,
      label: boundedText(item.label, 80),
      status: boundedText(item.status, 40),
      generation: item.generation,
      ...(typeof item.created_at === "string" ? { created_at: boundedText(item.created_at, 64) } : {}),
      ...(typeof item.updated_at === "string" ? { updated_at: boundedText(item.updated_at, 64) } : {}),
      ...(typeof item.last_verified_at === "string"
        ? { last_verified_at: boundedText(item.last_verified_at, 64) }
        : {}),
    };
  });
}

export function normalizeDriverCredentialDocument(raw, expectedDriverId) {
  if (!isRecord(raw)) reject();
  const canonicalDriverId = identifier(expectedDriverId, DRIVER_ID, 80);
  const credentialForm = normalizeCredentialForm(raw.credential_form);
  return {
    driver: normalizeDriver(raw.driver, canonicalDriverId),
    credential_form: credentialForm,
    credentials: normalizeCredentials(raw.credentials, credentialForm),
  };
}

export function emptyProfileValues(profile) {
  if (!isRecord(profile) || profile.kind !== "secret-fields" || !Array.isArray(profile.fields)) reject();
  return Object.fromEntries(profile.fields.map((field) => [field.id, ""]));
}

export function clearSecretValues(profile, currentValues) {
  const cleared = isRecord(currentValues) ? { ...currentValues } : {};
  if (!isRecord(profile) || profile.kind !== "secret-fields" || !Array.isArray(profile.fields)) return cleared;
  for (const field of profile.fields) {
    if (field.type === "secret") cleared[field.id] = "";
  }
  return cleared;
}

function normalizedLabel(label) {
  if (typeof label !== "string") reject("invalid-input");
  const value = label.trim();
  if (!value || value.length > 80 || value.includes("\n") || value.includes("\r")) reject("invalid-input");
  return value;
}

function submittedValues(profile, currentValues) {
  if (!isRecord(profile) || profile.kind !== "secret-fields" || !isRecord(currentValues)) {
    reject("invalid-input");
  }
  const submitted = {};
  for (const field of profile.fields) {
    const value = currentValues[field.id];
    if (typeof value !== "string") reject("invalid-input");
    if (!value && !field.required) continue;
    if (field.type === "select") {
      if (!field.options.some((option) => option.value === value)) reject("invalid-input");
    } else if (value.length < field.min_length || value.length > field.max_length) reject("invalid-input");
    submitted[field.id] = value;
  }
  return submitted;
}

function expectedGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) reject("invalid-generation");
  return value;
}

export function newIdempotencyKey(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.randomUUID !== "function") reject("crypto-unavailable");
  const key = cryptoApi.randomUUID();
  if (typeof key !== "string" || !UUID_V4.test(key)) reject("crypto-unavailable");
  return key;
}

export function buildCreatePayload(profile, label, currentValues, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !UUID_V4.test(idempotencyKey)) reject("invalid-idempotency-key");
  const values = submittedValues(profile, currentValues);
  return {
    profile_id: profile.id,
    label: normalizedLabel(label),
    values,
    idempotency_key: idempotencyKey,
  };
}

export function buildRotatePayload(profile, label, currentValues, generation) {
  const values = submittedValues(profile, currentValues);
  return {
    profile_id: profile.id,
    label: normalizedLabel(label),
    values,
    expected_generation: expectedGeneration(generation),
  };
}

export function buildRemovePayload(generation) {
  return { expected_generation: expectedGeneration(generation) };
}

export function sendCredentialMutation(
  fetcher,
  baseUrl,
  operation,
  { credentialId = "", payload = {} } = {},
) {
  if (typeof fetcher !== "function" || typeof baseUrl !== "string" || !isRecord(payload)) {
    reject("invalid-request");
  }
  const baseParts = /^\/api\/teams\/([^/]+)\/drivers\/([^/]+)$/.exec(baseUrl);
  if (!baseParts) reject("invalid-request");
  identifier(baseParts[1], TEAM_ID, 40);
  identifier(baseParts[2], DRIVER_ID, 80);
  let method;
  let url;
  if (operation === "create") {
    method = "POST";
    url = `${baseUrl}/credentials`;
  } else {
    const canonicalCredentialId = identifier(credentialId, CREDENTIAL_ID, 64);
    if (operation === "rotate") {
      method = "PUT";
      url = `${baseUrl}/credentials/${canonicalCredentialId}`;
    } else if (operation === "verify") {
      method = "POST";
      url = `${baseUrl}/credentials/${canonicalCredentialId}/verify`;
    } else if (operation === "remove") {
      method = "DELETE";
      url = `${baseUrl}/credentials/${canonicalCredentialId}`;
    } else {
      reject("invalid-request");
    }
  }
  return fetcher(url, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
