# Account Admin-session protocol v1

Account owns this protocol. Hosted Admin uses it to prove that its exact
browser cookie still represents an enabled, non-erased Account with current
Supervisor privilege.

`POST /v1/internal/admin/sessions/introspect` requires the dedicated Admin
session capability. Consumers must read that file-backed capability for each
call and must not share it with Store, Team, Developers, or another Account
operation.

The request contains only version `1` and the exact Account session token.
An active response contains the opaque Account id and current Supervisor
boolean. A known expired, revoked, disabled, or erased session returns only
`{"version":1,"active":false}`. A malformed, unsigned, or unknown session is
unauthorized.

Hosted Admin validates this evidence online for every protected request. It
admits only `active=true` and `supervisor=true`, caches no positive result, and
never derives authority from a caller-supplied Account id or privilege.
Tokens, password material, session hashes, authentication methods, security
epochs, and protected payloads never enter responses, errors, or audit logs.
