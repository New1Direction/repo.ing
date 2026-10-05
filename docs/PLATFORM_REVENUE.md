# Platform revenue and buyback readiness — 2026-09-26

[Documentation](README.md) / Buyback-ready control plane

**Status: deployed with execution disabled. No canonical $REPO mint is configured in the checked production release, and no buyback can execute.** Builder and repository earnings are never part of this system; it only accounts for revenue repo.ing owns.

**Status update, 2026-09-30:** the canonical $REPOING mint now exists (`59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be`; see [Official identity](REPO_IDENTITY.md)). The in-app executor described below is still disabled. Buybacks are made manually by the team: `scripts/platform-sweep.mjs` claims, allocates, and moves the owed buyback share to the custody wallet, the swap is made from that wallet (or the team wallet, on top of the policy), and the worker (`src/buyback-receipts-job.mjs`) detects and publishes the receipt. Every buyback, the running total, and the policy standing are on [Stats](https://repo.ing/stats). [Current $REPOING operations →](REPO_TOKEN.md)

**Policy update, 2026-09-26:** [V1 is approved and active](REVENUE_POLICY_V1.md): **60% buyback reserve / 20% protocol liquidity / 20% treasury**. Allocation and execution remain operator-triggered; no claimed platform fees were available at activation.

## Canonical ledger (P2.1)

The `platform_revenue` view unifies both owned revenue streams with source evidence:

- **DBC phase:** the platform's trading-fee share on curve trades, sourced from `discovery_fee_events.partner_amount` (indexed finalized swap evidence).
- **DAMM phase:** the partner permanently locked LP position's post-graduation fees, sourced from `platform_fee_events` (finalized account checkpoints; see [graduated fees](GRADUATED_FEES.md)).

Every summary answers: gross earned per phase, claimed (settled into the recorded receiving wallet), available (settled claims not yet allocated), allocated, spent, and remaining buyback reserve. Only **claimed** revenue may be allocated. The allocation path reads settled `platform_fee_claims`, separated into DBC and DAMM phases. DBC gross includes discovery obligations, which are reserved before collection and excluded from the platform payout. Unclaimed accrual is never spendable. [Collection and receiving treasury](DBC_PLATFORM_COLLECTION.md). See [$REPO readiness](REPO_TOKEN.md).

## Versioned policy (P2.2)

`platform_revenue_policies` rows are immutable once activated. A policy splits claimed revenue into buyback / liquidity / treasury at integer permilles (buyback + liquidity ≤ 1000, remainder is treasury). The active policy is the most recently activated; drafts never apply. Every allocation row records the policy version that produced it. Policies are created and activated through reviewed operator actions. The GitHub session must belong to an immutable user ID in `PLATFORM_OPERATOR_GITHUB_IDS`; ordinary builder access is insufficient.

## Allocation and reserve (P2.3)

Each allocation consumes settled platform fee claims under the advisory lock. A unique index on `claim_signature` makes double allocation structurally impossible; parts always sum to the whole claim (check constraint). The buyback reserve equals buyback allocations minus settled buyback intents and published buyback receipts (the custody and fee wallets, and team-wallet buys from 2026-09-29 23:00 UTC); buying beyond it is reported as "ahead".

## Intent state machine (P2.4–P2.5)

`prepared → reviewed → simulated → (execution, gated)`, with `aborted` as the terminal failure state. Intents carry idempotency keys, the allocation group and policy version, the exact amount, source wallet, token-specific fields (null until $REPO exists), slippage/impact bounds, and expiry. Reviews pin the exact amount before any state transition; the dry run validates policy-version currency, reserve coverage, and the execution gate without broadcasting.

Execution requires `REPO_BUYBACK_EXECUTION_ENABLED=true` **plus** a complete, consistent configuration: canonical mint, treasury token account, approved venue, slippage and impact bounds, and min/max size bounds (see `.env.example`). Anything missing or malformed stops execution with an explicit error — no fallbacks. Even with the full gate, no venue implementation exists yet, so execution is impossible by construction until one is reviewed and deployed.

## Manual buyback import (2026-09-28, revised 2026-10-05)

A buyback the operator made by hand, and that the worker's own detection missed, is recorded into the same settled-intent ledger through `intent.import` on the reviewed platform-revenue API (UI: `/operations/fees`). The finalized transaction is the authority, and it is read and judged exactly as the worker does it (`loadFinalizedTransaction`, then `detectBuyback` in `src/buyback-detection.mjs`): a successful buy of $REPOING through its own pool, paid by the custody wallet, since 2026-09-27 21:00 UTC (`BUYBACK_SINCE`; the launch and early buys before it are not buybacks). Legacy, v0 and v1 transactions are all read, before the ledger lock is taken. A purchase split over several of the wallet's token accounts is refused: no single account received it.

- **Amount:** the swap input, as on a published receipt. The network fee, a tip and rent for a new account are not buyback spend.
- **Bound:** a spend larger than the allocation's remaining buyback share is refused.
- **Once:** the settled intent's `idempotency_key` is `import.` plus the first 56 characters of the signature. A signature that is already recorded is refused as such, and one the worker also published is counted once.
- **Reconciliation:** imported intents are excluded from the execution-gate check, because the gate bounds protocol-initiated buybacks, not operator swaps already proven on-chain. Reserve coverage and spend totals include them.

From commit `1aa5989` (2026-09-28) until 2026-10-05 the route behind this action had lost its imports, so every request failed and no import was recorded. `tests/platform-revenue-route.test.mjs`, `tests/buyback-import.test.mjs` and `tests/buyback-import-db.test.mjs` (real PostgreSQL) now cover the operator's own path, and the route logs `platform_revenue_failed` with the kind of any failure it answers in general words.

## Verification

`tests/platform-revenue.test.mjs` (2 tests) proves the definition of done end to end on the local validator: both revenue phases accrue into the ledger → unclaimed revenue is unspendable → platform claim settles → policy versioning with immutable activation → exact 600/200/200 split (floor buyback and liquidity, treasury remainder) → double allocation rejected by the claim-unique index → overspend, duplicate idempotency key, review-amount mismatch, wrong-state transitions, expired reviews, and policy-version drift all rejected → dry run completes with the gate recorded as absent → execution rejected while $REPO configuration is missing → reconciliation `MATCH` with zero spend. The gate itself is unit-tested against partial and malformed configuration.

Regression sweep after this change: platform-fees 1/1, claim 9/9, reconcile 5/5, discovery-rules 3/3, production build clean.

## Rollout

Migration `0013_platform_revenue_buyback` applied before web deployment `d7b72f3d-9ca5-4f8e-8042-700404bbb652`; that release did not change the worker. The subsequent [protocol liquidity](PROTOCOL_LIQUIDITY.md) release restricts all treasury endpoints to configured operators (401 unauthenticated; 403 for other builders). The approved V1 policy was activated separately at `2026-09-26T20:55:58.002Z`, with execution still disabled.

## Remaining steps once the canonical $REPO mint exists

1. Use active policy V1 (600/200/200), or explicitly approve a new version if the allocation is to change.
2. Set the full execution gate on Railway web: `REPO_BUYBACK_EXECUTION_ENABLED`, `REPO_TOKEN_MINT`, `REPO_TREASURY_TOKEN_ACCOUNT`, `REPO_BUYBACK_VENUE`, `REPO_BUYBACK_MAX_SLIPPAGE_BPS`, `REPO_BUYBACK_MAX_PRICE_IMPACT_BPS`, `REPO_BUYBACK_MIN_SIZE_LAMPORTS`, `REPO_BUYBACK_MAX_SIZE_LAMPORTS`.
3. Implement and review the venue route against the approved router; bind real quotes (identifier, expected output, minimum output) into reviewed intents.
4. Extend the executor with a durable signed transaction, settlement verification (destination token-account delta and venue receipt), and recovery identical to the platform-fee claim path.
5. Observe the first live buyback and reconcile `MATCH` with non-zero spend.
