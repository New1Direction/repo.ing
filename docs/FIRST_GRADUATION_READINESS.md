# P5 — First Graduation Readiness

[Documentation](README.md) / [First-live runbook](FIRST_GRADUATION_RUNBOOK.md)

## Scope and data source

P5 adds graduation observation, proof, operations and public status to the existing accrue/reconcile path. It adds no economic policy, wallet signer, trading automation, market-selection scheduler or spending action. P3 and P4 remain disabled.

`src/graduation-state.mjs` reads the canonical market's finalized DBC `virtualPool.poolState.quoteReserve` and its actual approved `poolConfig.migrationQuoteThreshold`. Config/PDA/mint/creator/program ownership and SOL quote mint must match. Mainnet checks use Helius plus the independent `GRADUATION_VERIFICATION_RPC_URL`; both must agree on network and account bytes. Production uses PublicNode’s [published Solana endpoint](https://solana.publicnode.com/) for verification after Solana’s shared public endpoint returned rate limits. A production-host read-only probe matched all 16 pool/config snapshots and a historical finalized receipt across Helius and PublicNode without errors. Progress uses integer lamports, remaining is clamped at zero, and the displayed percentage is floored to two decimals. The ranking compares exact fractions, so rounded percentage ties do not obscure the closest market.

Object-property order is normalized when comparing or hashing RPC proof. Transaction versions, signatures, balances, instruction order and account indices still must match exactly.

There is no guessed universal threshold. The read-only production check on September 26, 2026 verified all 16 indexed markets: legacy targets are **29.954748784 SOL**, newer targets **85 SOL**. None had graduated. Repository `90916769` was closest at **0.274992623 / 85 SOL (0.32%)** at that observation.

`graduation_observations` is a replaceable indexed projection of the last dual-provider proof, not a second accounting ledger. Either its wall-clock observation or finalized chain timestamp older than 120 seconds invalidates it. Both public and operator reads reject stale/review states. Public fetches use `no-store`, poll every 15 seconds while visible, and expire the displayed proof independently. RPC failures clear progress rather than preserving an old estimate. Existing trading still requires its own fresh server-side quote and transaction checks.

## Public UI

Each indexed market has a minimal Graduation Progress card: current / target SOL, progress bar, remaining SOL, percentage, and `CURVE` or `GRADUATED`. A target reached before migration proof remains `CURVE`, with a waiting message.

After proof, the card shows a graduated badge, the actual DAMM SOL-side pool balance (explicitly labelled, not presented as combined USD TVL), actual 24-hour DAMM swap volume and a verified Meteora link. Builder fees are hidden while fee reconciliation needs review. Protocol liquidity added is absent until a settled mainnet P3 position has been reverified on both providers and accounting matches. Native price charts remain explicitly DBC history; P5 does not invent post-migration candles.

## Operator view and alerts

`/operations/graduation` and `/api/operations/graduation` require the existing builders GitHub session and immutable operator-ID allowlist. Responses are private and uncached. The compact view lists exact-order graduation candidates, phase/progress, cumulative partner earnings and claims, available allocated liquidity reserve, current reconciliation, disabled execution flags and the reason a market is or is not ready for review.

The only mutation on this surface acknowledges an alert; it requires operator authentication and same-origin POST. There is no claim, allocation, liquidity execution or activation button.

| Alert | Durable deduplication boundary |
| --- | --- |
| 75% / 90% target | Once per repo and threshold, including thresholds crossed while the worker was offline |
| Graduation | Repo + verified migration signature |
| First partner fees | Once per repo |
| Platform claim available | Repo + cumulative claimed checkpoint; requires positive indexed/on-chain amount and no pending claim |
| First P3 eligibility | Once per repo when all readiness checks and a bounded quote pass |
| Reconciliation mismatch | Repo/protocol + report hash |
| Evidence/provider/config review | Repo/protocol + safe error code |

`graduation_alerts` persists unread/acknowledged status across worker restarts and closed browsers. Each newly inserted alert is also returned in structured worker logs. These are **operator dashboard and worker-log alerts**; P5 does not add email, Slack, browser push or an external paging service.

