# Hook execution foundation — inert candidate, not production activation

## Delivery boundary

`GET /api/hook-lab/production` now publishes `repoing/hook-execution-contract/1` alongside
unchanged unavailable readiness. Every capability remains false. POST still returns 423 before
reading input. There is no preparation, simulation, signing, submission or custom-Hook HTTP path.
`hookExecutionIntentSchema` specifies strict future plain/buy/sell requests; parsing is not approval.
The schema rejects both Playground formats, rule blocks (including explicit zero), custom Hooks,
client readiness, snapshots and unknown fields. Plain metadata recipes are networkless; only the
separate intent binds expected genesis/profile/policy, quote mint/decimals, identities and raw u64
amounts/caps. Those expectations must be compared with server-derived authority, never adopted.

The Playground thread owns metadata export in its separate checkout. No Playground code or
uncommitted evidence from other threads is imported here. Simulation output is never a quote,
transaction, receipt or market volume.

## Smallest execution service still required

Use the existing authenticated owner journal, not a second transaction sender. A future reviewed
service must reconstruct production instructions from a strict intent and fresh, independently
read deployment/config/control/quote accounts. Bind source/profile/SDK/IDL/ELF, authorities, creator
grant, fee recipients, account privileges, ALT bytes, deadline, slippage, rent, input and total debit.
Reserve an owner-scoped idempotency key atomically with the immutable mint/message review. Same key
with different bytes is a conflict, not an update. Return exact unsigned v0 bytes only after policy
and simulation postconditions pass; revalidate before each signature and broadcast. No custody of
private keys. Explicit external mint signer or separately approved client vault remains required.

`hooklab-message-boundary.mjs` already checks exact wire/signatures/fees/freshness and two-provider
receipts; `hooklab-curve-journal.mjs` retains partial signatures and first-finalized evidence through
restart/outages/conflicts. These are offline candidates, not an adopted public service. Keep recovery
owner-scoped and available after disconnect/grant revocation. Preserve same mint, message and original
signature; expiry, a failed RPC read, or a missing receipt cannot authorize replacement/rebroadcast.
The plain journal does not yet retain partial signatures: do not advertise that as implemented there.

## Native index: discovery and pinned self-CPI decoding; acceptance remains blocked

`indexHookNativeBatch({manifest, adapters, store})` scans at most 32 slots per call (default eight),
bounded by the lower of two finalized roots. Operator-selected distinct trust domains must agree on
genesis, complete produced-slot inventory and full transaction responses. It resolves loaded ALT
keys and both top-level/CPI program invocations, retains failed transactions, and records skipped
slots. Program references without invocation are not trades. Missing/pruned history, unsupported
versions, missing inner-instruction recording, unsafe balance integers, disagreement and ancestry
drift stop the batch without advancing its checkpoint. Provider independence needs operator review;
different labels/URLs cannot establish it. Full-block scanning favors completeness over efficiency;
archive availability, RPC quotas and catch-up throughput need production sizing.

The PostgreSQL store commits block evidence, transaction rows and checkpoint together, serializes
competing writers and never overwrites receipts. Stream identity hashes the entire fixed manifest,
including explicit start slot, program inventory, source/profile/IDL and providers. Changing pins
starts a separate stream; do not silently replace history. Reconnect/restart resumes the same stream.
`src/hooklab-native-index-schema.sql` is **not registered as a migration**. There is no environment
activation, default manifest, cron, public index endpoint or general-worker registration.

RPC is restricted to five read methods with timeout, HTTPS and redirects refused. Retained hashes
are of normalized JSON, not raw wire attestations. Rows separately expose `receiptStatus`,
`eventStatus`, `economicPostconditions:false` and `deploymentAdopted:false`.
`productionHookEventDecoder()` optionally decodes launch/swap self-CPI events using exact
production-address IDLs from `b3dc429`, retained with hashes in `vendor/hooklab-event-abi`.
It verifies instruction ancestry, event-authority PDA, discriminator and canonical Borsh bytes;
integers larger than JavaScript's safe range stay decimal strings. Logs are never event authority.
Missing CPI stack heights or malformed events stop a decoded batch before checkpoint advancement.
The manifest must match the decoder's source, combined ABI digest and explicit program inventory.
`transactionFailed` concerns the outer transaction: outer success does not prove that an inner
invocation was not rolled back after a caught failure. These are decoded observations, not trades.

