# New-mint preparation candidate

This incremental source builds on the reviewed encrypted custody candidate. It is
server-only, explicitly enabled through custody construction and has no HTTP route,
production configuration, adoption authority, signing, submission or retry path.
The tests use deterministic synthetic signer factories and injected local evidence.
No production key or new live signer was created by this work.

`reserveNewCandidate` creates the mint/config pair in the same transaction that
locks the authenticated wallet session and durable operation. Its default factory
is `Keypair.generate`, but no deployed route calls it. Tests inject deterministic
signers. The factory is trusted server configuration, never browser request data.
Existing operations always reuse their encrypted pair; concurrent attempts cannot
replace it. Failure after a possibly successful commit must recover by operation ID.

`reviewNewMintPreparationCandidate` binds creator AND fee payer to the authenticated
owner, and mint/config to the durable reservation. Only cap and label are caller
input. It reads two configured providers through `collectMaxWalletPreparationReview`,
then checks custody again and atomically records the exact immutable request plus
review digest and a new revision. Refreshes keep the same request; cap/label changes
cannot repurpose an existing reviewed mint. Any signed/uncertain stage refuses a
new preparation review. Database migration `hooklab-new-mint-preparation-schema.sql`
applies after the custody schema and prevents rewriting a retained intent.

## Actual collection implementation

The collector derives all 12 account addresses from pinned profile and request,
reads genesis, finalized account bytes and three rent sizes from both readers,
obtains a finalized recent blockhash, checks its validity and current height with
both readers, and obtains both exact-message fee quotes. It reuses the existing
strict planner for full ELF/ProgramData/IDL/config/role/privilege/economics checks.
All provider responses and final collection time are bounded. Errors are generic.
The separate transport permits only those seven fixed RPC reads, enforces HTTPS,
distinct configured origins, no redirects, deadlines and body limits. This does not
prove provider operational independence or provide private-network SSRF filtering.
No lookup table is supported in this candidate collector. Signature fee basis is
explicitly 5,000 lamports; both readers must quote the exact constructed message at
that basis or it refuses. Other fee regimes need a separately reviewed extension.

The candidate review contains unsigned offline message bytes for inspection, but
`productionUnsignedMessage` is null and all signing/submission flags remain false.
It never treats injected fixture evidence or an unconfigured adoption callback as
production approval. Mandatory blockers remain owner custody approval, explicitly approved
release deployment pins and production preparation authorization. Fresh collection alone
cannot remove them. Before any actual signing, complete revalidation, retained review
expiry handling and exact-message verification are still required.

## Tests

Use an ephemeral generated fixture directory, not committed ELF-bearing JSON:

    HOOKLAB_GENERATED_FIXTURE_DIR=/absolute/generated-dir node --test tests/hooklab-max-wallet-preparation-collector.test.mjs

With disposable PostgreSQL on 55432, also run:

    node --test tests/hooklab-new-mint-preparation-db.test.mjs tests/hooklab-native-signer-custody*.test.mjs

Tests cover actual Connection SDK method serialization through bounded fake fetch,
exact frozen byte reproduction, two-reader disagreement/fee/null/expiry failures,
durable same-mint refresh, immutable request, failed collection retention and refusal
after a signed stage. These tests do not establish browser or live acceptance.