## Detection, durable proof and source reuse

The existing worker runs one background readiness pass every 30 seconds after the previous pass completes, paced at half a second per remote market (two seconds until October 5, 2026; `GRADUATION_MARKET_PAUSE_MS`), and the worker logs each pass's `graduationMs`. Normal fee indexing and already-approved recovery continue independently. RPC calls have 15-second timeouts and do not retry a rate-limit response in a tight loop. A global provider outage invalidates observations once per pass. Local rehearsal RPCs are exempt from remote pacing; production cannot use the local-network exception.

A migrated flag alone is insufficient. The existing `createGraduatedFees` / `migrationPosition` verifiers establish the exact canonical migration, DAMM pool, creator and partner positions, position NFT ownership, SOL-only fee mode and permanent locks. P5 adds a dual-RPC finalized receipt agreement check and stores one immutable `graduation_events` record with:

- Immutable repo ID, curve/config/mint and DAMM pool.
- Migration signature, finalized slot/block time and message hash.
- Creator/partner positions and verified position evidence.
- Transaction pre/post native and token balances; post-curve account evidence.
- Last indexed observation when one exists, plus reconciliation at detection.

The last observation is not represented as an exact historical pre-instruction account dump. Public and operator graduated projections must reference the durable proof's matching evidence hash. Replays do nothing; a conflicting repeated proof fails closed without overwriting the original event.

Existing creator/partner fee ledgers, claim records and P2/P3 accounting remain authoritative. `damm_trade_events` adds only previously missing finalized DAMM swap evidence for real market volume; it reuses `pool_fee_cursors` keyed by the DAMM address, canonical swap CPI parsing, stable signature/instruction ordinals and complete history back to the migration. No deposits, migrations, synthetic trades or fee claims count as volume.

## Readiness and activation boundary

“Ready for review” requires fresh agreed graduation/position evidence, all relevant `MATCH` results, active V1 60/20/20, settled allocated revenue, no open or completed first P3 intent, at least 25 SOL recorded DBC volume, pool SOL below the 100 SOL target, separate operating SOL and a valid balancing quote. The approved first-run settings remain capped at **0.05 SOL investment + 0.012 SOL overhead**, 1% slippage and 0.5% price impact.

Eligibility never enables execution. The operator must select the one market, review its exact intent, simulate, explicitly execute within a controlled P3-only window, restore P3 OFF, verify exact finalized wallet/token/LP deltas, and obtain final `MATCH`. Only that non-zero **mainnet** proof satisfies P4's activation prerequisite; P4 still requires a separate controlled activation. See the [15-step runbook and failure matrix](FIRST_GRADUATION_RUNBOOK.md).

## Verification — September 26, 2026

- 14 focused access, progress, semantic RPC agreement, freshness, replay/conflict, first-run cap and existing market/operator checks passed.
- Actual local-validator integration passed: 75% → 90% → target → canonical migration → genuine local DAMM swap → partner accrual → ordinary platform claim → V1 allocation → positive reserve → P3 review eligibility. These are isolated local fixtures, never production activity.
- Local fault injection rejected RPC disagreement, wrong mint/pool binding, missing partner position and accounting mismatch; restored evidence returned `MATCH`.
- Repeated worker runs preserved one graduation event, one swap and one alert per threshold; no P3 or P4 intents were created.
- A final read-only rerun of the updated monitor/public projection returned `MATCH`, with P3/P4 false and no additional alerts.
- A separate isolated P3 → P4 → P5 migration test passed, preserving an existing repository and applying the upgrade once across two migrator runs. It also enforces strictly increasing migration timestamps. The original prepared P4/P5 timestamps preceded the deployed P3 timestamp; correcting only those unapplied entries resolved the skipped migration.
- Desktop and 390px mobile component checks used synthetic local display data; the operator table scrolls within its own container. The temporary harness was removed.

### Local proof identifiers

