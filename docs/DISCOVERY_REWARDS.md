# Discovery rewards v1

**Current policy, September 26, 2026:** new v2 launches earn 50% of eligible partner DBC fees up to **2.5 SOL lifetime**. Earlier v1 launches retain **1 SOL**. Both end at curve completion or 30 days if sooner. The policy stored on each market is authoritative. The original v1 design and historical evidence below retain their original values. See [v2 activation](BUILDER_ALLOCATION_PLAN.md).


Scope explicitly approved by the operator on 2026-09-25. This extends the MVP's fee accrual and claim paths.

> **Version note, 2026-09-26:** this page records the v1 policy, which remains immutable for the markets enrolled under it. New launches enroll under discovery v2 with a **2.5 SOL lifetime cap** (see the [approved design](BUILDER_ALLOCATION_PLAN.md)); every market's stored `discovery_version` selects its own cap.

## Product rules

- New launches only. The server stamps `markets.discovery_version = 1` when reserving a launch while enrollment is enabled. Existing, submitted, and recovered markets are never retroactively enrolled.
- The canonical, finalized launch signer (`launcher_wallet`) is the sole recipient. Launching a repository does not grant GitHub authority or ownership of builder fees.
- The launcher earns **50% of actual partner trading fees** for canonical DBC swaps from pool creation until the first of curve completion/graduation, 30 days, or **1 SOL earned in total**. The swap completing the curve is included. Subsequent DAMM trades are excluded.
- `min(floor(sum(eligible partner lamports) / 2), 1_000_000_000)` defines lifetime earnings. Aggregate rounding makes batching and backfill order irrelevant. Paid rewards count toward the cap.
- The start is the finalized DBC pool's immutable `activationPoint`, using the timestamp activation mode and the same Solana Clock as swap events. RPC estimated block timestamps are not used for this boundary. The end timestamp is exclusive.
- Earned rewards remain claimable after expiry or graduation. There is no minimum reward claim. The wallet pays network and account setup costs; the UI previews costs and warns if they exceed the reward.
- Fixed total fees and builder shares are unchanged. For the current nominal split, half of the 0.406% partner share is about 0.203% of trading volume. Accounting always uses actual finalized fee events, including integer rounding, rather than that displayed percentage.

## Evidence and isolation

`discovery_fee_events` records all canonical partner fees with immutable `discovery_eligible` evidence; reward summaries include only eligible events. Legacy markets and trades outside the reward window do not gain rewards. The exact partner remainder is: `tradingFee - floor(tradingFee * creatorPercentage / 100)` from canonical `evtSwap` evidence. It is committed in the same database transaction as builder accrual, before the existing worker cursor advances. A signature/event ordinal is unique. Contradictory replay fails rather than replacing evidence.

Only swaps validated against the canonical config, mint, pool, DBC instruction ancestry, and finalized transaction enter this ledger. The DBC program rejects swaps once its curve is complete. Migration/LP/protocol fees do not count.

`fee_events`, `repo_claims`, repository earnings, and the protocol's “paid to builders” total remain builder-only. Discovery payouts use the DBC **partner** fee authority and its quote-fee balance, never the creator signer or creator fee balance.

