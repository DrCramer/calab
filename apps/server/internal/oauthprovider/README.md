# Workspace OAuth/OIDC provider

This package implements ADR-0054 and the frozen Identity v1 release contract.
It has no first-party auth, app, UI, SQL, migration, dependency, or signing-key
ownership. Existing shared queries and `oauthprovider/signing` are dependencies.

Integration uses `New(Config) (*Service, error)` followed by
`RegisterRoutes(httpx.Router)`. The router interface preserves the application's
route recorder and middleware. Config requires a database, trusted HTTPS
`PublicOrigin`, positive entitlement config, `SessionResolver`, and
`SignerForWorkspace func(uuid.UUID) (*signing.Keyring, error)`. `Now` is an optional
trusted clock. A signer must pin the exact workspace issuer, use independently
configured RSA keys, and retain verification keys through the rotation overlap.
The application validates the operator key configuration at startup.

`SessionResolver` has signature
`func(context.Context, *http.Request) (identitypolicy.Principal, error)`.
Consent, client administration, and grant routes require a first-party bearer;
the provider rejects known provider and bot prefixes before calling the resolver.
Only authorize may resolve an ordinary browser session for `prompt=none`.
Every issuance/profile boundary reloads database authority, membership, positive
entitlements, policy, directory state, assurance, and durable versions.

The consent page is `/oauth/consent?request=<opaque handle>`. It sends generated
`BindOAuthRequest` with `csrf_token = handle` to `/api/oauth/requests/{handle}/bind`,
including its bearer, exact configured Origin, and the per-request browser cookie.
The generated snapshot returns a new CSRF token. Decision sends generated
`DecideOAuthRequest` with that token, `allow`, and `allow_refresh` and receives
`OAuthDecisionResponse.redirect_url`. Proto JSON uses its usual lowerCamelCase
field names. Client, user, session, scopes, redirect, nonce, and versions come from
the saved server snapshot; account substitution is rejected. The same session may
bind again (page reload): the CSRF token rotates. A client renamed after bind makes
decide answer 409 `IDENTITY_CONFIG_CHANGED`; the page binds again to show the name.
Pending requests are capped at 4 per browser (bindings evicted from the cookie are
deleted) and 100 per trusted client IP (`temporarily_unavailable`). Re-consent
replaces only this device's grant; narrower scopes or a changed refresh decision bump
the consent version and close the client's grants on every device.

Integrator profile: `state` and `nonce` are **required** on every authorization
request (1–512 bytes; otherwise `invalid_request`), although OIDC Core makes `nonce`
optional in the code flow. PKCE S256 is required for every client type. RPs must
check `state` and `iss` on the redirect and `nonce` in the ID token.

The integrator must serve that page with `frame-ancestors 'none'`, retain the
provider's no-referrer/no-store headers, redact protocol query strings and secrets
from access logs, add the application's endpoint rate limits, proxy both metadata
paths before SPA fallback, and wrap the routes with `httpx.WithClientIP` (the per-IP
request cap uses it). OAuth-only changes (grant/token revocation, client disable or
security edit) write audit rows but no identity invalidation: gateway/RTC never
accept provider tokens and every provider endpoint re-checks the grant. No
handler uses cookie credentials at token/revoke/UserInfo or interprets a provider
token as a Calaba API token. End-to-end Calaba API/WS/RTC rejection is integrator
acceptance work, not proven by the isolated provider tests.

Client management (list/get/create/update/delete/rotate) needs the builtin
owner/admin role, the entitlement and, for workspace_sso sessions or enforced SSO,
a fresh SSO proof, but no recent local password (ADR-0102); recovery sessions are
denied. Writes require an Origin that is `PublicOrigin` or one of `Config.AppOrigins`
(the API's `PUBLIC_APP_URL*` origins) and not `Sec-Fetch-Site: cross-site`; a refusal
is 403 FORBIDDEN with an info log naming the Origin and route. Validation failures
are 422 with the field (`name`, `type`, `redirectUris`, `allowedOrigins`, `scopes`)
and a stable message. Redirects are exact https URIs or plain-http loopback
(`localhost`, 127.0.0.1, [::1]) for every type; only native clients may use a
reverse-domain scheme or vary the port of a loopback IP literal.

Client mutation routes accept generated management DTOs; the path identifies the
public client ID or returned record ID. PATCH takes the complete editable snapshot
and expected security version. Name-only updates preserve that version. Security
updates and secret rotation revoke families and invalidate pending requests/codes.
Only two unexpired secrets are accepted during the bounded ten-minute overlap;
`revoke_old` closes it immediately. Secret responses and all protocol credentials
are no-store and secrets are shown once. First-party errors carry the generated
identity error code (including SSO proof, recovery-only, and dependency failures); external OIDC errors retain the RFC form and snake_case JSON contract.

Transactions lock workspace/policy before client/grant and the matching identity
boundary, then load policy state. Post-lock checks use fresh application and DB
clocks; issued lifetimes satisfy both clocks and stored source-session/proof/grant
deadlines. Refresh reuse and access loss commit durable revocation even when the
HTTP response is an error. Refresh scope narrowing persists on the entire family.

Run from `apps/server`, using the existing isolated provider-role fixture:

```sh
go test -race -tags integration -count=1 ./internal/oauthprovider/...
```

Set `TEST_DATABASE_URL` (or `TEST_PG_URL`; read through `internal/db/dbtest`, no
built-in default) to an admin URL on PostgreSQL 17 or 18. Each test creates and
drops its own random database and runs the actual migrations. The independent RP
uses HTTPS, wire discovery/JWKS, and direct RSA/JWT verification, not signer Verify.
The suite covers replay/races, CSRF/account binding, exact redirects, scopes, secret
rotation, grant revocation, original-proof deadlines, lock waits, clock skew,
cross-issuer subjects, token confusion, downgrade, and key rotation. Run `make lint`
from the repository root. Full server integration and two final independent
security/protocol reviews remain coordinator-owned acceptance gates.
