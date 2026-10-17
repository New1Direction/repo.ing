# Default-off wallet identity HTTP and review UI

This additive boundary depends on the separately reviewed wallet-principal
foundation. It creates no live configuration, credentials or launch capability.
`HOOK_WALLET_IDENTITY_ENABLED` must be exactly `true`; absent that setting both
`/api/hook-lab/wallet-identity` and `/hooks/wallet-identity` are unavailable.
No navigation links or launcher routes are changed.

Server configuration requires an explicit HTTPS origin and separate identity DB
URL. The boundary never falls back to the main application database. The identity
and quota SQL remain outside automatic/shared migrations. No keys, RPC endpoints,
production values or secrets are supplied by this package.

POST requires the exact configured request origin, matching Origin header,
non-cross-site Fetch Metadata, JSON content type and a strict 2 KiB body. Client
JSON cannot choose an identity, browser binding, audience, chain or approval flag.
Duplicate or malformed identity cookies fail closed. GET returns only identity
status. All responses are private/no-store and deny execution authority.

Challenges get a fresh 32-byte server binding in a host-only `__Host-` Secure,
HttpOnly, SameSite=Strict cookie. Only its hash is in the signed message. Verification
uses that cookie and rotates to a hashed, time-bounded session credential; neither
credential is returned in JSON, URLs or logs. Logout revokes the DB session and
clears both cookies. Scope and expiry remain enforced by the store. A response lost
after proof consumption requires a fresh challenge, not replay or implicit success.

Fail-closed shared DB quotas bound IP-hint, wallet and nonce scopes. The app's generic
limits-disable flag does not override them. Forwarded headers are only a rate-limit
hint, never identity; operational proxy header sanitization and perimeter abuse
controls remain required before deployment. Missing address uses a bounded common
bucket. A quota DB failure prevents new authentication.

The isolated review UI uses the existing wallet adapter, requires an explicit
review button and a separate sign button, displays the exact identity-only message,
checks domain/audience/genesis/wallet/nonce/expiry before and after the wallet prompt,
and refuses a changed wallet. Cancellation and rejection create no launch action.
There is no auto-sign or transaction method. Browser acceptance has not been run;
these tests are source/unit/disposable-DB and build evidence only.

## Remaining before production

- Independently review this HTTP layer and the real browser/wallet rejection,
  cookie, rotation, expiry, concurrent-tab and disconnect experience.
- Confirm origin/proxy deployment settings, isolated DB ownership/permissions,
  explicit schema application, retention cleanup and operational alerting.
- Connect only a reviewed wallet-owned preparation journal/resolver; the existing
  GitHub-owner journal and production launch builder remain unchanged and closed.
- Adoption of release bytes, custody/admin cosigning, authentic RPC provenance,
  live acceptance and execution enablement are separate gates.

This is an identity foundation, not an authorization to sign or launch coins.