Primary references: [Meteora fee accounting](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/state/virtual_pool.rs), [partner claim SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/docs.md#claimpartnertradingfee). Installed SDK: 1.5.13.

## Claim and recovery

1. Load accrued minus settled rewards under the same per-repository Postgres advisory lock used by launch and fee accrual. Validate the canonical pool, partner authority, SOL quote config, and sufficient on-chain partner fees.
2. Prepare a bounded `claimPartnerTradingFee` transaction to the stored launch wallet, with zero base-token withdrawal. The recipient is the fee payer. A fresh temporary WSOL authority keeps existing user and platform WSOL accounts untouched; its account rent returns to the recipient.
3. Save a `prepared` intent with a unique ID, amount, exact message, and last valid block height. Its memo binds repo.ing, Solana genesis, repository, wallet, amount, intent ID, and block-height expiry. It has **no partner signature**, so a prepared offer cannot be broadcast successfully outside the application.
4. Show reward and costs; ask the user's wallet to sign. Verify its required signature and byte-for-byte message equality on submit. Only then add the server's partner signature and simulate.
5. Save the complete signed transaction and signature as `pending` before broadcasting. A unique partial index allows only one prepared/pending intent per repository. Retries reuse the same signature and bytes.
6. The worker or claim-status check rebroadcasts that intent after a restart. It marks `settled` only when a successful finalized transaction matches the saved message and its canonical `evtClaimTradingFee` proves exactly the recorded quote amount and zero base amount. Concurrent trades do not affect this transaction-local proof.
7. A finalized failed transaction can be aborted. A signed intent with no history is aborted only after its last valid block height has passed on the finalized chain. Any processed/confirmed status, missing finalized receipt, or contradiction remains pending for review. An unsigned expired offer can be safely replaced.

The wallet transaction itself proves control. GitHub authorization is deliberately not needed for discovery, and remains mandatory for builder claims. There is no automatic payout at launch or trade time.

## Operations

- Apply additive migration `0009_discovery_rewards` before deploying the new worker and web versions.
- Web only: provision `PLATFORM_PARTNER_SECRET_KEY` from the existing protected DBC partner wallet. Verify its public key equals the config's `feeClaimer`. Never put it in a `NEXT_PUBLIC_` variable, build output, docs, logs, or worker environment.
- Worker recovery uses fully signed, user-authorized intents and needs **no partner secret**.
- Enable new enrollment with `DISCOVERY_REWARDS_ENABLED=true` only after migration and the new worker are running. Disabling that flag stops new enrollment; it does not erase already-earned obligations or disable existing claims.
- **Do not sweep partner fees backing discovery liabilities.** Keep at least earned-minus-paid rewards in each enrolled DBC pool. Preparation fails closed if its fee balance is below the reward due. Investigate withdrawals/history; never reduce the ledger to hide a shortfall.
- This is a platform-managed reward obligation. The partner key controls withdrawal; there is no custom escrow contract enforcing the split. Preserve the database and signed-intent history in the existing encrypted backups. An operator rebuilding fee evidence must also restore settled payouts before allowing new claims.
- On rollback, keep recovery running for pending signed transactions and keep their ledger. Do not drop these tables or automatically reclassify unresolved payouts.

## Local verification

Tests use isolated PostgreSQL on localhost port 55439 and a local Solana validator with the existing Meteora fixtures. No mainnet launch, trade, or discovery payout is submitted by these tests.

```sh
DATABASE_URL=postgres://discoverytest@127.0.0.1:55439/discovery_test npm run db:migrate
DATABASE_URL=postgres://discoverytest@127.0.0.1:55439/discovery_test SOLANA_RPC_URL=http://127.0.0.1:8899 npm run test:discovery
```

The chain test rejects any other database URL, uses disposable in-memory keys, and clears only that dedicated database. It checks first-buy fees, exclusion of existing markets, duplicate indexing, wallet/message rejection, concurrent preparation, expiry, a lost broadcast, recovery without a partner key, contradictory receipt handling, one settlement, untouched builder fees and existing WSOL, graduation, and claiming previously earned rewards afterward.

Mainnet discovery payout verification requires a separate user-approved transaction; local proofs do not constitute a mainnet payout. The first finalized mainnet receipt is recorded below.

### 2026-09-25 evidence

- Discovery integration: **7/7** Node test results passed (six sequential financial subtests and their parent); policy/versioned-chain checks: **9/9**; existing builder claim regression: **5/5**; production build passed.
- Local discovery repository `2002`, mint `GW7yAZkdnnQFwhv8N3hvQtfiYqAZTTsjQw3VDw4r4qNw`, pool `7VDsvtg6NvicJvgzqfG7p8bN5Kh1fYZSApN3EThXVRMG`, config `4zTJ6cdyyDCR2993AC65P7RbEGD5vRVa2nde2b6UMoYH`.
- Local launch: `54xZFoATw1M2BVqaoR9WdXpFUrnFXUb3RqDQxWFA6t5Jwe3DjfLcYcNXNwgXgSxx8GHLyjdDCWd6kbh7vVrrCupe`.
- Recovered local payout: `5kHVE1VPL8ZTaxHrZCxNRHexTAgfhEBf9uqKx4iF3xgJ1Aa64PaGArB4H8Qhw3f3quABuKVssHnPSeh8KZd9JYm5`.
- Local claim after curve completion: `go1VBo4YeHnFeTKzobkraptsguqi3iFGYNY8a7WDyBcfDHUUabEReraNgakdRVgKd7HxenQWpmd6DH2erBrSDBc`. Total earned/paid: **61,891,237 lamports**; remaining zero. The separate creator fee balance was unaffected by discovery payout.
- Local browser check at 1900px and 390px: reward totals, graduated state, copyable launch wallet, and settled receipt rendered; mobile document width equaled viewport width.
- Production migration applied through the web service's private database connection. Worker deployment `120374ba-897c-4081-baf1-2e1ec42d41f2` succeeded; all eight existing markets returned `verified`/`OK`, with no discovery payout intents.
- Final web deployment `ff8f8997-b650-4419-ba92-b458d37fd7cb` succeeded. Live API checks returned HTTP 200 with `enrolled: false` for OntologyEX, HTTP 400 for an invalid repository ID, and HTTP 400 for a cross-origin claim request. Production counts were eight markets and zero discovery enrollments, credits, or claims.
- A ninth market arrived during rollout. The final read-only comparison found **9 indexed markets in Postgres and 9 on Explore, still 0 enrolled**. The homepage intentionally shows only five trending markets. This concurrent launch was not retroactively enrolled while activation approval remained pending.
- **Activation approved and verified:** the operator explicitly approved the pending request to provision the existing partner key from macOS Keychain into Railway web and activate rewards. Web deployment `1ccdfa47-c615-4a92-be17-7f9f70b0c226` succeeded. At `2026-09-25T17:00:25Z`, that running deployment returned `discoveryRewardsEnabled() === true`; its partner public key `H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3` matched the finalized DBC config's `feeClaimer`. The worker has no partner secret and remains on successful deployment `120374ba-897c-4081-baf1-2e1ec42d41f2`.
- Activation checks found **10 indexed historical markets, 0 enrolled markets, 0 discovery fee events, and 0 discovery claims**. Another historical market arrived before activation. Existing markets remain excluded; enrollment is stamped only on new reservations. The live `/launch/1170821064` page returned HTTP 200 and showed the 50% share plus graduation, 30-day, and 1-SOL limits. OntologyEX's discovery API remained `enrolled: false`; `/`, `/explore`, and `/stats` returned HTTP 200. These checks sent no launch, trade, or payout transaction. A real mainnet discovery payout remains unverified.

The older Docker/Postgres test cluster failed with I/O errors. A fresh native PostgreSQL 17 cluster at `/tmp/repo-ing-discovery-pg`, bound to localhost port 55439, supplied these tests. The existing production database and old Docker volumes were not used for local test data. Temporary test services were stopped and their disposable database/validator data removed after recording evidence, reclaiming roughly 2 GB. Recreate the isolated cluster and validator before rerunning the chain tests.


**2026-09-25 extended verification:** Nine local tests passed with actual DAMM v2 migration, canonical destination verification, and payment of already-earned discovery rewards afterward. See [launch review and graduation evidence](LAUNCH_REVIEW.md). An unsigned mainnet SKILLS reward offer simulated successfully; a real mainnet payout still requires the launcher wallet signature.

### First mainnet discovery payout

After the user approved the wallet request on 2026-09-25, read-only finalized RPC verification and the production claim ledger confirmed:

- Repository: `1148788086` (`mattpocock/skills`); mint `EMZx4nLuBLmqAmm1uKBZ8J2m1HckcyKrm5WquNA8xW8o`.
- Canonical DBC pool: `Ctbtoe6AfqGeRuercHd3wq3XVDvj31mLY3qC1p1pZWg5`.
- Recipient and transaction fee payer: `AKJGvCpvKA9nuhgQFaPtu3ZLgGWCiK6uikBoFcJbAWMD`.
- [Finalized transaction](https://explorer.solana.com/tx/2WHxCKkrMvoGGRVHFArRzCfepnDMS6Crdo5yHe9Xo2bYfqzgjQ1k1r6FCTkZyXBBGr1fobyidhtX6DKqtxScx7Vn), slot `450444046`, with no transaction error.
- Decoded `evtClaimTradingFee` for the canonical pool: zero base fees and **379,639 quote-fee lamports**. The partner signed; the creator account was absent from the transaction.
- Network fee: **15,000 lamports**. Recipient's net SOL balance increase: **364,639 lamports**, exactly the reward minus that fee.
- Settled intent: `c4b12d89-798f-4430-993d-30e9026845d8`, amount `379639`, matching the finalized signature. Two earlier unsigned intents (`c46483d3-3696-4ae7-b51c-96bc8aaa3bc0`, `e1a5eae4-f98b-43ba-97d5-2db97c8dcb08`) are aborted with no signatures. Exactly one claim is settled.
- Public discovery API: earned `379639`, paid `379639`, remaining `0`, latest claim `settled`.

This closes the first mainnet discovery-payout check. Mainnet graduation and the first graduated payout remain unobserved at this checkpoint. DAMM indexing/payout integration was subsequently deployed; see [Graduated fees](GRADUATED_FEES.md).
