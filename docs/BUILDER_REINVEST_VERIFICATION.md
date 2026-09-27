# P4 preparation evidence

[Documentation](README.md) / [Builder Reinvest design](BUILDER_REINVEST_PLAN.md)

**2026-09-26 — implemented and locally verified; production execution disabled.** Work is on `codex/builder-reinvest-prep`. No production migration, deployment, environment change, or mainnet transaction was performed for this preparation. Migration `0015_builder_reinvest` was applied only to disposable local test databases.

**Later P5 rollout:** dormant P4 code and migration 0015 shipped with [First Graduation Readiness](FIRST_GRADUATION_READINESS.md). `BUILDER_REINVEST_ENABLED=false` was verified in both running production services. This deployment does not satisfy the P3 live-proof gate and did not create a reinvest intent or mainnet transaction.

## Results

| Check | Result |
| --- | --- |
| P4 local chain rehearsal | 2 tests passed: activation guards plus claim → optional reinvest, cancellation, verification and recovery |
| P4 API/access and quote guards | 3 tests passed |
| Existing operator authorization | 2 tests passed |
| Wallet adapters | 7 tests passed, including Wallet Standard active-address checks, account changes and disconnects |
| Existing P3 liquidity path | 2 tests passed after extracting its read-only settlement verifier |
| Existing builder Claim path | 9 tests passed, including claim-all across two repositories |
| Production build | `npm run build` passed; includes `/api/reinvest/[repo]`; temporary UI test page removed |
| Final current-code readback | Canonical pool and mint agreement, fresh quote bounds, repository reconciliation and P4 reconciliation passed |
| Desktop and 390 × 844 UI | Claim/Reinvest choices, presets, custom amount, approval/rejection, receipts and layout passed |

**25 focused tests passed.** These results cover the changed paths, not every historical project test. Local chain tests use the real Meteora DBC and DAMM fixture programs described in [the original spike](METEORA_SPIKE.md), SDK versions pinned in `package.json`, a bounded disposable validator at `127.0.0.1:8909`, and dedicated PostgreSQL databases.

The P4 integration test rejects non-loopback RPC URLs and any database other than `repoing_reinvest_test` on the local test server. It creates disposable signers in memory and truncates that database. Run it only after starting the local fixture validator and applying migrations there:

```sh
DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/repoing_reinvest_test \
SOLANA_RPC_URL=http://127.0.0.1:8909 \
node --test tests/builder-reinvest.test.mjs

node --test tests/builder-reinvest-access.test.mjs tests/platform-operator.test.mjs tests/solana-wallet.test.mjs
```

The password above belongs only to the disposable local fixture. No operational key or credential is part of the test. Use a bounded validator ledger and stop it after verification.

## Final local chain proof

These addresses and signatures identify **localnet fixture transactions**, not mainnet activity. A fresh run generates different keys. Raw signed transactions and private keys are omitted.

| Identity | Value |
| --- | --- |
| Repository ID | `997001` (`local/reinvest`) |
| Bound builder / LP owner | `28cNJdJBmH9YtbrzNnUHPAgx8GHCSKfww2iECC7SZ3e7` |
| Canonical graduated pool | `HQrdrHyeXGFg62boA1zcxPLcuhKscdAjsN8ArJ2J7SWs` |
| First ordinary claim | `4rtNfDFryNAo6DSZDRxXeiEryGMqU1NQaTzhToXCPJy5gfeKt8kqZXCAFtdqBvsTxbLxMNSqk44QamXwdbKs9NJU` |
| Second ordinary claim | `aMYMoZiZwHyFq1mK1zK1LwDxMrVkwfHXTekheEc9X7oTmHRuDXyHuqDUecvFBFsotj4dBF4B6yVbEAQED52yyV6` |

The first claim's prepared offer was cancelled without changing the builder's SOL balance. Its reservation remained until blockhash expiry and dual-RPC absence were proven, then became `aborted`.

Three separately wallet-signed reinvestments used portions of the **same second settled claim**. Each had a 1,000,000-lamport maximum investment. None performed another claim or created a P3 platform liquidity intent.

