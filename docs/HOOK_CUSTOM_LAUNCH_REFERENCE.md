# Offline custom launch reference

This is a reference harness for the recovered immutable single-blocked-owner custom ABI. It is
not the selected max-wallet product. The profile's exact `capability.kind` and versioned request
schemas are mandatory; unknown policies and fields are refused. Max-wallet requires its own
reviewed protocol ABI, semantics, profile, vectors and adapter. No UI or route represents it here.

## Two separate stages

`planCustomPreparation` generates the two preparation instructions described in
`HOOK_CUSTOM_PREPARATION.md`. `buildCustomLaunchReviewForFixture`, in
`src/hooklab-custom-launch.mjs`, separately generates the guarded launch instruction from an
explicit synthetic prepared-state fixture. Preparation and launch must remain distinct transactions:
preparation needs writable policy/registry accounts, while launch requires both read-only across
the entire transaction. Combining them fails the protocol's privilege check.

The fixture export accepts only the strict `hooklab/synthetic-prepared-state/1` evidence shape with
`productionPreparationReceipt: null`. It binds the preparation request/profile digest and canonical
policy, registry and selected-config bytes. It cannot turn those observations into a live receipt.
The normal `buildCustomLaunchReview` export always refuses with
`CUSTOM_PREPARATION_PROOF_UNAVAILABLE`, including missing, pending, unknown, caller-finalized and
synthetic evidence. No callback or caller-selected verifier can override this boundary.

## What the fixture planner verifies

- Exact source-patch/profile, program identity, IDL and ELF pins. Each program links to its canonical
  ProgramData; the reviewed ELF length is hashed and remaining allocation bytes must be zero.
  The gate is immutable. Retained larger swap allocation is handled without changing its ELF pin.
- Two explicitly labelled observations agree on the complete raw inventory, ownership, lamports,
  absence and public keys. Chain, slot/freshness and post-preparation bounds are checked.
- Exact canonical immutable policy and literal read-only registry, selected creator/config/label,
  zero creator/author fees, no Kit rules, and only `BEFORE_TRANSFER`.
- Current launch/swap config and governance, admin co-signer, distinct role identities, unpaused
  creation/trading gates, governance economics digest, collector/treasury equality, current enabled
  creator grant, remaining quota and exclusive expiry. Reviewed current-state hashes must match.
- Canonical bounded native quote-mint encoding, no quote hook, source curve arithmetic, fee/debit
  limits, payer funds, lifetime and blockhash context. No future economics defaults are selected.
- All 40 launch accounts in exact order, fixed/remaining-account privileges, complete compiled
  signer/writable sets and recomputed economics/governance/control/custom-hook commitments.
- Active, warmed, canonical optional ALT state with at most 256 addresses / 8,248 bytes; no role
  aliases. Requested compute limits and rounded priority/signature fees fit the explicit cap.

The output is an unsigned v0 review containing two compute-budget instructions and one guarded
custom launch. It stays `offline-synthetic-review-only`; signing, submission, retries, acceptance,
approval and adoption remain false. No wallet, key generation, RPC, persistence or public route is
introduced. The frozen plain SDK remains unchanged.

## Evidence and limits

The fixture is extracted from the separately executed Rust/LiteSVM vector with full-vector SHA-256
`f5820f16ea1a4ab59598f8d85e0c068c7e44492ce81c18acfbb617b5a6d389f2` and reviewed profile SHA-256
`dd3ee75373208bc58c2079d107fb8c7e998b01560ae33a69ca36b109c8f20391`. Its provenance is explicitly
synthetic, never RPC. Tests match every instruction byte and ordered meta and mutate state while
refreshing dependent hashes to exercise semantic checks rather than hash rejection alone.

Profile hashes, provider labels, observed account state and fee inputs are trusted offline assertions,
not an authenticated reader or approval. `feeEvidenceAuthenticated:false` and
`dependencyCodeAuthenticated:false` are explicit; the token dependency's executable link is checked,
but this adapter does not authenticate its ELF. Synthetic labels do not establish two independent
providers. The deliberately manufactured ALT cannot be used as a live lookup-table observation.

The next runtime prerequisite is a server-controlled durable preparation-record resolver, binding
verified signatures, exact retained signed wire/message and resolved v0 keys, identified-reader
finalized inclusion/operation outcome, canonical post-preparation account bytes and the original
intent/profile. It must reconcile uncertain outcomes under the same identity without blind retries.
Fresh authenticated current-state/blockhash/fee/dependency reads are also needed before any future
execution boundary. Implementing those does not itself adopt a profile or grant signing authority.
