import assert from "node:assert/strict";
import test from "node:test";

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
} from "../src/lib/driverCredentials.js";

const UUID = "2e386e84-1f04-4c24-9f6d-e28f632a40de";

function documentFixture({ cardinality = "many" } = {}) {
  return {
    driver: {
      id: "r2",
      title: "Cloudflare R2",
      summary: "Team-scoped object storage.",
    },
    credential_form: {
      schema_version: 1,
      owner_scope: "team",
      cardinality,
      profiles: [
        {
          id: "access-key",
          kind: "secret-fields",
          title: "Access key",
          summary: "Use a scoped R2 access key.",
          fields: [
            {
              id: "account_id",
              type: "text",
              label: "Account ID",
              required: true,
              format: "account-id",
              min_length: 1,
              max_length: 128,
            },
            {
              id: "access_key_id",
              type: "secret",
              label: "Access key ID",
              required: true,
              format: "access-key-id",
              min_length: 8,
              max_length: 256,
              write_only: true,
            },
            {
              id: "secret_access_key",
              type: "secret",
              label: "Secret access key",
              required: true,
              format: "secret-access-key",
              min_length: 16,
              max_length: 4096,
              write_only: true,
            },
            {
              id: "region",
              type: "select",
              label: "Region",
              required: true,
              format: "option",
              options: [
                { value: "auto", label: "Automatic" },
                { value: "wnam", label: "Western North America" },
              ],
            },
          ],
        },
      ],
    },
    credentials: [
      {
        id: "9a-primary",
        profile_id: "access-key",
        label: "Production",
        status: "active",
        generation: 4,
        created_at: "2026-07-15T10:00:00Z",
        values: { secret_access_key: "must-never-enter-state" },
        access_token: "must-never-enter-state",
      },
      {
        id: "backup-2",
        profile_id: "access-key",
        label: "Backup",
        status: "unverified",
        generation: 1,
      },
    ],
  };
}

test("normalizes a many-cardinality form and projects credential metadata only", () => {
  const normalized = normalizeDriverCredentialDocument(documentFixture(), "r2");

  assert.equal(normalized.driver.title, "Cloudflare R2");
  assert.equal(normalized.credential_form.cardinality, "many");
  assert.equal(normalized.credential_form.profiles[0].fields[2].label, "Secret access key");
  assert.equal(normalized.credentials.length, 2);
  assert.deepEqual(normalized.credentials[0], {
    id: "9a-primary",
    profile_id: "access-key",
    label: "Production",
    status: "active",
    generation: 4,
    created_at: "2026-07-15T10:00:00Z",
  });
  assert.doesNotMatch(JSON.stringify(normalized.credentials), /must-never-enter-state/);
});

test("rejects unknown executable form fields and confused Driver identities", () => {
  const executable = documentFixture();
  executable.credential_form.profiles[0].fields[0].validator = "driverJavascript()";
  assert.throws(
    () => normalizeDriverCredentialDocument(executable, "r2"),
    CredentialFormError,
  );

  const wrongDriver = documentFixture();
  wrongDriver.driver.id = "postgresql";
  assert.throws(
    () => normalizeDriverCredentialDocument(wrongDriver, "r2"),
    CredentialFormError,
  );
});

test("builds create with one crypto.randomUUID idempotency key", () => {
  let calls = 0;
  const key = newIdempotencyKey({
    randomUUID() {
      calls += 1;
      return UUID;
    },
  });
  const profile = normalizeDriverCredentialDocument(documentFixture(), "r2").credential_form.profiles[0];
  const payload = buildCreatePayload(
    profile,
    " Production ",
    {
      account_id: "account-1",
      access_key_id: "12345678",
      secret_access_key: "1234567890abcdef",
      region: "auto",
    },
    key,
  );

  assert.equal(calls, 1);
  assert.deepEqual(payload, {
    profile_id: "access-key",
    label: "Production",
    values: {
      account_id: "account-1",
      access_key_id: "12345678",
      secret_access_key: "1234567890abcdef",
      region: "auto",
    },
    idempotency_key: UUID,
  });
});

