# Liquidity configuration review — 2026-09-25

## Status

**Activated on mainnet for future launches after operator approval.** New config `261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1` was created for exactly 0.00598408 SOL in transaction `44tUbqYdjhdkbSTs3VNqEZviy1hkFQCW23m2is4RA39HHQ5Reej7tKpztE7ypmP4SuyRcTeng6mdEBMvdBLHSTK6`. The entire finalized account matched the reviewed SHA-256. New curve activation affects future launches only; existing canonical mints and pools retain their original economics.

## What Pump does and what repo.ing can adopt

Pump's [official program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md) describes constant-product pricing using virtual reserves, beginning with zero real SOL reserves. Its documented parameter example has 30 virtual SOL and 1.073 billion virtual tokens. This is a documented example, not a live read of Pump's global configuration or current fee schedule. Actual buys add real SOL; sells remove it. Graduation moves accumulated liquidity into PumpSwap and burns LP tokens.

Meteora [DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc) supports the same broad lifecycle through virtual pricing followed by a DAMM pool. Virtual reserves set prices; they are not deposited SOL or guaranteed exit capital. Raising the spot market cap without changing executable depth is insufficient.

## Reproducible comparison

Run `node scripts/compare-launch-curves.mjs`. This uses installed SDK 1.5.13 integer quotes without network access. All quotes begin at an otherwise empty fresh pool. Impact is average execution price versus starting spot, excluding the fixed 1.75% trading fee. Market cap is fully diluted spot valuation, not cash in the pool. Percentages differ from the previous live-market check because those pools already had trades.

| Profile | Starting FDV | 0.1 SOL buy impact | 1 SOL buy impact | 5 SOL buy impact | Maximum 3% launch buy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing curve | 1.0000 SOL | 6.2798% | 93.6157% | 486.1535% | 0.031010262 SOL |
| 85 SOL graduation | 26.5626 SOL | 0.3467% | 3.4676% | 17.3382% | 0.834542274 SOL |
| 170 SOL graduation | 53.1251 SOL | 0.1733% | 1.7338% | 8.6691% | 1.669084534 SOL |
| 340 SOL graduation | 106.2503 SOL | 0.0866% | 0.8669% | 4.3345% | 3.338169049 SOL |

### Recommended: 85 SOL graduation

- Uses Meteora's supported single-segment `buildCurve`, reserving approximately 20% of supply for migration. The SDK adds a rounding segment when necessary.
- One billion tokens; six decimals; immutable mint configuration; 1,000 leftover tokens retained as in the existing configuration.
- Initial pricing has approximately 28.33 virtual SOL. The real SOL reserve begins at zero.
- A 1 SOL first buy receives about 3.5749% of supply; the old curve quotes 50.7448%. A custom first buy above 3% remains rejected. Ordinary later purchases are not capped.
- The optional Max 3% launch purchase costs 0.834542274 SOL before launch deposits/network fees; No buy remains the default.
- Graduates at 85 SOL of actual quote reserve, rather than roughly 29.95 SOL. Net buys must build this reserve; sells move progress backward. With no sells, the fee-inclusive swap input needed is approximately 86.514 SOL, excluding setup and network costs. The operator does not deposit 85 SOL to create the config.
- Creator/platform/protocol DBC shares, discovery reward limits, 1.75% fixed fee, and 50/50 permanently locked migrated liquidity remain unchanged.
- A fresh 5 SOL trade still has roughly 17.34% impact. This is an improvement for early 0.1–1 SOL trading, not a claim of institutional-size depth. The 170/340 SOL options reduce impact further but require correspondingly more demand to graduate.
- A controlled buy/full-sell cycle at unchanged external conditions returns about 96.53% of the original SOL after both trading fees, excluding network/account costs. It does not prove profitable exits after other traders act.

## Local chain evidence

Four curve profiles each passed actual 0.1, 1, and 5 SOL buys followed by full token sells. The chain delivered the exact SDK buy output and accepted the quoted minimum sell output. Real quote reserves returned to integer dust; no tokens were left in the test wallet. The existing and recommended profiles also passed atomic launch, 1/2/3% allocation boundaries, one-lamport over-cap rejection, exact simulated wallet debit, and finalized first chart event.

The recommended configuration passed migration, creator ownership, 50/50 permanent LP locks, remaining DBC fee withdrawal, a DAMM buy, and a DAMM builder payout:

- Local config: `4gRZ5pFhiYiBz4Qvk3WxpesLvTzpw5tcw829DLsSeQEz`.
- Local DBC pool: `5eAN7qDUM469MDh8i6q878QELeMkwHiwmAdEr5tdZXhd`.
- Local DAMM pool: `C2xFtEoAgsraWiKV9yGyC1oUZYPKvK6wkDnq2bP5XfU`.
- Migration signature: `25rmGQWtCz685LUTE67sbTe2kAqvQAfUeYJzu2T4CXaUxxRmomxtSwjWmAMQVLpmNP5x6fD6aZqe9yDbWQNd9gHJ`.
- DAMM builder payout signature: `2rMeGX4D87zMrHAfMddCbfgrdwWsY2q3QR5WxyLMogqSuBVQtv6PiC26sXL92QNfWwcezAJtjnDfg92vZdqttQH8`.
- DAMM builder fee paid: `399999` lamports, plus separately accounted temporary-account rent refund.
- Both positions had zero unlocked liquidity in this rehearsal.

