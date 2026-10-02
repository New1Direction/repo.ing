# Canonical DBC trading

Run date: 2026-09-24. Scope: `TRADE` against an already indexed canonical market. No schema change or trade history was added.

`src/canonical-trade.mjs` loads the `confirmed`, finalized-indexed market by immutable GitHub repository ID. Callers cannot provide a pool or mint. It checks the stored pool against the fixed DBC config and reads the current pool/config from Solana. Meteora DBC SDK `1.5.13` supplies `swapQuote` and the exact-input `swap` transaction for both directions. The wallet signs and pays. The output slippage limit defaults to 100 bps (1%). Site trades may choose 50–2500 bps, validated strictly by `src/trade-slippage.mjs` (an integer in range, never clamped), and the SDK's minimum output must equal an independent floor of its output at that tolerance before anything is signed. Solana Actions always use the default.

`submitTrade` confirms the signed transaction, then `verifyTrade` checks its DBC swap instruction references the canonical pool, config, mint, SOL quote, and wallet signer. Solana transaction metadata supplies the wallet's SOL and base-token balance changes and the pool's quote-vault change. The current DBC pool is also fetched to check its config and base mint. This verification is repeatable after a later trade because balance deltas come from each transaction rather than current wallet balances. It does not calculate or store fees.

## Local run

The test created and indexed one disposable market using the existing local-validator fixture. Wallet A then bought and sold against that same pool. Amounts are integer base units.

| Evidence | Value |
| --- | --- |
| GitHub repository ID | `1296269` |
| DBC config | `5HKBrG7LafCeRqLazHN6dnbR7Gz61ihgyA1dT1J5Par7` |
| SPL mint | `64Ppd39t3z7GvS5f3fD8WotRSb2jHkfyRMNJLoHGxvBH` |
| Canonical DBC pool | `3BxuAJ5XExfycq2nV3Cnu1kN1TvLhSrovoT63gpop5Bd` |
| Trader wallet | `GpDuT6vYSg2irdUQZFWS3hRd4p1MtcK5Ux1Zk1ggkej4` |
| Buy signature / slot | `375FXEUY99DuKwGgNSfpY3dkRDdGn375z6ZRiPY1UPfFGYFVCs4NRtZwvzjXBjScmVB9xSh5BDMJp3ztYUnZ1Z67` / `205` |
| Buy input | `10,000,000` lamports (`0.01 SOL`) |
| Buy wallet token change | `+9,850,114,372,117` base units |
| Buy wallet SOL change | `−12,044,280` lamports, including transaction and token-account costs |
| Sell signature / slot | `4WJcCFjHf3EUxLR21mAQxFK713EHLMqCo5tfprQmKbZzSB2rjTF1f8uT64pMv9pynE6oDN6NbmGzw5mXeEzwMopD` / `206` |
| Sell input / wallet token change | `4,925,057,186,058` base units / `−4,925,057,186,058` |
| Sell wallet SOL change | `+4,907,876` lamports after transaction costs |

`npm run test:trade` passed 4/4 tests: buy, sell, nonexistent/unconfirmed market rejection, and pool/mint substitution rejection. The buy was verified again after the sell with the same recorded delta. Launch and INDEX suites were not rerun because this task changed neither transition.

To reproduce, start the PostgreSQL and local Meteora validator setup in `docs/LAUNCH_COORDINATOR.md`, apply the existing migrations, then run `npm run test:trade`. The test truncates the dedicated local test database, generates disposable keypairs in memory, launches and indexes a fresh pool, and performs the two swaps. New runs have different addresses and signatures.

No current blocker. Devnet, post-graduation trading, fee accounting, and production wallet integration remain unverified by this TRADE task.
