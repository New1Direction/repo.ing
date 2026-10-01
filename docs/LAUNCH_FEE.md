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

Mainnet dry run (unsigned simulation against the real program; nothing signed or sent): only the six fee fields differ from `2YbBp7…`; rent 5,974,080 + network fee 10,000 = **5,984,080 lamports (0.00598408 SOL)** paid by the partner wallet.

## Mainnet rollout

Do these in order. Each step is reversible until the config switch has launched a market.

1. **Deploy this code to worker and web** with `DBC_CONFIG` unchanged. It accepts both configs and shows launch-fee copy only for configs that have one. Check quotes, Launch facts and `reconcile:repo` on existing markets.
2. **Review the creation** on the operator Mac (Railway read-only for the RPC, or set `SOLANA_RPC_URL`):
   ```sh
   node scripts/create-launch-fee-config.mjs
   ```
   The first run creates `secrets/launch-fee-config-keypair.json` (ignored by Git, mode 0600). Check `differsFromReferenceOnlyIn` lists only the six fee fields, `feeAtSeconds`, `totalDebitLamports` (5,984,080 expected) and the partner balance. Nothing is sent.
3. **Create the config** after approving the exact address, instruction hash and debit:
   ```sh
   APPROVED_LAUNCH_FEE_CONFIG=<config> APPROVED_LAUNCH_FEE_INSTRUCTION_SHA256=<instructionSha256> \
   APPROVED_LAUNCH_FEE_DEBIT_LAMPORTS=<totalDebitLamports> node scripts/create-launch-fee-config.mjs --execute
   ```
   It loads the partner key from Keychain (`repo.ing.dbc.partner`), runs a signed preflight, waits for finality and verifies the finalized account bytes equal the reviewed simulation. Record the signature here. If the send is ambiguous, inspect the address; never re-run blindly.
4. **Worker first** (Railway service `worker`; it must recognise new-config markets before web can launch one): `DBC_LEGACY_CONFIGS=2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M,261xpZVAz5k3ZfwfxXdgkgLowiH6NUzFEHtihhD4YMq1,D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c` (the two current legacy configs plus `2YbBp7…`) and `DBC_CONFIG=<new config>`. Redeploy; confirm fee cycles are `OK` for every existing market.
5. **Then web** (service `web`): the same `DBC_LEGACY_CONFIGS` and `DBC_CONFIG`, and `BUILDER_ALLOCATION_CONFIGS=2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M,<new config>` (keep `2YbBp7…`: enrolled markets need it to claim their allocation). Redeploy.
6. **Check**: the launch page shows the launch-fee line and "Your initial buy pays the regular 1.75% fee"; `/api/launch` 1/2/Max 3% quotes are unchanged (3% = 856011397 lamports, fee 1.75%); existing markets quote `launchFee: null`, `feeNumerator: "17500000"`; How it works shows the section within 5 minutes; reconciliation stays `MATCH`. Trend candidates approved for the old config need re-approval (`approvedConfig` must equal `DBC_CONFIG`).
7. **First launch on the new config**: confirm on the explorer that the launch transaction's initial buy paid 1.75%, the trade panel showed the launch fee for 3 minutes, and fees indexed and reconcile `MATCH`.
8. **Static docs**: the site copy follows the config by itself, but `README.md` (fee shares), `docs/USER_GUIDE.md` and this page's status line are static. Update them in the same PR that records the config address and creation signature.

**Rollback**: set `DBC_CONFIG` back to `2YbBp7…` on web and worker and keep the new config in `DBC_LEGACY_CONFIGS` (and `BUILDER_ALLOCATION_CONFIGS`) permanently once any market uses it. Never remove an approved config that has markets.

## Risks

- **Organic early buyers pay the launch fee.** A fixed schedule cannot tell people from bots; the rate limiter that could is unavailable. Mitigations: short window, fast decay, live fee and countdown in the trade panel and Blink message. Third-party front ends and aggregators show their own quotes.
- **Sells in the window pay it too**, including a launcher selling their initial buy. That is intended.
- **Program upgrades**: DBC is upgradeable. The guard refuses unknown schedules and the exact launch-buy minimum output makes an unexpected fee revert the launch instead of charging it. Re-run the chain test against a fresh mainnet program dump before future rollouts.
- **Copy freshness**: How it works and `llms.txt` are regenerated (5 minutes / 1 hour) after the switch; launch, token and trade views read the config directly.
