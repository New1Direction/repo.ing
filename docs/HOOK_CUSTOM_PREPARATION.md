# Offline custom preparation planner

`planCustomPreparation` in `src/hooklab-custom-preparation.mjs` is a pure local stage-one planner.
It has no RPC constructor, wallet, key generator, signer, sender, API route or public UI integration.
No default deployment profile, blocked owner, creator, mint, selected configuration or fees are chosen.

## Input contract

The function accepts exactly `{ profile, request, observations, recentBlockhash, lookupTable, limits }`.
All envelopes and known fields are strict. The profile envelope contains exact raw
`hook-lab/offline-custom-builder-profile/1` JSON, an independently reviewed `expectedSha256`, the
raw launch/gate IDLs as base64, ELF lengths and two configured reader labels. The release profile
pins source commit and source-patch digest, build feature, all program identities, IDLs, ELFs and
candidate scope. Adoption, owner approval, execution and signing flags must remain false.

The expected profile hash must come from trusted local/operator configuration, never an HTTP body.
A caller hashing its own JSON proves no approval or source provenance. Different provider labels
also do not prove independent operators. This module makes neither claim and is not exposed through
a request handler. Both the fresh-address and retained-address feature shapes require an explicit
reviewed profile; supporting a shape does not adopt either identity set.

Request fields are explicit public addresses for creator, outer fee payer, future mint, selected
configuration and blocked owner, plus label, `creatorFeeBps: 0`, `rules: none` and `hookFlags: 1`.
Required signer addresses must be on-curve. Fee payer may equal creator; fresh signer accounts,
policy/registry and fixed program/PDA roles cannot alias. The blocked owner may be a PDA because
it is instruction data, not a signer. Labels are limited to 32 UTF-8 bytes.

Two supplied, finalized-labelled snapshots must match exact account bytes, owners, balances and
absence states. They bind the launch/gate executable-to-ProgramData links, exact pinned ELF bytes,
immutable gate authority, canonical protocol Config, absent policy/registry/selected configuration,
uninitialized future mint, payer funds, genesis, slot range and freshness. These are offline supplied
assertions, not authenticated historical inclusion or a server-issued acceptance record.

Rent quotes must cover policy 72 bytes, registry 47 bytes and selected LaunchConfig 176 bytes.
The planner checks quoted rent, payer balances, network/priority fee, total debit, compute limits,
message size and review lifetime. The supplied network fee must equal required signature count times
the explicit positive lamports-per-signature basis plus the exact requested priority fee;
`feeEvidenceAuthenticated:false` discloses that no RPC fee quote was authenticated here. A supplied optional ALT must have matching raw bytes/hash,
be active and warmed, and produce the reviewed resolved account privileges.

## Exact output boundary

The unsigned v0 message contains exactly:

1. Explicit compute-unit limit.
2. Explicit compute-unit price.
3. Gate `prepare`, requiring creator and future-mint signatures.
4. Launch `create_config`, requiring creator and fresh selected-config signatures.

The gate ProgramData is appended as the eighth `create_config` account. It is a mandatory remaining
account in the Rust client/handler, absent from the fixed IDL account list. The compiled transaction's
complete signer/writable sets are independently checked. Outer payer may be separate from creator.

The output includes exact instruction bytes/metas, required public signers and debit/rent summaries.
It always says `offline-unverified-preparation`, `canSign:false`, `canSubmit:false`, `canRetry:false`,
`preparationReceiptAccepted:false`, `deploymentAdopted:false`, `policyApproved:false`, and `launchPlan:null`.
Preparation IDLs contain no rent-cap or deadline guard. Accordingly `rentCapEnforcedOnchain:false`
is explicit: these are local review bounds, not an onchain spending guarantee. Blockhash validity,
exact-message network fee quotes and actual rent/sysvar state need trusted fresh read adapters before
any future execution flow. This patch does not provide those adapters or execution permission.

## Why launch remains unavailable

Gate policy/registry are writable during preparation. A custom launch requires them read-only across
the whole transaction, so preparation and launch cannot be combined. The protocol SBF test confirms
that the combined transaction fails `HookExtrasMismatch` and rolls back all watched changes.

Stage two needs a separate, durable server-controlled preparation record binding exact unsigned
message/intent/profile, canonical signed wire and signer verification, resolved v0 keys, retained
identified-reader finalized receipt evidence and canonical post-preparation bytes. Caller JSON such
as `finalized:true`, a signature or matching accounts cannot create that record. Unknown outcomes
must reconcile the same identity, with no blind retry or silent replacement mint.

The separate `buildCustomLaunchReviewForFixture` reference harness now revalidates current gate
code, launch/swap governance, admin co-signing, creator grant/quota/expiry, config commitments and
exact launch economics/debit bounds against synthetic prepared state. Its production export refuses
all caller evidence until the trusted durable resolver exists. See `HOOK_CUSTOM_LAUNCH_REFERENCE.md`.
This recovered blocked-owner ABI is only a reference; the selected max-wallet policy requires a new
reviewed ABI/profile and adapter. The frozen plain SDK and public production execution schema remain
unchanged.

## Evidence

`tests/hooklab-custom-preparation.test.mjs` verifies strict refusal cases, both shared/separate payer
signers, exact independently encoded Borsh data, transaction privileges, ALT/funding checks and
byte-for-byte account-order conformance against the Rust retained-ID staging vector.

The compact `hooklab-custom-rust-vector.json` fixture extracts only required public synthetic prestate
and preparation instructions. It identifies full source vector SHA-256
`42a557ce9e91e2c092b51b590ebbbee6223a3df6708ec70d20923744a677a523` and exact profile SHA-256
`dd3ee75373208bc58c2079d107fb8c7e998b01560ae33a69ca36b109c8f20391`.
Its provenance is synthetic LiteSVM, never RPC; `productionPreparationReceipt` remains null. No
private keys or signatures are included. The test cannot turn this fixture into live evidence.