These are local-validator receipts, not mainnet transactions. The local fixture funds the DBC pool authority for migration account costs. Mainnet migration readiness needs an independent check.

## Safe coexistence of old and new markets

`DBC_CONFIG` continues to select the config for new launches. `DBC_LEGACY_CONFIGS` is an optional comma-separated allowlist of previously approved configs. Every market resolves its config by deriving the canonical DBC pool from the mint and an approved config. Unknown config/pool combinations fail closed. Pool account state and finalized transaction evidence are still checked separately.

A local integration run verified one legacy and one new-profile canonical market through buys, sells, launch indexing, fee/chart indexing, indexer restart, builder payouts, empty-repeat rejection, and reconciliation (`MATCH` for both). Removing the legacy allowlist entry rejected the old pool as expected.

The resolver covers trading, launch indexing, builder fee accrual and claims, reconciliation, discovery claims, chart recording, and bonding/graduation status. No database migration, canonical mint replacement, or user-controlled config selection is introduced.

Rollout after financial approval:

1. Re-run the unsigned config review; compare instruction hash and exact payer debit.
2. Create the config only with explicit approval of the address, instruction hash, and spend. Verify its finalized account against the reviewed curve, fees, authorities, and lock allocation.
3. Deploy the compatibility code to both web and worker before changing `DBC_CONFIG`.
4. Keep the current config in `DBC_LEGACY_CONFIGS` on both services, then select the new config for future launches. Retain old allowlist entries permanently while any corresponding market exists. The worker must recognize both before web starts creating new pools.
5. Verify read-only quotes, fee reconciliation, discovery state, and worker cursors for old markets. Rehearse a new launch only with the user's separate wallet authorization.
6. Rolling back launch selection must retain both configs in the approved set. Never remove a config already used by a canonical market.

## Verification results

- Curve/atomic first-buy/config selection run: 7 passed.
- Claim security and mixed-config integration: 10 passed.
- Discovery authorization, immutable offers, lost-broadcast recovery, one settlement, repeat rejection, and post-graduation earned rewards: 7 passed. Offers were prepared using a new active config while the reward market retained its approved legacy config.
- Fee-event version, launch-cost, and config resolver unit checks: 5 passed (the resolver test is also in the first run).
- Production build and `git diff --check` passed.
- The initial discovery run refused the wrong local database name/port before any test actions. It was rerun successfully against its required isolated `discovery_test` database; no test guard was relaxed.

Reproduce curve and allocation checks with `SOLANA_RPC_URL=http://127.0.0.1:8909 node --test tests/launch-curve.test.mjs tests/launch-first-buy.test.mjs tests/market-config.test.mjs` after starting the documented local Meteora fixtures. Mixed-config and claim tests additionally need a migrated disposable Postgres database; the discovery suite requires its dedicated local database URL. Migration rehearsal: `SOLANA_RPC_URL=http://127.0.0.1:8909 SPIKE_MIGRATE=1 SPIKE_CURVE_PROFILE=balanced SPIKE_BASE_FEE_BPS=175 SPIKE_CREATOR_PERCENT=71 node scripts/meteora-spike.mjs`.

## Exact mainnet transaction prepared for review

- Config: `261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1`.
- Payer and partner fee authority: `H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3`.
- Instruction SHA-256: `ddb5b27462c79a1ed4fd34e2f09761a59785dc0a4e19993dfbf39cc62943f0e2`.
- One Meteora `createConfig` instruction; no token launch, swap, fund transfer to a user, or service setting change.
- Unsigned mainnet simulation passed. The finalized account is required to match the entire simulated config account data hash: `d4d3f89284f334aac072195a242b55a8948877c29499a0d9be7f71a0419dd1d1`.
- Account rent: `5974080` lamports.
- Network fee: `10000` lamports.
- Total payer debit: **0.00598408 SOL**.
- Payer balance at review: `9010920` lamports; expected remaining: `3026840` lamports.

Reproduce with `node scripts/prepare-liquidity-config.mjs`. The config creation key is stored only in ignored `secrets/liquidity-config-keypair.json` with mode 0600 and excluded from Railway uploads. It is not a funded trading wallet. The partner secret is not loaded for unsigned review. `--send` requires the exact approved address/hash/debit environment values and loads the existing protected partner signer only after validation. A completed or ambiguous config creation must be inspected rather than blindly retried.

## Remaining work and existing markets

