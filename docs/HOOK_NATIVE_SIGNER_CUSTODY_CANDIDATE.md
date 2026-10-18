# Native signer custody candidate (default off)

This server-only candidate retains both the mint and selectedConfig signers across
separate preparation and launch transactions. It is not an owner-approved custody
service and has no public route, environment discovery, key generation, transaction
signing, broadcast or production resolver integration. Tests supply deterministic
synthetic signers and a test-only key ring. No existing platform secret is reused.

## Boundary

`nativeSignerCustodyStore` requires explicit `enabled: true`, HTTPS identity origin,
and an explicitly supplied 32-byte encryption key ring. Its PostgreSQL pool must be
the same database that owns wallet principals. Its trusted `retainServerSigners`
method accepts server-memory signers, never browser/API key input. Public summaries
contain addresses, stages and revision only, never plaintext keys or ciphertext.
`ownerCustodyApprovalVerified`, `canSign`, `canSubmit` and `executionAuthorized` stay
false. The lower-level codec's `open` returns sensitive server-memory objects and
must never be exposed through an API, error, log or browser serialization.

AES-256-GCM uses a fresh random 96-bit nonce per seal. Domain-separated AAD freezes
operation ID, random durable custody-session ID, owner wallet, profile digest,
mint, selectedConfig, stage and key ID. The custody-session ID is deliberately
independent of an expiring login: the same authenticated wallet must be able to
recover retained operations after logging in again. Authentication tokens and
owner identity are checked and row-locked in the same transaction as custody.
Lock order is custody advisory/row lock, then wallet session FOR SHARE, matching
the reviewed preparation-journal discipline. Expiry is checked after work too.

Key IDs select only from the explicit ring. Rotation decrypts and authenticates
with the old key then reseals with the active key and a new nonce. Removing an old
key prematurely makes its records unavailable; deployment must retain old keys
until migration and recovery checks finish. Random nonce collision risk still
requires an operational per-key usage budget and rotation policy before approval.
Memory wiping is best effort; JavaScript and Keypair copies do not guarantee full
zeroization. Production custody needs a separately reviewed key-management and
backup/recovery policy. Errors must never include key bytes, envelopes or tokens.

## Durable lifecycle

The immutable operation identity and encrypted pair survive preparation review,
preparation signing/finality, launch review/signing/finality and uncertain outcomes.
Optimistic revision plus database locks prevent concurrent stage overwrites. A
history trigger retains each public stage/revision/evidence-digest witness in the
same transaction. `advanceCandidate` is bookkeeping only: its supplied digest is
not proof of signing, observation, adoption or finality. A production integration
must derive these transitions from independently verified retained transactions.

There is no expiration cleanup, erasure, deletion endpoint or destructive retry.
An expired wallet session denies access without deleting ciphertext. An uncertain
signed outcome enters terminal `reconcile-required`; future verified reconciliation
needs a separately reviewed transition rather than generating a replacement mint.
The candidate has no automatic recovery or launch authorization from that state.

The launch administrator is separate. `verifyNativeAdminSignerIdentity` rejects
missing, mismatched, off-curve or aliased roles; configured administrator must equal
freshly observed governance. It does not discover a key, substitute platform
creator identity, sign anything or certify observation provenance.

## Evidence and remaining gates

Run the five focused tests with a disposable PostgreSQL database on port 55432:

    node --test tests/hooklab-native-signer-custody*.test.mjs

The local harness is `/workspace/shared/hooks-release/postgres-test/with-postgres.sh`.
Tests cover AAD/envelope tampering, fresh nonces, redacted codec errors, rotation,
restart, retained uncertainty/expired sessions, immutable identity, history and
concurrent revision contention. These are synthetic offline tests only.

Before production: owner custody acceptance, approved key management, exact signed
release adoption, real new-mint preparation orchestration, separately authorized
admin signing, fresh two-provider state/transaction verification, browser acceptance
and live acceptance remain required. No live readiness follows from this patch.
