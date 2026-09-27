# CLAIM transition

## Result

Local validator proof passed on 2026-09-24 with `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`. A platform creator signer called `creator.claimCreatorTradingFeeToReceiver` on the indexed canonical DBC pool. The SDK sent the creator fee directly to the repository's stored beneficiary. No platform payout transfer or custom Solana program was used.

| Evidence | Value |
| --- | --- |
| Network | local `solana-test-validator`, `http://127.0.0.1:8899` |
| GitHub repository ID | `1384142609` (`New1Direction/Waternot` test fixture) |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Fixed config | `FXBKnK4Qioph5NPH2uq88PZUnB8zMmQ5d4gPDpSDqKpv` |
| Token mint | `CCYjU2PQzxuuhn4FGGUNDAiDBdrajMijMyQbgGh6dGZS` |
| Canonical pool | `AVJDcKzgdvL84REXPPXcNnDajpzzdRiGiK8V9cZTm1qX` |
| Platform creator signer | `GcU6WTi5ydn2eqzijHMHnmNhSWTfkH4XANjHw8TWgcr5` |
| Bound beneficiary | `H1E4BFuVFWRGaR6bEvpdPAbXHVk6eBDqzrKCoug7G5kP` |
| Creator fee before | `40,000` lamports; matched indexed, unpaid creator-side fee events |
| Claim signature | `3PJc8CvnyYXqGT1gaGLFS8LX6s3Z8VPLDvaN77A9hvbb4Sg8pADchiDrWPuAEpEK5zUneWPrf8Uc1uu7StvgVaAq` |
| Claim slot | `459`, finalized, successful |
| Creator fee after | `0` lamports |
| Fee received | `40,000` lamports |
| Receiver native balance delta | `2,079,280` lamports: `40,000` fee plus `2,039,280` temporary wrapped-SOL account rent refund from the SDK route |

The claim uses the immutable repository ID to load the indexed market, beneficiary, and fee events. It calls the existing GitHub App `verifyCallback` for a **fresh** authorization and requires `admin`, the same repository ID, and a result no older than 60 seconds. The local claim test injected a deterministic verifier response: `write` and a stale `admin` result both stopped before signing or payout; a fresh `admin` result allowed the claim. The prior live GitHub admin proof is in [GITHUB_VERIFICATION.md](GITHUB_VERIFICATION.md). A live OAuth reauthorization immediately coupled to this local chain claim was **not** run; the GitHub boundary in this test was mocked. That composed external behavior remains unverified.

The request has no payout-wallet or pool parameter. The code rejects either if supplied. It checks that the canonical mint/pool/config and creator signer agree with on-chain Meteora state, that on-chain `creatorQuoteFee` equals indexed unpaid accrual, and that finalized transaction balances show the bound receiver got exactly the claimed fee plus the SDK's rent refund. The settlement row changes from `pending` to `settled` only after those checks. The pending signature is written before broadcast; an uncertain submission blocks a second claim until reviewed, preventing a blind retry. Automatic recovery of an uncertain pending signature is not implemented in this transition.

## Files and schema

Added `src/claim.mjs`, `tests/claim.test.mjs`, this report, `test:claim` in `package.json`, and migration `drizzle/0005_smart_ulik.sql` with Drizzle metadata. `src/db/schema.mjs` adds `repo_claims`: canonical repo ID, beneficiary snapshot, integer amount, asset, transaction signature, `pending`/`settled`, and timestamps. It has a unique transaction signature and at most one pending claim per repository. No payout account, token, or key material is stored.

## Reproduce

Use the existing local validator Meteora DBC and Metaplex program fixtures described in [LAUNCH_COORDINATOR.md](LAUNCH_COORDINATOR.md). Create a disposable Postgres database and run:

```bash
export DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/gitfun_claim
npm run db:migrate
npm run test:claim
```

The focused test ran **4/4 passing**: non-admin/stale rejection, receiver substitution rejection, successful direct claim, and repeated claim rejection. On repeat, `No accrued creator fees remain to claim`; the beneficiary balance was unchanged and exactly one settled claim row remained. Addresses and signatures change on each fresh local-validator run. The test generated disposable in-memory keys and used small local-validator SOL amounts. No live funds or secrets were used.

## 2026-09-25: progressive claim review and session reuse

The current web UI guides admins through **Verify GitHub → Set payout wallet → Review and claim**. Completed steps collapse but remain reviewable. The available SOL and approximate USD amount are shown upfront; a settled receipt offers the existing README earnings badge. An owner invitation can be copied or shared from a market or launch success screen, with current reconciled fees and a direct claim link. Nothing is sent automatically.

`POST /api/claim` requires the encrypted GitHub session, an explicit signed review, and an exact same-origin check. It uses the existing durable pending intent and finalized receipt path. Under the per-repository lock, the service rechecks GitHub authority and compares the review against the payout wallet, binding timestamp, cumulative settled payouts, expiry, and current on-chain fee. A successful payout increases the paid revision, so the same review cannot authorize another payout even if new trades recreate the previous balance. Beneficiary changes now share that repository lock.

The DBC instruction caps `maxQuoteAmount` at the reviewed amount. Concurrent trades can add new fees while a payout settles; the exact beneficiary balance delta in the finalized claim transaction proves the payout, and later fees remain in the pool for a new review. A later pool balance is not incorrectly treated as the claim transaction's exclusive fee reduction. A stale amount or changed payout details sends the user back to review, without submitting a new payout.

See [GitHub session handling](GITHUB_VERIFICATION.md#2026-09-25-one-authorization-per-claim-session). Production builder claims still cover indexed DBC fees; this change does not implement post-migration DAMM fee accounting.

### Local verification for the session flow

On 2026-09-25, the focused GitHub and wallet suites passed 10 checks, covering retained-token checks without another OAuth exchange, revoked authority, invalid identity, wallet signatures, and consumed/expired challenges. Session/polling/wallet/progress tests passed 12 checks, including authenticated encryption, expiry, secret rotation, cross-origin rejection, review binding, and hidden-tab polling. A separate two-repository database test matched direct market lookups to list aggregates.

The local validator payout suite passed with a trade deliberately inserted between claim simulation and submission: the reviewed payout was **99,400 lamports**, another **99,400 lamports** stayed in the pool, and the recipient received exactly the reviewed amount plus the temporary wrapped-SOL rent refund. Replaying that review failed without changing the recipient balance. A new review paid the remaining fees; the empty repeat was rejected. This is isolated local-validator evidence, not a new mainnet payout.

Reference local run: config `7qbdcZoudBGEQcHizrKRARWSNYFdGZ9PhKroNHceY8ix`, mint `988fWmH5TEwfJsYuoggujEtpVcpwuhdGHG5FcFXSiYVU`, pool `AqV8qVnSerZVjWCSwbe8FuswTR1yrwyzAKrvZ1X8oaX6`; first payout `5dnP6Em6ER5PpSpuNLMJuSu9PNH6fKM1XvF9eCDzeQxZ6DMNTdDqJFCRhD591anWwJQ4THFdA4pmEgCAJSKt7epD`, slot `1438`. Final reconciliation returned MATCH: 198,800 lamports earned and paid, zero remaining on chain. The temporary ledger is removed after verification.