| Path | Finalized signature | Builder LP position |
| --- | --- | --- |
| Normal submit, with concurrent duplicate rejected | `43WYjvJPmeE1oYa3svmXDQ2Prumo3sDnxJLRzkDpbexqB4i4EuKxWgKx1XW87LKf4gkAjt6Hh9vBAdPjwyUKJRm1` | `AvCckDs98wJGyg4cSQdLZAzTipxwhmMD2RSEoJoMNfz9` |
| Lost broadcast response, recovered once | `RM1KKCgQQLzScamVx41ZDA77RTnM4wLepRZtAkKdQiBHdK4dsxrhx7pRWpWrFrk5wNqcdQguUTG6za2933rxxXK` | `1D6kKjD232nhSCBxA3AMNWyd8mR472yU3g9VFDxDx9R` |
| Independently broadcast issued offer, recovered after cancellation | `3csBh7oTzuyeLp6y8cnaM2xmEgCn4va1rV7HWxCGHrc7ai7KzNRcJDBE2yvSz1xSr2nvJVJxpm4u8umqzEcLgxe3` | `93gLM5g6vbaLkYo1AiF4hcm9EcRLhHzHVYJQV9zCUFwN` |

Each settlement verified an economic debit of **994,904 lamports**, account/network overhead of **9,907,120 lamports** (including a 10,000-lamport network fee), and a total wallet debit of **10,902,024 lamports**. The test wallet was separately funded for account costs; rent is not treated as claimable fees. Both token vault deltas, wallet token output/deposit, LP liquidity and builder NFT authority were verified exactly.

The small investment deliberately tests accounting boundaries. The account cost is large relative to this test amount; the UI shows it separately before approval. It is not an estimate of a mainnet investment's return or a recommendation to use this size.

Final readback:

```json
{
  "repositoryReconciliation": "MATCH",
  "reinvestmentReconciliation": {
    "status": "MATCH",
    "problems": [],
    "reinvested": "2984712",
    "open": 0
  }
}
```

Rejected paths include non-graduated pools; wrong repository, wallet, caller-supplied pool or mint; missing/unsettled claim; over-budget amount; revoked GitHub admin authority; changed payout binding; modified transaction or review; expired intent; high price impact; quote below the reviewed floor; duplicate/replayed submission; wrong LP owner, wrong mint or excessive settlement cost; and RPC disagreement. An unavailable second RPC retained the submitted reservation for review instead of declaring success or releasing funds.

## UI proof

Browser checks rendered the real Claim/Reinvest components with a synthetic wallet and API, separate from the real local-chain financial rehearsal:

- The primary claim form offered only **Claim** and **Reinvest**. Reinvest retained the ordinary reviewed claim submission.
- Selecting 25% or 50% populated the corresponding amount; 100% and a custom `0.0375` SOL input also worked.
- Review called preparation/simulation without requesting a wallet signature.
- Approval rejection produced `prepare → wallet approval → cancel`, with **no submit**. The successful claim remained visible.
- A separate approved signature produced `prepare → wallet approval → submit`, followed by the LP receipt and ownership message.
- At 390 px width, copy and controls fit without horizontal overflow. Existing repository colors, borders and button styles were retained.

The temporary UI harness and browser session were removed after these checks. No extension wallet was asked to spend real funds.

## Activation still blocked

`BUILDER_REINVEST_ENABLED` defaults to false. Mainnet execution additionally requires an independent verification RPC and the exact P3 signature whose non-zero bounded deployment, finalized wallet/token/LP evidence, and reconciliations are reverified. An empty `MATCH`, a local receipt, an oversized P3 proof, or an enable flag alone cannot unlock P4.

Local testing used two RPC clients against one validator; disagreement and unavailability were fault-injected. It does **not** prove independent production-provider behavior or mainnet execution. The next activation prerequisite remains the first operator-reviewed P3 live deployment and final `MATCH`, followed by a controlled, separately approved builder-wallet P4 rehearsal. Keep production reinvestment disabled until that prerequisite is satisfied and the later rollout is authorized.
