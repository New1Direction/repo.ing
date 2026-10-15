# Production consumer boundary — local, inert preparation

No active production dossier, vendor update, wallet execution, RPC indexer, journal write or
migration is introduced by this increment. Frozen `f3c57ccc` HLTEST and the separate `826b5a4`
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
| Plain creation | `createLaunchMainnet(..., PRODUCTION_PROGRAMS)`; zero creator fee, no rules/Kit/template/custom-hook accounts | Disabled: no adopted SDK, approved creator grant, deployment or activation |
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
This is a pure normalized-evidence interface, not a live RPC receipt parser or durable indexer.

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

No new migration, shared DB access or journal integration is needed for this unavailable observer.
Do not apply historical candidate migration `0080` for this page. Future durable execution recovery
needs an approved journal design and current encrypted backup/decrypt/disposable-restore verification
before any shared migration; preserve existing journals and receipts on rollback. Never restore a
stale DB over accepted chain activity. Disabling the consumer cannot pause a chain program.

Before activation, separately implement and test drift/unavailability alerts, non-secret receipt
indexing, operator escalation and actual pause procedures. On mismatch stop new execution; observe
existing signatures without regenerating transactions. Web rollback, authority actions and chain
activation require separate approval. This increment makes no network calls or production claims.

Local checks: `node --test tests/hooklab-message-boundary.test.mjs tests/hooklab-production-observer.test.mjs`,
the existing frozen/hardened regression tests, `node scripts/ci/run-quick-tests.mjs`, and `npm run build`.
Fixtures use fabricated account bytes and disposable offline signatures, not production messages.
