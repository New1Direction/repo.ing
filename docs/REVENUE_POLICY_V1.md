# Revenue policy V1 — 60 / 20 / 20

**Approved and activated on September 26, 2026. Buyback and liquidity execution remain off.**

## Active allocation policy

| Destination | Share of claimed platform revenue | Stored permille |
| --- | ---: | ---: |
| $REPO buyback reserve | 60% | 600 |
| Protocol liquidity reserve | 20% | 200 |
| Treasury | 20% | Remainder, nominally 200 |

This splits eligible, settled platform revenue when the operator allocates it. Buyback and liquidity portions are floored to integer lamports; the treasury receives the rounding remainder so every claim is fully accounted for. Policy activation does not automatically claim fees, allocate them, or spend SOL.

The allocation source is finalized platform-fee claims. DBC collection reserves unpaid discovery rewards before sending the platform remainder to the receiving treasury; existing DAMM claims retain their partner-position collector. DBC gross accrual is informational until collected, and outstanding discovery obligations are never available for platform spending. Builder fees remain separate. See [collection and treasury custody](DBC_PLATFORM_COLLECTION.md). The activation evidence below predates this extension.

The 60% buyback share accumulates as a reserve. The team buys back $REPOING by hand from the published wallets, and the worker records those buys against the reserve ([REPO token](REPO_TOKEN.md)). The in-app executor is still off: it needs its `REPO_BUYBACK_*` settings and an approved venue implementation. A reserve allocation must not be described as a completed buyback.

Keep sufficient operating funds before discretionary deployments. Hosting/RPC expenses and signer network/account costs must be considered in that check. No numerical operating-runway floor was approved in this change. A later split requires an explicit V2 policy; existing allocations keep their original policy and are not silently reassigned.

Review V1 after the first verified LP deployment and approximately one month of actual revenue and cost data. Measure pool buy/sell price impact at consistent trade sizes, finalized platform earnings and claims, actual deployed amounts, account/network costs, and operating runway. There is no automated spending or scheduled review created by this activation.

## Production evidence

- Operator approved the exact 60/20/20 split in the project conversation. The configured operator is GitHub ID `285551516` (`New1Direction`).
- The deployed `createPolicy` and `activatePolicy` service methods ran through authenticated Railway administration, inside one database transaction under the revenue advisory lock. The operation refused any conflicting existing policy. No signer was loaded.
- Stored policy: version **1**, buyback **600**, liquidity **200**, `created_by=285551516`; activated at **2026-09-26T20:55:58.002Z**.
- Platform revenue and liquidity reconciliation both returned **MATCH**. Claimed, available, allocated, reserved, and spent amounts were all **0 lamports**. No intent was created or transaction signed.
- Both execution flags remained false. No application code, migration, or deployment was needed.
- A separate finalized mainnet read at **2026-09-26T20:56:29.319Z** checked all **16 indexed markets** then present: none had migrated to DAMM. There is consequently no candidate for the first live LP deployment yet. This observation is not a continuing monitor.
- Partner wallet balance at that read: **0.047042760 SOL**. This is an operating-wallet balance, not eligible claimed revenue or a liquidity allocation.

## First-deployment envelope — locked September 26, 2026

The operator approved **at most 0.05 SOL investment plus at most 0.012 SOL account/network overhead**, one manually selected and reviewed intent, preflight simulation, exact wallet/token/LP verification, replay protection, and final `MATCH`. A smaller reviewed investment is permitted. Execution stays off until graduation and sufficient claimed, allocated platform revenue exist.

The [first-live runbook](P3_FIRST_LIVE_RUNBOOK.md) is the operational source of truth for the complete rules, manual API sequence, stop/recovery procedure, evidence, and P4 gate. Its [settings manifest](P3_FIRST_LIVE_SETTINGS.json) retains conservative 1% slippage, 0.5% spot impact, 25 SOL recorded DBC volume, a 100 SOL pool threshold, and rules version 1. It is not an automatic spending policy.

A full 0.05 SOL allocation needs at least **0.25 SOL of eligible claimed revenue** at the approved 20% share plus separate operating funds. The actual pool, amount, quote and minimum LP output must still be reviewed. These additional positions are platform-owned and withdrawable. [P4: Builder Reinvest](BUILDER_REINVEST_PLAN.md) preparation is implemented behind a disabled gate. Its production activation requires the first real P3 LP receipt and wallet/vault/position checks to pass and reconciliation to return `MATCH`.
