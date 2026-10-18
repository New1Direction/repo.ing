# Read-only custom preparation evidence and dedicated journal

This is a server-side candidate-verification slice. It does not activate a public custom launch,
accept a production preparation receipt, sign, submit, retry or select a deployment. Synthetic
fixtures exercise real Ed25519 verification and exact transaction bytes without using a real wallet
or RPC. The recovered blocked-owner adapter is a reference; max-wallet must use its separately
reviewed policy-specific ABI adapter rather than reinterpret these policy bytes.

## Retained identity and source checks

`deriveCustomPreparationRecord` rebuilds the exact stage-one plan from retained inputs and an
independently configured profile SHA-256. Its strict policy adapter derives canonical policy,
registry and selected-config expectations from pinned IDLs. A caller cannot supply arbitrary
expected account bytes. All required signatures in the retained signed wire are verified against
that exact unsigned message; a changed message, signer, mint or profile is not a retry candidate.

`verifyCustomPreparationEvidence` is a pure checker of supplied assertions. The configured read-only
collector obtains two identified observations itself. They bind genesis, finalized transaction and
block identity/inclusion, exact signed wire, resolved v0 addresses/privileges, fee and complete safe
integer pre/post-balance vectors. Native deltas account only for the three new rent accounts and
creator/outer-payer costs; failure requires fee-only rollback. Local reviewed slot/blockheight and
debit bounds are checked, but preparation has no onchain rent/deadline guard.

A single finalized account read per provider binds prepared accounts plus launch/gate Program and
ProgramData. Canonical links, owners, executable flags, exact reviewed ELF lengths, zero allocation
tails and immutable gate authority are checked. A ProgramData deployment at or after the receipt
slot is refused, because current bytes alone cannot establish within-block upgrade order. This
relies on the canonical loader's state semantics; it is not a general historical code archive.

Selected LaunchConfig.created_at comes from runtime Clock. Every other byte is derived exactly,
while that bounded dynamic field must canonically encode and agree between the two current immutable
snapshots. RPC blockTime is not substituted for Clock. Snapshot context slots may follow the
transaction, and account donations may change lamports: neither is misrepresented as historical
wallet state. `historicalStateVerified:false` remains explicit. Actual rent/debits come from the
transaction's balance vectors, not later snapshots.

Missing, pending, inconsistent, failed, malformed, unsupported or oversized evidence remains
unresolved or failed. All result capability/acceptance/adoption flags remain false. Two labels and
different connection endpoints reject obvious aliasing but do not prove operational independence;
reader configuration must be reviewed separately. Underlying configured transports remain responsible
for network response-body limits and cancellation; the collector bounds normalized evidence and wait
time and does not expose transport errors or credentials.

## Dedicated durability

`customPreparationJournal` captures immutable server configuration: expected profile SHA, two reader
identities and evidence mode. No HTTP payload can choose these. It rebuilds retained input and checks
signed wire/evidence before persistence. Atomic transactions serialize each operation, enforce unique
chain/mint/message identity, and append audit evidence. The original finalized evidence is retained
across restarts and provider outages. Genuine contradictory finalized evidence latches review-required;
new timestamps, later same immutable snapshots or donations cannot create a false conflict.

The SQL in `src/hooklab-custom-preparation-schema.sql` is deliberately absent from shared migrations.
Tests provision only a fresh disposable local database. No database role or production permission is
created. Internal mutation methods are not exposed through a route, scheduler or general worker.
Configured collection and persistence must be composed server-side; never accept client-supplied
observations as a trusted read result.

## Owner-scoped read route, off by default

`GET /api/hook-lab/production/preparations` uses the existing encrypted GitHub identity session.
The immutable GitHub account ID scopes every query. It accepts only either an optional canonical
UUID `id` or a canonical `limit` from 1 to 50 (default 25). Unknown/duplicate keys, profile/provider/
RPC selectors and malformed values return 400. Other-owner IDs return 404. POST returns 423 without
reading a body. Responses are private/no-store and exclude signed wire, raw observations, account
bytes, full preparation input and credentials.

The route does not access a database or config file unless
`HOOK_CUSTOM_PREPARATION_READ_ENABLED` is exactly `true`. An approved isolated read rollout also
needs these dedicated server settings:

- `HOOK_CUSTOM_PREPARATION_DATABASE_URL`: dedicated least-privilege SELECT connection; no ambient
  app `DATABASE_URL` fallback.
- `HOOK_CUSTOM_PREPARATION_READ_CONFIG_FILE`: a bounded JSON file with schema
  `repoing/custom-preparation-read/1`, `expectedProfileSha256`, exactly two `expectedProviders`, and
  explicit `evidenceMode` (`synthetic-fixture` or `configured-readonly-rpc`). Unknown fields fail.
- `HOOK_CUSTOM_PREPARATION_READ_CONFIG_SHA256`: independently reviewed hash of those exact file bytes.

Each request uses a short-lived read-only pool with connection/query/statement timeouts. Responses
are capped at 256 KiB. Missing/drifted configuration, unavailable storage and corrupt evidence return
redacted 503. This flag enables reads only; it cannot activate any preparation or wallet operation.

## Remaining authority boundary

The existing production launch export remains closed. A future runtime resolver must consume a
server-owned retained verification record, revalidate current policy-specific state/code and explicit
adoption/custody/owner choices, and bind the same original identity. Merely copying a matching result
or setting `evidenceMode` in JSON is not a trusted preparation proof. The selected max-wallet user
flow must consume its exact new adapter and real reader configuration before any owner-approved
wallet-signing integration is considered.