test("clears every write-only value while preserving non-secret retry state", () => {
  const profile = normalizeDriverCredentialDocument(documentFixture(), "r2").credential_form.profiles[0];
  const current = {
    account_id: "account-1",
    access_key_id: "12345678",
    secret_access_key: "1234567890abcdef",
    region: "auto",
  };

  assert.deepEqual(clearSecretValues(profile, current), {
    account_id: "account-1",
    access_key_id: "",
    secret_access_key: "",
    region: "auto",
  });
  assert.equal(current.secret_access_key, "1234567890abcdef");
});

test("builds complete rotation and removal with the exact CAS generation", () => {
  const profile = normalizeDriverCredentialDocument(documentFixture(), "r2").credential_form.profiles[0];
  const values = {
    account_id: "account-2",
    access_key_id: "abcdefgh",
    secret_access_key: "fedcba0987654321",
    region: "wnam",
  };

  assert.deepEqual(buildRotatePayload(profile, "Production", values, 4), {
    profile_id: "access-key",
    label: "Production",
    values,
    expected_generation: 4,
  });
  assert.deepEqual(buildRemovePayload(4), { expected_generation: 4 });
  assert.throws(() => buildRemovePayload(0), CredentialFormError);
  assert.throws(() => buildRotatePayload(profile, "Production", values, 3.5), CredentialFormError);
});

test("rejects incomplete, oversized, or out-of-profile submissions", () => {
  const profile = normalizeDriverCredentialDocument(documentFixture(), "r2").credential_form.profiles[0];
  const valid = {
    account_id: "account-1",
    access_key_id: "12345678",
    secret_access_key: "1234567890abcdef",
    region: "auto",
  };

  assert.throws(
    () => buildCreatePayload(profile, "Production", { ...valid, secret_access_key: "short" }, UUID),
    CredentialFormError,
  );
  assert.throws(
    () => buildCreatePayload(profile, "Production", { ...valid, account_id: "x".repeat(129) }, UUID),
    CredentialFormError,
  );
  assert.throws(
    () => buildCreatePayload(profile, "Production", { ...valid, region: "unlisted" }, UUID),
    CredentialFormError,
  );
});

test("enforces cardinality one and initializes fields without secret defaults", () => {
  assert.throws(
    () => normalizeDriverCredentialDocument(documentFixture({ cardinality: "one" }), "r2"),
    CredentialFormError,
  );

  const onlyOne = documentFixture({ cardinality: "one" });
  onlyOne.credentials = onlyOne.credentials.slice(0, 1);
  const profile = normalizeDriverCredentialDocument(onlyOne, "r2").credential_form.profiles[0];
  assert.deepEqual(emptyProfileValues(profile), {
    account_id: "",
    access_key_id: "",
    secret_access_key: "",
    region: "",
  });
});

test("uses the fixed JSON lifecycle methods and paths", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const baseUrl = "/api/teams/team_1/drivers/r2";

  await sendCredentialMutation(fetcher, baseUrl, "create", { payload: { idempotency_key: UUID } });
  await sendCredentialMutation(fetcher, baseUrl, "rotate", {
    credentialId: "9a-primary",
    payload: { expected_generation: 4 },
  });
  await sendCredentialMutation(fetcher, baseUrl, "verify", { credentialId: "9a-primary" });
  await sendCredentialMutation(fetcher, baseUrl, "remove", {
    credentialId: "9a-primary",
    payload: { expected_generation: 4 },
  });

  assert.deepEqual(
    calls.map(({ url, options }) => [options.method, url, JSON.parse(options.body)]),
    [
      ["POST", `${baseUrl}/credentials`, { idempotency_key: UUID }],
      ["PUT", `${baseUrl}/credentials/9a-primary`, { expected_generation: 4 }],
      ["POST", `${baseUrl}/credentials/9a-primary/verify`, {}],
      ["DELETE", `${baseUrl}/credentials/9a-primary`, { expected_generation: 4 }],
    ],
  );
  assert.ok(calls.every(({ options }) => options.headers["Content-Type"] === "application/json"));
  assert.throws(
    () => sendCredentialMutation(fetcher, "https://example.test", "create", { payload: {} }),
    CredentialFormError,
  );
});
