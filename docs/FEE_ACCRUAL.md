# Canonical repository fee accrual

> **Since this report:** the decoder also credits `evtSwap2` and `evtSwap2WithTransferHook` for a swap that emitted no `evtSwap`; when a swap emits both, only `evtSwap` is credited (`src/trade-evidence.mjs`). Builder earnings are read from `builder_fee_credits`, which adds graduated `damm_fee_events` to these `fee_events` rows (migration 0010).

Run date: 2026-09-24. Scope: DBC `ACCRUE_FEES` only. This run used the isolated local Solana validator, PostgreSQL test database, and `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`.

`src/fee-accrual.mjs` accepts a GitHub repository ID and finalized trade signatures. It loads the finalized, indexed canonical market, checks the pool and fixed config on Solana, and decodes the DBC `evtSwap` event CPI in each successful finalized canonical swap transaction. The event's `swapResult.tradingFee` and the on-chain config's `creatorTradingFeePercentage` determine the creator share in quote-token base units. The tested config collects fees in wrapped SOL and assigns 50% of trading fees to the per-pool creator. The SDK also emits `evtSwap2` for the same swap; it is deliberately not credited again.

Each creator credit is an append-only `fee_events` row tied to immutable `github_repo_id`. The evidence key is `(signature, evtSwap ordinal, kind)` and has a unique index. `earned = SUM(amount_base_units)` across those rows; there is no mutable earnings balance. The current pool's `creatorQuoteFee` is reported as a separate on-chain observation. It is an **unclaimed** counter, so cumulative earned must not be capped by that counter after future claims.

## Local evidence

The test launched and indexed one disposable market, then wallet A bought with 10,000,000 lamports, wallet B bought with 15,000,000 lamports, and wallet A sold half of its bought tokens. All three trades and their fee events were read at finalized commitment.

| Field | Observed value |
| --- | --- |
| GitHub repository ID | `1296269` |
| SPL mint | `2HjcfQd87M8zXEJw3Aunp4vdxCr8rxVVjnxCxirRZ5vF` |
| Canonical DBC pool | `JA6mUXmeMnek57yGEoPHwfvAGDkeXQDWb8MkRzTDRi41` |
| Fee asset | wrapped SOL mint `So11111111111111111111111111111111111111112`; amounts in lamports |
| Wallet A buy, slot 472 | `5VAzDuMpetgSumZLqJ4cLqG5gdG5Xuk2TrGL2ks7FJYavEsYNXC6zs9naSiMdDiLPp4FV4X7wkNqZUzUcS8aBHzP` → creator fee `40,000` |
| Wallet B buy, slot 473 | `3ahgcRWaXM4ur7Tp66c6ZzmQnicC7zirzigV8fYcYywnwSiUNpEs9bwzRrZays8UJc9tXoqKfBoh1X8kqqZJjMoo` → creator fee `60,000` |
| Wallet A sell, slot 474 | `2RE2LcCrbbj2dXFp47r1wqZYFN6qkz1QcF5SSM7UjFxhtovShMXcLST9A9EkWT5w34LcJWbDYX8C7u8a8xzw7JGG` → creator fee `20,151` |
| On-chain `creatorQuoteFee` after trades | `120,151` lamports |
| Ledger earnings for repo `1296269` | `120,151` lamports |

Each transaction produced one credited `evtSwap` with ordinal `0`, so its ledger key is `SIGNATURE:0:dbc_creator_quote`. The three credited amounts sum exactly to the observed pool creator-fee counter. Reprocessing all three signatures credited `0` new lamports and left three rows. After the test process exited, `npm run fees:earned -- 1296269` started a new Node process and returned `{"githubRepoId":"1296269","asset":"SOL","earnedLamports":"120151"}` from PostgreSQL.

## Files, reproduction, limits

Changed: `src/db/schema.mjs`, `drizzle/0002_cultured_spyke.sql` and its Drizzle metadata, `src/fee-accrual.mjs`, `scripts/read-repo-earnings.mjs`, `tests/fee-accrual.test.mjs`, `package.json`, and this report. The schema adds `fee_events` with a repository foreign key, integer base-unit amount, chain evidence fields, positive-amount check, and unique evidence key.

Use the local PostgreSQL and validator setup in `docs/LAUNCH_COORDINATOR.md`, then run `npm run db:migrate` and `npm run test:fees` against a **dedicated test database**. The test truncates repository, market, and fee tables, creates a new disposable config and market, and uses in-memory wallet keys. Fresh addresses and signatures will differ. `npm run test:fees` passed **4/4** tests: real fee attribution, canonical repository association, duplicate evidence rejection, and new-process ledger re-read. No unrelated transition suites were rerun.

This proves DBC fee accrual before owner verification. Claims, payout debits, post-claim accounting, DAMM v2 accrual, and a continuous trade backfill worker are unverified in this transition. No fee was paid to a beneficiary.