Ordered transaction-bound historical account replay, independently reviewed deployment intervals
and real operation acceptance fixtures remain missing. Never feed raw/decoded rows into Meteora
volume, Playground forecasts or settled-trade analytics. The historical `f3062df` SDK and the new
custom candidate must not be substituted for this decoder's source/addresses.

## Receipt and economic acceptance gates

Each accepted operation needs the retained reviewed message and signatures, two agreeing finalized
receipts, adopted deployment at that slot, and authenticated transaction-bound before/after account
history (slot plus transaction index). Later account snapshots and signed archive-author assertions
alone are insufficient. Existing curve accounting deliberately returns `chainVerified:false`.

| Claim | Required economic evidence, in addition to exact successful receipt |
| --- | --- |
| Buy / sell | Native custom-token holding ownership/mint/PDA, actual trader debit/credit, net minimum output, reserve/vault deltas, protocol counter and fee amounts, unchanged unrelated accounts. Never infer from SPL `preTokenBalances` or simulation. |
| Nonzero protocol accrual | Reviewed nonzero fee configuration bound to pool creation; strictly positive fee computed using the source model/rounding; exact increase in `protocol_fees_quote`; quote vault equals reserves plus accrued fees. Zero fee, configured collector or transaction network fee is not proof. |
| Collector settlement | Separate collection receipt; protocol counter clears by exactly the positive collected amount, quote vault decreases, correct configured collector holding/wallet receives it. Native SOL collection also proves bridge burn/supply/wrapper/lamport conservation, separately accounting for payer fee/rent. Accrual is not payout. |
| Creator split | Separate explicit supported contract, recipients and native holding deltas. Neither protocol fees nor collector settlement proves creator revenue. Existing plain creation forbids creator fees. |
| Graduation | Prior curve status and threshold OR sold-out base; exact reserve top-up, reserve remainder burn, supply decrease, final vault balances excluding accrued protocol fees, virtual offsets zero, curve false, launch status/timestamp/top-up/burn fields, LP mint/supply and launch-owned LP holding. Threshold/event alone is not proof or LP withdrawal capability. |
| Custom Hook | Exact newly released program/profile and reviewed callback/config/registry/authority/extras; positive invocation with an observable effect plus rejection/rollback of unauthorized caller, substituted program, signer escalation, stale config and callback failure. Plain launch callbacks do not qualify. |

## Protocol ownership and required changes

The retained deployed inventory is in `HOOK_LAB_PRODUCTION_CONSUMER.md` (2026-10-17 evidence).
It reports paused launch/swap, zero pools/launches and zero protocol fees, with ELF matches to
archived source `b3dc4297735fe2e061fca7b6563d69cf81e0911c`. This is evidence, not live adoption here.
The vendored SDK source is separately `f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32`; source-tree equality
does not establish binary identity. Upstream candidate manifests still say not deployed; that
historical label does not negate the separately retained deployment receipts.

Actual protocol ownership is **New1Direction/hook-lab**, not repo.ing's Token-2022 early-access hook.
At the deployed source, `programs/bordrless_launch/src/lib.rs:create_launch_mainnet` compiles in
plain-only/no-config/no-Kit checks. `programs/bordrless_swap/src/instructions/pool.rs` requires the
launch authority and fixed pool callback and forbids token hooks on both mints. Custom capability
therefore requires a **new reviewed launch and swap release**, explicit ABI/SDK/profile and binary
attestation; not a flag, relabel, default-ID builder or activation of the deployed binary.
Reuse upstream registry/extras/authority checks; start with one bounded custom token callback rather
than pretending the six simulation modules are executable. Keep legacy/direct pool routes closed,
creator grants/guards/pause controls enforced, and quote token hooks prohibited. Exact custom policy
and deployment adoption are independent of this public contract, which continues to refuse it.

Fee accrual/collection and basic graduation already exist in that source. Nonzero economics need
separately authorized configuration and new-pool snapshots, SDK/receipt adapters and owner receipts,
not necessarily new arithmetic. Graduation uses `bordrless-core::graduation_topup`, bounded by the
launch reserve, then burns the rest; `initial_lp` reserves 1,000 minimum liquidity. The first LP stays
at the launch PDA; no owner withdrawal claim follows. Custom callbacks add new transfer/burn paths
that must be accepted separately. No trial may cross its budget to manufacture a graduation proof.

