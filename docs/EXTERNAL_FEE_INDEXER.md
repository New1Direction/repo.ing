# External DBC fee indexing

**Local validator proof, 2026-09-24.** `src/external-fee-indexer.mjs` scans finalized signatures touching each indexed canonical DBC pool. It walks back to the persisted pool cursor, or the finalized launch signature on the first run, then processes signatures oldest first through the existing chain-evidence fee decoder. The decoder credits only canonical DBC `evtSwap` creator fees. A cursor advances after each successful or failed finalized transaction; a fee event is committed before its cursor advances. If a process stops between those writes, replay uses the fee event's unique chain key and credits nothing twice. If the RPC cannot show the stored boundary, the worker reports `ERROR` and leaves the cursor in place.

Migration `0006_external_fee_cursor.sql` stores the last processed signature and slot per pool. `npm run worker` runs launch verification followed by external fee discovery every five seconds in one persistent process. `npm run worker -- --once` runs one cycle. `npm run fees:index -- --once` runs only fee discovery. Run migrations first and provide `DATABASE_URL`, `SOLANA_RPC_URL`, and `DBC_CONFIG`. The RPC must retain finalized transaction history back to each pool's cursor or launch signature; monitor `ERROR` results and reconcile before claims.

The focused test uses a dedicated local PostgreSQL database, the Meteora DBC and Metaplex validator fixtures, and the fixed 175 bps / 71% config. It launches one repository market, makes two buys and one sell by calling the canonical trader directly without the API fee hook, and then runs the worker. A restarted Node worker sees zero new credits. Deleting the cursor replays from launch and also credits zero new lamports. A later sell is found on the next run. An invalid cursor causes an error without changing the ledger.

| Evidence | Value |
| --- | --- |
| Repository ID | `1296269` (local fixture) |
| Config | `4UMxdbqNeZio13Swi4Mr8NH2bFw6F16AFvtvVR7eaVFC` |
| Mint | `2yuBm2Wf3uAh7YrcswyHZCYVPw2ncD9v9UEctwANUcFQ` |
| Pool | `BGTQrt1jT5CBhbFugUtUoLmPcmgbB8bXPn8iRHn1s7tF` |
| First buy | `4oeFnsE479ErjFELFhMW1gNSabZqkd4GEPXjCZErnk68H3rTVvuazmxsp9fcj4tFov5YK2SPpb8dYu6Hr5MSwJje` |
| Second buy | `59TiyYAUmiyoKSMo4CfMBTDqpf9EPDwEFfadYBUWa2E5wf2zFkwUSQPyqtke8pJaGxcPkiFjemYgA4duGA21PqC2` |
| Later sell | `26fvUskyr1mfHLGuxu9BLk1J4c9K2cFLKM4DL1nju5nsre5CRajCT4HX285iKCnxFpSaegYBAsydSSATnfuR1T6x` |
| Earned and observed on chain | `298,189` lamports |
| Reconciliation after restart | `MATCH`; recorded earned and on-chain creator fee both `298,189`, difference `0` lamports |

Run `npm run test:external-fees` against the dedicated test database and local validator setup in [LAUNCH_COORDINATOR.md](LAUNCH_COORDINATOR.md). The test truncates its database tables and creates disposable wallets and a new config and market. New signatures and amounts can differ. This proof covers pre-graduation DBC swaps on a local validator. Mainnet RPC history behavior, high-volume pagination, and DAMM v2 post-graduation fee indexing remain unverified.