| Evidence | Localnet value |
| --- | --- |
| Repo | `998001` (`local/graduation`) |
| Migration | `CTRdMUinCAu2PcKRzWh4PVBARhr7Fm1VBCNCFPvYy3P5313MNQ8ENBXJiFzVNUbgvgmeFnSdMu8iuRN2hCHCJxM` |
| DAMM pool | `EpAW2TSctqANSwJVfGx2HVV74C757fabkP3gVvdRxTdn` |
| Creator position | `65GbVZYtMHeEvFAp41QiBjhwN3JoYPZ9SxJbLMAt8wwA` |
| Partner position | `BLn15tqHycS8c6mt7VgBrH9qKQq7X2Gfc9FQZBncqshx` |
| Local DAMM trade | `5wcUT47Eb4ghBy1syx63w11Ku3kTRHMQr72P9SF3A7tYrbQjeBcyyfHEnQvj1Psioi5ALBABdEgMSQskPPCe2LxM` |
| Local platform claim | `4w2WMgzCCfUnGppAgTRYB1qXnVCA2nN6m5qEdAWVazqphJEZrnnaP3PQXgahgXEXMbYosNVTAJrMfFW5rK2TS7PD` |
| Allocated liquidity reserve | `79,999` lamports; zero committed or spent |
| Final result | Repository/revenue/liquidity `MATCH`; zero P3/P4 intents |

The first real mainnet graduation, DAMM claim and bounded LP deployment remain to be observed. Local proof does not satisfy those live gates.

## Production rollout — September 26, 2026

Implementation `13ba5e5` is deployed on Railway web `4f8d04bc-e25c-426c-8b26-ced85eaff49d` and worker `1db278dc-d881-4487-bd62-edafb49eb567`; both succeeded. Additive migrations 0015 and 0016 are applied, with 17 recorded migrations. The migration-order repair was applied after checking both execution gates false, and a repeat migrator run was a no-op. The corrected manifest is part of both final release artifacts.

At **2026-09-26T23:07:20.081Z**:

- All **16 indexed markets** were fresh, verified `CURVE` observations with repository reconciliation `MATCH`; all 16 public progress endpoints returned HTTP 200 and `Cache-Control: no-store`.
- Three consecutive worker passes (2026-09-26T23:04:21Z, 2026-09-26T23:05:31Z, 2026-09-26T23:06:44Z) each verified all 16 markets and returned 16 `MATCH` results. Normal fee indexing continued with 16 `OK` results and no recovery errors.
- Platform revenue and liquidity reconciliation were `MATCH`. V1 remained active at 60% buyback reserve / 20% liquidity / 20% treasury. Claimed revenue, liquidity reserve and spend were all zero.
- Web and worker both reported P3, P4 and buybacks explicitly false; maximum investment was 50,000,000 lamports and maximum overhead 12,000,000 lamports.
- Zero production graduation events, DAMM trades, P3 intents or P4 intents existed. The local rehearsal repository was absent from production. No mainnet transaction was signed or submitted by this work.
- The closest market was `cat-milk/Anime-Girls-Holding-Programming-Books` (repo `90916769`): **0.274992623 / 85 SOL**, **0.32%**, **84.725007377 SOL remaining**. This is a dated observation, not a fixed estimate.
- The live market card passed desktop and 390px mobile checks with no horizontal overflow. Anonymous operator API access returned 401 and the operator page required GitHub verification. The authenticated data projection was checked within the production service; a signed-in operator browser session was not available for that visual check.

The first verifier, Solana's shared public RPC, produced transient HTTP 429 errors. Its ten durable review alerts remain as operator-visible history; the final PublicNode-backed passes were clean. No alert or financial evidence was deleted to make the result appear healthy. RPC JSON property-order differences were also normalized, while every economic value and instruction order remains part of the agreement check.

**16 checks passed:** 14 focused checks, the real local-chain graduation/fee/claim/allocation rehearsal, and the P3-to-P5 upgrade/idempotency test. The final production build, exact-patch secret scan and whitespace checks passed. The temporary browser harness, local validator and this task's disposable P5 database were removed; proof identifiers above are retained. P4's dormant code/schema shipped with P5, but its production execution is still OFF and requires the first verified live P3 `MATCH`.
