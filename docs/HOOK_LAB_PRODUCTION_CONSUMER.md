# Production consumer boundary — local, inert preparation

No active production dossier, wallet execution, live RPC indexer or shared migration is
introduced. An isolated disabled production SDK candidate and unapplied recovery migration are
prepared for local tests only. Frozen `f3c57ccc` HLTEST and the separate `826b5a4`
candidate remain unchanged. This document supersedes their rollout assumptions only for future
production work; it does not change their historical evidence or activate any profile.

## Verified source inventory is not deployment acceptance

Source inspected: Hook Lab PR #3 head
[`b3dc429`](https://github.com/new1direction/hook-lab/commit/b3dc4297735fe2e061fca7b6563d69cf81e0911c),
runtime source [`2d2b85c`](https://github.com/new1direction/hook-lab/commit/2d2b85cf409268b63503f9daf7cf45cd1f680029).
These are references, not adopted consumer pins. The received `production-paused-b3dc429.tar.gz`
has SHA256 `a97e8fcb7c8ef7538fe3a16dd81cd11e89b61bd64f3960af265dff0fb561342b`;
all 46 internal SHA256SUMS entries match. Its proposal hash is
`2fb3c9c63b49ef8c798ec621402f048c04c2953a0c8c0a6fd133543394087bac`.
It contains paused-only offline postconditions and producer CI/provenance-verification records.
This consumer has verified archive/member integrity, not rerun Sigstore or the loader replay.
No production creator grant or launch receipt exists in the packet. Historical blockhashes are
expired; never sign or submit its deployment messages from the consumer.

| Capability | Source contract | Consumer state |
| --- | --- | --- |
| Plain creation | `createLaunchMainnet(..., PRODUCTION_PROGRAMS)`; zero creator fee, no rules/Kit/template/custom-hook accounts | Offline builder/simulation adapter only; no adopted deployment, approved grant or activation |
| Creator authorization | Cumulative lifetime counter, no reset on update; slot must be strictly less than expiry | No live grant asserted; no rolling-day or cap-one requirement inferred |
| Pool creation | Guarded launch-PDA CPI only in production; direct/legacy creation rejected | No legacy/default-ID fallback |
| Swap | Recipient net increase must meet `min_amount_out` | Disabled; no production lifecycle SDK builder or independently verified operation receipt |
| Add/remove liquidity | Both reject trading pause and curve pools; add minimum LP and remove minimum base/quote | Disabled; pause also blocks withdrawal, so do not advertise emergency exit |
| Graduation | First LP belongs to launch PDA; launch has no instruction to move it | No owner withdrawal claim, no graduation button |
| Pauses | Creation and trading are independent; authenticated creation can occur while trading is paused | Observed state unavailable; a requested paused deployment is not evidence of actual pause |
| Authority | No config or launch/swap upgrade timelock; separate hook-code minimum is three days | No quorum, 24-hour delay, immutable custody or recovery claim |
| Kit/full Hooks, bridge | Production plain creation excludes Kit; generic capability flags are profile-dependent | Unsupported; no implied parity or external AMM hook compatibility |

Source evidence: [plain-only runtime](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_launch/src/lib.rs#L80-L110),
[quota/expiry](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_launch/src/controls.rs#L80-L141),
[pool gate](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_swap/src/instructions/pool.rs#L156-L215),
[net output](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_swap/src/instructions/swap.rs#L400-L413),
[liquidity gate](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_swap/src/instructions/liquidity.rs#L103-L111),
[graduation LP](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/programs/bordrless_launch/src/instructions/graduate.rs#L300-L324),
[production SDK opt-in](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/sdk/packages/sdk/src/mainnet-controls.ts#L25-L112),
[profile limitations](https://github.com/new1direction/hook-lab/blob/b3dc4297735fe2e061fca7b6563d69cf81e0911c/deployments/production/profile.json#L47-L62).
Producer additionally confirms generic swap/add/remove, launch swap/graduate, token and bridge SDK
helpers still derive default IDs/PDAs. Never substitute keys in serialized output. Production
lifecycle builders and tests must precede consumer adapters for those operations.

## Local interfaces and trust boundaries

`/coins/production` and `GET /api/hook-lab/production` show unavailable production state, no
adopted identities and all capabilities false. POST returns 423 without consuming a body. There
is no environment or request activation flag. Bounded refusal telemetry contains no raw inputs.

`inspectProductionEvidence` accepts retained dossier JSON plus an independently reviewed SHA256,
two provider observations and the operator's current time. It checks strict schemas, explicit
mainnet genesis, exact source/profile/SDK/IDL/provenance hash fields, two configured provider trust
domains, finalized freshness/slot bounds, complete account inventory, loader/ProgramData PDA,
deployment slot, upgrade authority, full ELF length/hash, full ProgramData hash and zero allocation padding, and exact
config/control/quote/dependency bytes. It supports immutable upgradeable-loader dependencies but
does not assume their ELF matches local source. Unsupported loaders refuse.

The caller must obtain each observation from a trusted RPC adapter, binding provider identity,
genesis, commitment, slot and account bytes from one finalized snapshot per provider. Two caller
labels are not proof of provider independence. Dossier hashes bind retained bytes, not signed
provenance verification. Success is **account-bindings-matched**, never policy or operation
acceptance. Authority semantics, complete transitive dependency selection, config decoding,
pause/creator/economics commitments and signed provenance verification still need the frozen
producer-specific adapter. There is intentionally no public dossier-upload/observation API.

`hooklab-message-boundary.mjs` validates exact canonical v0 bytes, retained ALT snapshots,
resolved privileges, payer/wallet/all signer identities, explicit prefix compute budget,
requested-CU priority fee rounding, fee/native-debit caps, wallet/network/profile/policy drift,
review and blockhash expiry, unsigned simulation binding and every returned Ed25519 signature.
It never builds a Hook Lab instruction or asserts that caller-supplied debit/policy values are
correct. `policyVerified`, `postconditionsVerified`, `canSign` and `canSubmit` remain false.

Receipt reconciliation requires two configured provider identities agreeing on the exact retained
signed transaction, signature, network, message hash, fee and slot. Outcomes distinguish missing
or divergent evidence, pending finality, finalized failure, and finalized transaction only. A
finalized transaction is **not** a verified mint/trade/liquidity result. There is no automatic
retry, blockhash refresh, second mint, expiry cleanup, settlement assertion or write path.
This boundary remains a pure normalized-evidence interface. The separate disabled plain adapter
below adds a read parser and durable candidate journal, not public operation readiness.

## Disabled plain candidate

`vendor/hooklab-production-candidate` is separately namespaced at merged source
[`f3062df`](https://github.com/new1direction/hook-lab/commit/f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32)
(merge tree identical to `b3dc429`). Profile SHA256:
`9df8e9ceaa3a73fb37c8af35254382f27e38bfc35d6a1fcfa4b72223e75e9cb7`.
The reproducible vendoring script pins the source, SDK lock, IDLs and profile, retaining complete
licenses. No active vendor or historic manifest is replaced. Mainnet genesis must use all 32
decoded bytes: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, never its shortened display form.

- `preparePlainReview` strictly rejects extra fields (Kit/custom fee/hooks/direct pools), checks
  the supplied creation pause, grant/quota/exclusive expiry, economics and fees, uses the official
  production opt-in builder, and binds exact v0 bytes/ALT snapshots. Inputs are **offline supplied
  snapshots**, not authenticated chain observations. Governance commitment/provenance/deployment
  trust still requires the producer-specific live adapter before any use with a real wallet.
- `simulatePlainReview` accepts an injected read adapter and simulates the retained unsigned
  message with no blockhash replacement. Tested with synthetic RPC responses; it is not wired to
  an HTTP simulation endpoint. `submitPlainTransaction` always throws 423 before side effects.
- The creator pays instruction rent and program fees; the outer payer separately pays network
  and priority fees. They may be different signers. Creation mints supply, creates a pool and
  deposits the base allocation into a curve; “no initial buy/quote seeding” does not mean “no pool”.
- `readPlainReceipt` fetches the retained signature at finalized commitment and poststate at or
  after its slot. Two providers must agree on exact wire/slot/fee/balances and account bytes.
  Verification covers account IDs/owners/sizes/version/discriminators, plain mint authorities,
  supply/curve allocation, pool fees/vault links, holdings, registry, config/grant counters and
  native rent/debits/treasury credit. Later trading/config changes, pre-funded creation accounts,
  missing history, incompatible layouts or disagreement require review; never reconstruct a new
  launch. Snapshot matches remain `chainVerified:false`: deployment trust is not adopted.
- `plainRecoveryJournal` is an unwired PostgreSQL candidate: immutable owner/mint/message/signature,
  serialized writes and atomic audit, retained raw finalized observations, no expiry/deletion, and
  repeated read-only reconciliation. Latest outage status never deletes the first finalized
  evidence. `pending()` rotates by check time, not a cursor that can skip unknown signatures.
  There is no public write route, live scheduler, production DB connection or automatic send.
- `/coins/production` reuses wallet connection for a public-address-only preparation interaction.
  Explicit mainnet acknowledgement resets on wallet change. Readiness always refuses; review and
  signing buttons remain disabled. No seed phrase/private key field exists. It does not implement
  mint co-signing, encrypted mint backup/export, authenticated wallet binding, or operational
  wallet acceptance; these remain blockers, not completed capabilities.

`firstCreatorPacket()` leaves creator, mint, fee payer, metadata, economics, grant, deadline,
network budget and message unset. Owner draft `first-plain-launch-v1.json`, SHA256
`213c9d0d917f4ff6879b3c4d11fc60495c2a7ec63cfc684ffd29f2d5f01df114`, was checked as artifact-only,
not imported. Its suggested zero-fee/quota-three/expiry/deadline/rent values are proposals, not
live quotes or approved instructions. LiquidityTek remains a future specification, unsupported
by the production plain route; no permanent LP-lock or Hooks parity claim is made.

## Producer contracts required before the next increment

1. Frozen archive digest and signed provenance verification instructions; exact source, profile,
   lockfiles, SDK, IDL, schema/vector versions, feature set and complete executable dependency
   graph. Supply explicit program IDs and ProgramData/ELF bindings, not SDK defaults.
2. Strict decoded config/control/creator/quote account layouts, PDA seeds and commitments; actual
   deployment slots/authority bindings, independent creation/trading pause expectations, lifetime
   quota and exclusive expiry. Name owner/admin, pause-only backup, treasury/collector, independent
   upgrade authority and nonprivileged payer without implying a timelock. Creator remains unset.
3. For creation and each later lifecycle operation: explicit production builder/decoder and
   reconstruction vectors, ordered account privileges, optional/forbidden accounts, resolved ALTs,
   exact fee/rent/input/min-output/CU budget, on-chain versus preflight-only protections, simulation
   postconditions and failure rollback behavior. Creation guards do not automatically protect swaps
   or withdrawals. Do not turn hypothetical reserve arithmetic into a live quote.
4. Raw finalized receipt fixtures and negative vectors, custom-token holdings and pool/LP deltas,
   fee recipients, creator counters, instruction/event version rules, pagination/cursor/backfill
   semantics and provider disagreement handling. Retain original signatures across restart.
5. Separately approved creator grant, operation budgets, deployed-profile adoption, wallet UX,
   live acceptance and execution activation. A paused deployment proposal approves none of these.

## Delivery and rollback boundaries

Migration `0081_hook_lab_plain_recovery.sql` is additive and registered for disposable tests, not
approved for shared application. The unavailable page does not require it or historical `0080`.
Before any deployment, inspect **all** pending migrations (the existing pre-deploy command applies
them), approve the target and encrypted backup/decrypt/disposable restore, check schema compatibility
and journal permissions, then separately authorize shared migration. Do not casually deploy this PR.
Preserve journals/receipts on rollback; never restore stale DB state over accepted chain activity.
Disabling the consumer cannot pause a chain program or reverse minted supply/account rent.

Before activation, separately implement and test drift/unavailability alerts, non-secret receipt
indexing, operator escalation and actual pause procedures. On mismatch stop new execution; observe
existing signatures without regenerating transactions. Web rollback, authority actions and chain
activation require separate approval. Journal health offers unresolved/review-required counts and
oldest unresolved time; no production alert destination or scheduler is installed. The public path
makes no chain calls. Stop future new work on drift, preserve the signed bytes, reconcile from both
providers, and escalate to the owner. Pausing trading also blocks LP withdrawal; re-pause/revoke
must be separately authorized and verified, not represented as an automatic rollback.

Local checks include `node --test tests/hooklab-plain.test.mjs tests/hooklab-plain-journal-db.test.mjs`,
the source-independent/frozen/hardened regression tests, `node scripts/ci/run-quick-tests.mjs`,
`node scripts/ci/run-tests.mjs`, and `npm run build`. PostgreSQL tests use a disposable database on
55432; signatures and account/receipt fixtures are synthetic, not production messages or SBF acceptance.
Browser checks use a synthetic public-address wallet with signing methods that throw.

## Next operational increment: prerequisites and acceptance contract

This is preparation, not an activation switch. Keep `submitPlainTransaction` and public POST
unconditionally refusing throughout the next increment. Do not wire the existing mainnet trader
or generic default-ID Hook Lab builders into this path.

1. **Choose mint custody before building co-sign UX.** The owner draft leaves the mint null and
   recommends a retained producer candidate. Confirm whether its private signer stays external
   (owner returns a signature over the exact reviewed message), or a separately approved new
   client-generated identity is intended. Never import a seed/private key into an API or silently
   regenerate a mint. The current recipe vault creates both mint/config identities, exposes no
   signing/export API and is not a plain-production custody contract. Preserve it unchanged.
   A new client-only vault must retain the mint before review, export authenticated ciphertext
   with its version/public identity/pin binding, and require a successful independent restore
   comparison before co-signing. Test wrong passphrase, swapped public identity, corrupted backup,
   storage failure, cross-tab race, old-backup rollback and wallet/profile change. A browser-only
   journal cannot prove a backup is the newest without a separate trusted checkpoint.
2. **Separate identity authentication from spending consent.** Reuse same-origin/session/rate-limit
   patterns, not `/api/bind`: its signed challenge authorizes repository payouts, not direct coin
   launch recovery. Specify a separate single-use short-lived challenge binding origin, GitHub
   account, creator wallet, full genesis, profile digest and journal operation. Consume it
   atomically with an owner-scoped journal write. Test replay/expiry, other users/wallets/origins,
   stale sessions, body limits and DB failure. A wallet connection alone proves neither control
   nor the on-chain creator grant. Preserve read-only recovery after grant revocation or disconnect.
3. **Review exact bytes before any future signature prompt.** Show decoded production instruction,
   resolved ALTs and all signers, creator rent/program debit versus outer payer fee, metadata,
   supply/curve allocation, grant consumption/expiry/deadline, fee recipients and both pauses.
   Re-read trusted two-provider evidence and exact simulation before review and before signing;
   abort on drift. Retain each partial signature before another prompt and reject changed bytes.
   With a separate outer payer there are three signers, not two. No sign-and-send wallet method,
   automatic blockhash refresh, signature retry or hidden server signer. Test rejecting/reordered
   wallet responses, disconnect mid-prompt, partial signer loss, expiry and storage failure using
   ephemeral local identities only. Real wallet acceptance needs its own approval.
4. **Bind live read adapters and monitoring separately.** Configure two independent provider trust
   domains and the reviewed frozen dossier; check genesis, finalized ProgramData/ELFs/upgrade
   authority, token/quote/dependency bytes, decoded creation/trading governance and creator grant.
   Add provider timeouts, lag/drift/outage alerts and per-signature age/review-required counters.
   Exercise the read adapter/indexer/journal against producer raw successful and failed launch
   receipts, plus history pruning, disagreement, lost response, restart and conflicting finality.
   No such production launch receipt exists yet. Preserve raw first-finalized evidence and original
   signed bytes; a subsequent config change or unavailable snapshot is not permission to relaunch.
5. **Stage adoption without execution.** Approve backup/disposable restore and all pending schema
   changes first; then authorize only deployment observation and recovery display. Verify source,
   IDL, SDK/profile/provenance and actual deployed identity bindings independently. Only later
   approve creator, mint custody, metadata/economics, exact rent/network/priority budget, bounded
   lifetime grant/exclusive expiry, creation deadline, creation unpause and consumer activation.
   Trading can remain paused. On drift, block new preparation and preserve reconciliation; on-chain
   pause/revoke, web rollback and DB restore are distinct authorized actions, not one rollback.

The minimum producer gap is a deployment-bound creation acceptance fixture (raw message, all signer
roles, simulation/account snapshots, finalized receipt, exact rent/fee/debit postconditions and
counter changes). The paused-only package cannot substitute for it. Swaps/liquidity/Kit and
LiquidityTek remain out of this increment.
