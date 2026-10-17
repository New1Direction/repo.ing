# Isolated wallet-first identity foundation

`src/hooklab-wallet-principal.mjs` and its dedicated SQL implement a default-off,
server-only identity primitive. They are not imported by public routes or the
max-wallet launch builder. No runtime configuration is changed by this patch.
Apply neither schema nor enablement to production without separate review.

The wallet signs a domain-separated, exact message bound to HTTPS origin,
application audience, mainnet genesis, on-curve wallet, random nonce, five-minute
DB-clock expiry and a server-issued pre-login browser binding. The existing
Ed25519 signature verifier is reused without its GitHub account-link behavior.
Verification locks the challenge, checks time after acquiring the lock, and
atomically consumes the nonce with creation of a 30-minute session. Only a hash
of the high-entropy session token is stored. Resolution enforces scope, expiry
and revocation; a nonce, wallet address or bearer operation UUID is not identity.
Concurrent verification succeeds once. All identity outputs explicitly deny
launch/sign/submit/execution authority.

## Integration still required

- A separately reviewed HTTP layer must issue the random 32-byte pre-login binding
  in a Secure, HttpOnly, SameSite cookie. Never source this binding from request JSON.
- Same-origin checks, CSRF protection, strict bounded request bodies, IP/wallet
  challenge quotas, verification rate limits, cookie lifecycle/rotation, logout,
  cleanup and browser rejection/recovery need integration and adversarial tests.
- The returned session token is for the trusted cookie-setting layer only. Never
  include it in ordinary JSON, logs, URLs, artifacts or analytics.
- A wallet principal does not authenticate an RPC observation, adopt a deployment,
  approve spending or authorize launch. The existing production builder stays closed.
- The current preparation journal still has GitHub-owner keys. Do not map wallet
  addresses into that column or retrofit an unauthenticated owner string. A separate
  wallet-owned preparation journal/resolver is needed, with schema migration and
  ownership/evidence provenance review.
- Public challenge/session endpoints, production credential issuance, migrations,
  flags, wallet calls and live network interactions are outside this change.

The database tests create a fresh isolated loopback PostgreSQL database and use
only deterministic synthetic test keys. No user credentials or live wallet are
used. GitHub is not required by this primitive.