The production integration now includes finalized DAMM SOL fee evidence, cumulative earnings, current GitHub authority and bound-recipient payouts, and durable signed-intent recovery. The actual migration fee config collects only SOL; other asset modes fail closed. See [graduated builder fees](GRADUATED_FEES.md) for implementation, local chain proofs, concurrency/recovery tests, and deployment evidence. Native post-graduation execution is still via the verified Meteora link. No mainnet graduation has been forced.

Existing markets cannot be made deeper by changing the config selected for new launches. Preserve their canonical mints, let real demand build their reserves, and keep executable price impact visible. A separately funded AMM would need actual SOL plus token inventory, owner-authorized deposits, routing and fee-accounting work; it is not part of this change. No treasury market buys, volume incentives, or liquidity commitments have been made.

## Live release checks and quote reliability follow-up

Both compatibility deployments succeeded. Homepage, builders, stats, and all three checked bonding endpoints returned 200. Unauthenticated builder data remained 401/private/no-store. Old pools still reported the original 29.954748784 SOL threshold. The worker resumed 13 indexed pools with no fee errors, duplicate credits, or pending discovery recoveries. One unindexed launch (`1382497250`) remained unavailable; the same entry appeared in the previous deployment's final cycles. It predates this rollout and was not rewritten.

One live sell quote failed because the SDK requested `getBlockTime` for a recent slot that RPC did not have available. `src/chain-clock.mjs` now reads the confirmed Clock sysvar directly, validates owner and length, and decodes slot/timestamp with integer precision. This uses the same chain time source as the program and removes the extra block-time lookup; it does not fall back to browser/server wall time. The [official Clock layout](https://docs.rs/solana-clock/latest/solana_clock/struct.Clock.html) defines the five 64-bit fields. Two regression tests passed, including a provider whose block-time lookup always fails, exact u64 slot handling, and missing/malformed data rejection. The new path quoted positive buy/sell outputs for Ohiyo, OntologyEX, and SKILLS against read-only mainnet state. No trades were submitted.


The clock fix shipped in commit `c378c3f`, web deployment `80142535-42f1-47ca-af6c-9e36bf594e0e` (`SUCCESS`). After deployment, all **12/12 live quote checks** passed: two rounds of buy and sell quotes for Ohiyo, OntologyEX, and SKILLS returned HTTP 200 with positive minimum output. The worker remains on the successful compatibility deployment above. The disposable validator and Postgres data were stopped and removed after verification. At that earlier checkpoint no mainnet transaction or activation had occurred. The subsequent approved creation is recorded above.

## Approved creation and activation — 2026-09-25

The operator explicitly approved rollout and signing the reviewed creation. Transaction [44tUbqY…BLHSTK6](https://explorer.solana.com/tx/44tUbqYdjhdkbSTs3VNqEZviy1hkFQCW23m2is4RA39HHQ5Reej7tKpztE7ypmP4SuyRcTeng6mdEBMvdBLHSTK6) finalized successfully. The entire account matched the reviewed data hash, and the post-creation partner balance was `3026840` lamports, confirming the exact `5984080` lamport debit. No new market, swap, mainnet graduation, or builder payout was authorized or sent by this rollout.

The graduated-fee integration shipped in commit `596a021`. Additive migration `0010` is applied. Worker `2e9b9476-a1c0-4e43-81db-e3b7a6c47bc5` is successful; it recognizes both configs and all 13 indexed mainnet markets reconcile `MATCH`. Web deployment `124f65c0-2e90-4550-b39f-23e0de897872` succeeded. Both running services report primary config `261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1`, the old config in `DBC_LEGACY_CONFIGS`, and an 85 SOL threshold for new launches.

Final live checks passed:

- Homepage, builder dashboard, stats, and OHIYO claim page: HTTP 200. Unauthenticated builder data: HTTP 401.
- No-buy quote: zero. Optional 1% / 2% / Max 3% inputs: `272915503` / `551045956` / `834542274` lamports. One lamport above the 3% boundary is rejected with HTTP 400.
- All six live buy/sell quotes for OHIYO, OntologyEX, and SKILLS returned HTTP 200 and positive minimum output. These old pools retain their original `29954748784` lamport graduation threshold.
- Web and worker each reconciled all 13 indexed canonical markets as `MATCH`; no pending creator payouts or graduated fee credits existed at the check.
- Two worker cycles each reported 13 fee results, zero fee errors, zero duplicate/new fee credits, and no pending creator/discovery recoveries. The pre-existing unavailable unindexed launch `1382497250` remains unchanged.
- The disposable local validator and PostgreSQL were stopped and their data removed, recovering about 1.7 GB. Public test/verification logs remain in `/tmp/repo-ing-graduation-*`.

First mainnet graduation and a mainnet payout from a graduated pool remain unobserved. The local integration verifies the implementation, including a trade arriving between payout review and broadcast; it does not substitute for those future mainnet receipts.