## Owner-operated gates; no automatic rollout

1. Review the local commits, upstream custom policy/ABI, reproducible binaries and malicious-callback
   cases. Accept exact source/SDK/IDL/profile/dependency pins and authority semantics separately.
2. Approve target-specific schema, encrypted backup/restore and read-only observer deployment;
   select independent archive providers, start slot, alert destination and operator. Inspect all
   pending migrations; never start the existing general worker as a substitute Hook observer.
3. Approve creator/mint custody and budgets, nonzero fee configuration and collector, then separately
   authorize bounded owner-operated launch/buy/sell/recovery/collection receipts. No approval is
   implied by passing local tests. Graduation needs its own affordable trial and postcondition proof.
4. Only after accepted receipt/economic/history/deployment evidence, approve public execution rollout
   and any unpause. Binary adoption, push, deploy, real-money operations and shared migrations remain
   forbidden in this task. Local protocol implementation/builds are separately authorized follow-on
   work, not deployment. Disable new preparation on drift; preserve evidence and read-only recovery.

## Owner-operated observer / Railway preparation

`node scripts/index-hook-native.mjs --once <reviewed-manifest.json>` runs one bounded decoded batch
and exits. It requires `HOOK_INDEX_DATABASE_URL` (an explicitly selected isolated database), plus
`HOOK_INDEX_RPC_<PROVIDER>` for the manifest's two providers (uppercase, hyphens replaced by `_`).
It refuses the same origin, but different origins alone do not prove provider independence. It
never uses the application's default database/RPC, applies a migration, starts a loop or signs.
No Railway configuration or service was mutated. No automatic retry/restart is configured.

Before any shared rollout, the owner must approve the exact SQL, backup/restore rehearsal, least-
privilege database role, archive providers and retained-data policy. Start with a dedicated Hook
observer service/job; **do not start `scripts/run-worker.mjs`**, which owns unrelated operations.
Use the one-shot command as the reviewed job command, with restart disabled initially. A separate
approved scheduler can invoke it after catch-up/throughput review. Alert on nonzero exit, checkpoint
lag, provider disagreement/pruning, ABI drift and stalled scans; never skip a slot to recover.

Construct the manifest offline with `hookIndexManifestSchema`: mainnet genesis, retained profile
digest, reviewed start slot, provider labels, and the decoder's `sourceCommit`, `idlSha256` and
`programs`. Do not infer the start slot from “now”; prove archive coverage from deployment onward.
First run on disposable PostgreSQL, retain complete evidence, then obtain target-specific approval.
On rollback stop new batches, preserve database/checkpoints/journals, and leave HTTP execution
blocked. Do not delete streams or downgrade evidence, even if a UI release is rolled back.

## Deployment adoption / owner acceptance packet

Adoption must be a separately reviewed, server-owned append-only ledger, initially empty. Each
entry must bind genesis; exact launch/swap/token/bridge addresses and ProgramData; source, ABI,
SDK, policy and ELF/provenance hashes; upgrade/admin/guardian/collector roles; quote mint/decimals;
and an inclusive start/exclusive end **transaction position** (slot plus transaction index).
A slot-only interval can misattribute a transaction before an upgrade in the same slot. Derive
positions from finalized loader receipts and transaction-ordered historical program/account
evidence, not latest account snapshots. Close an interval on upgrade/config drift; no overlapping
or open-ended “forever trusted” intervals. The current observer matches snapshots only and cannot
establish this ledger. Accordingly **every decoded row still has deploymentAdopted:false**.

The acceptance packet must retain exact reviewed messages, partial and final signatures, first-
finalized evidence, both providers' receipts, ordered account pre/postimages and independent
economic assertions. Include separate creation, rejected callback, buy, sell, protocol accrual,
collector settlement, recovery/outage and graduation records. Keep missing evidence explicit;
never replace it with simulation, configured fees, a threshold event or a collector address.
Owner approval must name the operation budget and action; deployment approval is not trade,
unpause, migration or public-activation approval. The Playground remains metadata-only and no
client readiness, exported recipe or observed snapshot can populate the adoption ledger.
