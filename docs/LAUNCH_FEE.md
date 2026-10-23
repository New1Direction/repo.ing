# Launch fee (anti-sniper DBC config)

[Documentation](README.md) / Launch fee

**Status: active since 2026-10-01.** New launches use the launch-fee config `8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3`, created by the partner wallet in transaction `Ygik7j3dyp2PxG192TzamKP2cxV8mgP6mSmw1T9i6PURAP8RzNCsqRwFneP4UZjhXXzRNrC9iwnpmuAPRTF5VwP` (5,984,080 lamports; finalized account owned by the DBC program, 1,048 bytes; only the six fee fields differ from `2YbBp7…`). `DBC_CONFIG` is the new config on web and worker; `2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M` and the two older configs stay in `DBC_LEGACY_CONFIGS` for existing markets, and `BUILDER_ALLOCATION_CONFIGS` lists both `2YbBp7…` and the new config. No market has launched on it yet; step 7 of the [rollout](#mainnet-rollout) applies to the first one.

## Why

Production data: about 27% of all non-$REPOING volume happens in the first 10 minutes after launch. Bots buy in the first block, round-trip into the first organic buyers, curves end near 0 SOL and charts die. A flat 1.75% fee makes that cheap. The launch fee makes buying in a market's first seconds expensive and returns to the normal fee within minutes, while the launcher's own initial buy keeps paying 1.75%.

## Mechanism and parameters

Meteora's DBC **exponential fee scheduler** on timestamp activation (`src/launch-fee.mjs`, `LAUNCH_FEE_SCHEDULE`):

| Parameter | Value |
| --- | --- |
| `baseFeeMode` | `1` (FeeSchedulerExponential) |
| `cliffFeeNumerator` | `504409597` (50.44% at pool activation) |
| `numberOfPeriod` × `periodFrequency` | 180 × 1 s |
| `reductionFactor` | 185 (each second removes 1.85% of the current fee; half-life ≈ 37 s) |
| Fee from 180 s on | `17500000` — exactly 1.75%, for the life of the curve |
| `enableFirstSwapWithMinFee` | `true` — the launcher's first buy pays 1.75% |

| Seconds after launch | 0 | 5 | 10 | 30 | 60 | 90 | 120 | 150 | ≥180 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fee | 50.44% | 45.94% | 41.85% | 28.81% | 16.45% | 9.40% | 5.37% | 3.06% | 1.75% |

The fee is split exactly like the regular fee: Meteora takes 20%, the creator (builders) 71% of the rest, the partner (repo.ing) 29%. A bot that buys at 50% needs the price to roughly double before it breaks even. SDK math on a fresh 85 SOL curve: a 1 SOL buy at launch breaks even only after about 13 SOL of later net buying (about 6 SOL if it waits 30 s, 3.2 SOL at 60 s), against about 0.55 SOL on the flat config. Most launches never see that much buying, and bots that wait are no longer first.

### Why exponential, and why not the alternatives

- **Rate limiter** (fee grows with buy size, so small organic buys stay cheap) would be the best fit, but it is **deprecated**: since DBC 0.2.1 the program rejects it for new configs and new pools (`DeprecatedBaseFeeMode`, error 6078), and SDK 1.5.13 refuses to build it. Verified on both the CI fixture program and the mainnet program bytes (`tests/launch-fee-chain.test.mjs`, `tests/launch-fee.test.mjs`).
- **Linear scheduler**: ending exactly at 1.75% is easy, but the fee stays high for longer (50% → 1.75% over 193 s is still 35% at one minute). It charges organic buyers who arrive from launch alerts (30–120 s after launch) far more for the same deterrent at second 0.
- **Exponential** front-loads the deterrent when bots act and falls quickly for people. Its integer math does not naturally end on 1.75%; the cliff was searched so the program's own `get_fee_in_period(cliff, 185, 180)` is exactly 17,500,000. `launchFeeBaseFee()` refuses any schedule whose minimum is not exactly 17,500,000, and a unit test re-implements the program's Q64 arithmetic for every second.
- **Fee window length**: 3 minutes covers the first-block window with a strong fee and the alert-driven window with a falling one. Longer windows charge organic buyers more; shorter ones let bots wait a few seconds.

Limits (SDK and program): fees 0.25%–99%, `numberOfPeriod` ≤ 65,535, all scheduler factors non-zero; `validateConfigParameters` and the program both accept this config.

## What the launcher's initial buy pays

The launch buy runs in the pool-creation transaction, at the activation point, so an ordinary swap there would pay the full 50.44% (under a linear scheduler too). A delayed activation cannot help: `initialize_virtual_pool` always sets a pool's activation point to its creation time. With `enableFirstSwapWithMinFee`, the DBC program charges the scheduler's **minimum** fee (1.75%) to a swap that (1) is the pool's first swap, (2) is in the same transaction as, and after, that pool's `initialize_virtual_pool` instruction, at top level, (3) has no referral account, and (4) passes the instructions sysvar (the SDK's `createPoolWithFirstBuy` always does). repo.ing launches satisfy all four.

Safeguards:

- `launchBuyQuote` / `launchBuyPreset` quote the launch buy at the minimum fee, so the 1/2/3% presets and the 3% cap are byte-identical to the flat config (Max 3% = 0.856011397 SOL).
- The launch buy's minimum output is the exact quote. If the program ever did not apply the minimum fee, the swap would receive about half the tokens, fail with `ExceededSlippage`, and the whole launch would revert (no pool, no charge). Tested by stripping the sysvar.
- Nobody else can get the minimum fee: it needs the pool's initialize instruction in the same transaction, which needs the fresh mint key and repo.ing's creator co-signature. A bot's swap, even in the same slot, pays the scheduled fee.
- A **No buy** launch has no discounted swap; the first trade by anyone pays the scheduled fee.

## Identical economics

The new config is the `builders` profile with only the base fee replaced (`buildLaunchCurve('launch-fee')`). The creation script decodes the simulated account and compares it with the live `2YbBp7…` account: only `poolFees.baseFee.{cliffFeeNumerator, firstFactor, secondFactor, thirdFactor, baseFeeMode}` and `enableFirstSwapWithMinFee` may differ. Same SOL quote, 1B supply, 6 decimals, immutable authority, 10,001,000-token builder leftover to the creator signer `FeZX15…`, fee claimer `H7TKxm…`, 85 SOL threshold, curve and start price, `creatorTradingFeePercentage` 71, quote-token fee collection, no dynamic fee, no pool creation fee, DAMM v2 with `FixedBps100`, 50/50 permanently locked LP, timestamp activation.

## Application changes

- **Launch guard** (`src/meteora-launch.mjs`): accepts the flat 1.75% configs or exactly `LAUNCH_FEE_SCHEDULE` with the minimum-fee first swap and timestamp activation (`isApprovedLaunchFee`). Anything else is refused.
- **Launch buy quotes** (`src/launch-buy.mjs`, `/api/launch` quote): minimum-fee eligibility from the config.
- **Trade quotes** (`src/canonical-trade.mjs`; site, Blinks and canary share it): quotes at the confirmed chain clock clamped to the pool's activation point. The fee only falls, and the transaction executes at or after that clock, so the executed fee is never above the quote and the 1% minimum is safe. Quotes return `feeNumerator` and `launchFee` (active, current fee, end time); flat markets return `launchFee: null`.
- **Copy**: the trade panel shows the live launch fee and a note while it is active; the Blink buy message names it; the launch form, How it works (revalidated every 5 minutes), `llms.txt` (hourly) and the token page's Launch facts explain the window, only when the active config (or that market's config) has one. Config schedules are read once per process (`app/lib/launch-fee.mjs`).
- **Accounting is fee-rate independent and unchanged**: builder credits are 71% of each swap event's `tradingFee` (the program's own split), partner/discovery amounts are the remainder, reconciliation compares with on-chain `creatorQuoteFee`, platform collection uses on-chain `partnerQuoteFee`. The discoverer's 50% of partner fees includes launch-fee trades, up to the 2.5 SOL cap; self-trading to farm it loses about 88% of the fee paid.
- **Unchanged**: graduation, DAMM migration and graduated fees (DAMM fee comes from `FixedBps100`), launch evidence and indexing, trade evidence, referral (Meteora's protocol share).

## Verification

- `tests/launch-fee.test.mjs` (quick): program-math parity for 0–240 s, limits, config identity, rate-limiter rejection, guard, launch-buy presets/cap, quote clamping and monotonicity, copy, Blink message.
- `tests/launch-fee-chain.test.mjs` (validator + PostgreSQL): creates the config with the builder module, proves rate-limiter rejection, unapproved-schedule rejection and the stripped-sysvar fail-safe, then launches real markets on the new and old configs and checks every fee against the program's charge, indexing, reconciliation, discovery, builder and platform claims, graduation and DAMM migration.

The chain test passed twice: on the CI fixture DBC program (2026-09-30) and on the deployed mainnet DBC program, whose bytes were read with `solana program dump` and loaded into the local validator (2026-10-01; they differ from the CI fixture). Fees charged in the mainnet-program run:

| Trade | Seconds after activation | Fee charged |
| --- | ---: | ---: |
| New config, launcher initial buy 0.1 SOL | 0 | 1,750,000 lamports (1.75%) |
| New config, bot buy 0.1 SOL right after launch | 0 | 50,440,960 (50.44%) |
| New config, app buy 0.2 SOL | 17 | 73,442,678 (36.72%) |
| New config, app sell | 19 | 22,433,767 of 63,416,618 gross (35.38%) |
| New config, app buy 0.3 SOL / sell | 182 / 183 | 5,250,000 / 5,158,125 (1.75%) |
| Old config, launcher buy and immediate buy 0.1 SOL | 0 | 1,750,000 each (1.75%) |

The fixture run charged the same amounts at 0 s and after the window; its in-window trades landed at 18 s and 20 s and paid 36.04% and 34.72%, each exactly the schedule's fee for that second. In both runs builder credits equalled on-chain creator fees and reconciled `MATCH` on both markets before and after claims, graduation, DAMM migration and verification.

Historical mainnet dry run (before the custody incident): only the six fee fields differed from `2YbBp7…`; rent 5,974,080 + network fee 10,000 = **5,984,080 lamports (0.00598408 SOL)** paid by the partner wallet. That review is not authorization to reuse that wallet or config.

On 2026-10-23, the finalized mainnet DBC executable (including allocated trailing bytes), SHA256
`e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47`, was loaded into a disposable local validator with current DAMM v2, Token-2022 and Metaplex binaries. All five curve round-trip tests and all nine launch-fee lifecycle tests passed, including accounting, claims and graduation. These were local transactions, not mainnet acceptance or recovered-multisig collection receipts.

DBC 0.2.2 creates version-1 configs. Its [migration handler](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs#L645-L675) retains the original migration path for SPL/SOL without transfer fees. The custody review now admits only that version-0 → 1 transition, requires the tested executable hash, and requires all 14 SDK `padding0` bytes to remain zero (they contain the newly introduced transfer-fee fields). Token-2022, non-SOL quotes, nonzero reserved fields, other version transitions and changed executables remain rejected. Ordinary comparisons do not gain this exception.

## Mainnet rollout

The pre-incident creation procedure is retired: it loaded an exposed partner key and assigned new rights to exposed recipients. Existing markets keep their historical configs; do not reuse those configs for new launches or restart the general replay worker.

1. **Review one ordinary-launch replacement** using an independently custody-backed fresh config public address and an explicit HTTPS `SOLANA_RPC_URL`:
   ```sh
   node scripts/create-launch-fee-config.mjs --config <public-address>
   ```
   The tool only simulates; it neither creates keys nor signs/sends. Both immutable recipients must be recovered vault `3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs`; payer is the recovered operator. The comparison permits only the six launch-fee fields, `feeClaimer`, `leftoverReceiver` and the narrowly reviewed version transition above. Every other curve, allocation and fee-share field must match the reference. Custody does not decide ultimate beneficiary allocations.
2. **Approve exact creation funding and signing separately.** Review the config signer backup, unsigned instruction hash, simulated account hash, payer debit and vault governance. `--execute` is deliberately unavailable; a separate reviewed one-send signing path must retain the exact message and reconcile any uncertain submission before further action. Historical fee estimates above are not funding approval.
3. **Accept the complete new-launch path before enabling it:** safe creator authority, GitHub identity, token creation, initial buy, trading, graduation, fee indexing, multisig collection and beneficiary attribution. Preserve historical configs for existing markets. Bundles need their own safe router/config acceptance; this ordinary-launch review does not cover them.
4. **Roll out the independently accepted launch path** without changing existing-market recovery guards or enabling archived jobs. Keep claim/payout gates closed until their separate receipt and recipient acceptance passes. Record the finalized config, creation receipt, image and acceptance evidence.

**Rollback:** disable new launches while preserving trading and all configs already used by markets. Never revert new launches to an exposed configuration.

## Risks

- **Organic early buyers pay the launch fee.** A fixed schedule cannot tell people from bots; the rate limiter that could is unavailable. Mitigations: short window, fast decay, live fee and countdown in the trade panel and Blink message. Third-party front ends and aggregators show their own quotes.
- **Sells in the window pay it too**, including a launcher selling their initial buy. That is intended.
- **Program upgrades**: DBC is upgradeable. The guard refuses unknown schedules and the exact launch-buy minimum output makes an unexpected fee revert the launch instead of charging it. Re-run the chain test against a fresh mainnet program dump before future rollouts.
- **Copy freshness**: How it works and `llms.txt` are regenerated (5 minutes / 1 hour) after the switch; launch, token and trade views read the config directly.
