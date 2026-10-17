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

## Native index: implemented raw discovery; decoding remains blocked

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
`eventStatus:undecoded`, `economicPostconditions:false` and `deploymentAdopted:false`. No event name
is guessed from logs or selected from a mismatched IDL. CPI event-authority/discriminator decoding,
ordered historical account replay, adopted deployment intervals and accepted event fixtures are
the next adapter work. Never feed these raw rows into Meteora analytics or mark them settled trades.

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
