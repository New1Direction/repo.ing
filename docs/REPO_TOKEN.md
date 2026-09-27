# $REPO and platform revenue

[Documentation](README.md) / $REPO

**Status checked September 26, 2026:** the revenue policy is active. Buyback execution is off, and no canonical `REPO_TOKEN_MINT` is configured in the inspected production release. The ordinary self-launch design is accepted; the official mint and launch timing remain pending.

This guide describes implemented controls and the approved policy. It does not announce a token launch.

**Accepted design:** [$REPO as the ordinary market for the repo.ing repository](REPO_SELF_LAUNCH_REVIEW.md), inheriting the current 1 billion supply, 1% builder allocation and normal discovery/fee rules. Verified addresses will be recorded in [Official identity](REPO_IDENTITY.md). Accepting the design does not sign a transaction or enable spending. The revenue policy below is unchanged.

## Repository-market identity and protocol designation

| | Repository markets | $REPO |
| --- | --- | --- |
| Purpose | A canonical market associated with a public GitHub repository | Accepted design: the ordinary market for `New1Direction/repo.ing`, also designated as the protocol token |
| Identity | GitHub repository ID, canonical mint, and pool | Official mint still to be published and configured |
| Supply | Current launch profile: 1 billion tokens, six decimals | Would inherit that profile through the ordinary launch route; no mint exists in the checked canonical record |
| Builder allocation | 1% for new enrolled repository markets, after verified graduation | Would apply normally, becoming an operator-related allocation for the self repository |

A ticker does not establish the official $REPO identity. Verify the actual finalized canonical market before publishing/configuring its mint. This document gives no token equity, redemption, governance, staking, or revenue-distribution rights.

## Active V1 policy: 60 / 20 / 20

```mermaid
flowchart LR
    A["Eligible settled platform fee claim"] --> B["Reviewed allocation"]
    B --> C["60% · $REPO buyback reserve"]
    B --> D["20% · protocol liquidity reserve"]
    B --> E["20% · treasury"]
```

The immutable active policy is **600 / 200 / 200 permilles**. Allocations use integer lamports, with rounding remainder retained in treasury. Each settled claim can be allocated once.

**Allocatable funds are settled platform-fee claims.** The DBC collector first reserves every unpaid discovery entitlement, then sends only the platform remainder to the receiving treasury. DAMM claims retain their existing partner-position path. Unclaimed accrual is never spendable. Builder fees are excluded. [Collection, custody and execution gates](DBC_PLATFORM_COLLECTION.md).

If $REPO launches as an ordinary canonical market, its own eligible partner-fee claims are included too: the allocator has no self-market exclusion. Its builder earnings remain outside this policy even when their recipient also operates repo.ing.

A reserve records an allocation. It does not mean a trade has executed, tokens have been purchased, or tokens have been burned.

## Buyback activation boundary

Already implemented:

- platform revenue accounting and reconciliation;
- immutable policy versions and claim-linked allocations;
- bounded, expiring intents, operator review, and idempotency checks;
- a disabled execution gate with required mint, destination, venue, and size/slippage settings.

Still required before any buyback:

1. Publish and verify the canonical $REPO mint and approved token launch details.
2. Implement and review the trading route; the present executor deliberately rejects execution because no approved venue implementation exists.
3. Bind the real quote, expected output, minimum received, destination account, spending limits, and expiry to the reviewed intent.
4. Prove durable submission, recovery, exact settlement, and replay protection in local tests.
5. Configure and explicitly activate a bounded production attempt only when eligible claimed revenue is available.
6. Verify the receipt and reconcile non-zero spend to `MATCH`.

Setting an environment flag alone cannot complete those steps. **No burn mechanism is implemented or activated.** Purchased-token custody and any later burn policy require a separate explicit decision; this release makes neither a burn promise nor a purchase schedule.

## Liquidity and reinvestment gates

- **P3:** first deployment must be manually reviewed and executed, with at most **0.05 SOL investment + 0.012 SOL account/network overhead**. A verified graduated pool, settled allocated platform revenue, simulation, exact wallet/token/LP deltas, and final `MATCH` are required. There is no automatic market selection or spending.
- **P4:** builder reinvestment stays disabled until P3 completes one verified non-zero mainnet deployment. The builder must receive claimed SOL in their wallet first, then separately approve a same-repository pool investment. Cancellation leaves the claimed SOL in the wallet; the resulting LP position belongs to the builder.

The original 50/50 migrated positions are permanently locked. Later P3 positions are platform-controlled and are not permanently locked; later P4 positions belong to the builder. These positions must not be described as having identical custody or lock terms.

## Public transparency

[Protocol analytics](https://repo.ing/stats) reports verified indexed activity, settled builder payouts, and reconciled revenue reserves. Its current buyback status is **Awaiting activation**. USD figures are current-price estimates; accounting remains in SOL lamports.

For exact implementation and operator steps, read [platform revenue](PLATFORM_REVENUE.md), [active policy](REVENUE_POLICY_V1.md), [first P3 deployment](P3_FIRST_LIVE_RUNBOOK.md), and [P4 preparation](BUILDER_REINVEST_PLAN.md).
