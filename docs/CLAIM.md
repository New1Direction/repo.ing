# CLAIM transition

> **What changed after this report.** The sections below are kept as written. Since then:
> - A claim pays the indexed unpaid amount when the pools hold **at least** that much, and the receiver must get at least the proven payout plus the rent refund. Any unindexed surplus stays in the pool for reconciliation (`src/claim-amounts.mjs`).
> - The worker's claim recovery pass settles, rebroadcasts or aborts an uncertain pending claim (`src/claim-settlement.mjs`).
> - A graduated market's claim also pays the creator position's DAMM fees in the same transaction ([Graduated fees](GRADUATED_FEES.md)).
> - `repo_claims` gained the `aborted` status with its resolution fields (migration 0008), and the durable signed transaction, its last valid block height and the DAMM share of the amount (migration 0010).

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

## 2026-10-02: pasted payout addresses with a 48-hour hold

A verified GitHub admin can set the payout address by pasting it instead of connecting a wallet and signing the binding message ([user guide](USER_GUIDE.md#paste-a-payout-address)). Wallet-signature binding is unchanged and still takes effect at once. Code: `src/payout-address.mjs` (rules), `src/payout-address-policy.mjs` (shared constants, `PASTED_ADDRESS_HOLD_MS`), `app/api/payout-address/route.js`; migration `drizzle/0048_pasted_payout_address.sql`.

**Authority.** Paste and cancel use the same checks as every binding change: the encrypted GitHub session, an exact same-origin POST, a fresh GitHub admin answer for that repository (at most 60 seconds old, for the signed-in user) and its recorded `repo_verifications` row (at most five minutes old) inside the transaction, under the repository's advisory lock. A claim-page session acts only on its own repository; a Builders session acts on repositories it administers, each checked separately.

**Validation (server side).** Base58 text that decodes to a 32-byte key, canonical, on the ed25519 curve (the referral module's check; program-derived addresses are refused), not a known program, sysvar, native mint or the incinerator (the System Program id is itself on-curve), not one of repo.ing's own wallets (team, buyback, fee wallet, launch signer, partner, tip wallet), and the retyped last four characters must match exactly (a check against a wrong paste, not against clipboard malware that grinds a look-alike address; the hold, cancel and notice are the safeguards there). Then one `finalized` `getAccountInfo` read: a missing account passes; an existing account must be owned by the System Program, not executable, and hold no data (so token accounts, mints, programs and nonce accounts are refused). A failed read refuses the request with a retry message; nothing is guessed or saved. The per-repository rate limit (five requests an hour) is checked before any GitHub or Solana call.

**Hold and activation.** A pasted address is stored in `payout_address_requests` as `pending`. A database trigger stamps every insert: it starts pending, `requested_at` is the moment it is stored (database clock), `active_at` is at least 48 hours later whatever the writer supplied, and `replaces_bound_at` records the `bound_at` of the binding it would replace. It is never written to `repo_beneficiaries`, the only table any payout path (builder fees, graduated DAMM fees, the claim-all queue, tips, parts funds, the builder allocation) reads a recipient from, until `active_at` has passed. Then it becomes the binding with `method = 'pasted'`, its request id and a new `bound_at`, and the previous binding keeps receiving claims until that moment. If the binding changed after the request was stored (`bound_at` differs from `replaces_bound_at`), the newer binding wins and the request is superseded; that comparison is exact and never compares the app's clock with the database's. Activation happens in the claim path under the claim's repository lock, in a worker pass, and when the claim page or Builders dashboard loads (non-blocking). Database triggers reject a pasted binding that is not an activated, due request for the same repository, wallet and GitHub user; reject changes to a request's terms or any change to a resolved request; and reject activating a request before `active_at`.

**Replacing and cancelling.** At most one pending address per repository. A newer paste supersedes the waiting one and restarts the hold; a wallet-signature binding (single or batch) supersedes it at once. Any current admin can cancel a waiting address; once its hold has passed it is active and can only be replaced. A paste or cancel waits at most 10 seconds for the repository's lock (a claim holds it until its payout settles) and then answers 409 with nothing saved. Requests are never deleted, and `payout_address_events` (append-only) records who requested, cancelled or superseded each address, and each activation. Activation cannot re-check that the requester is still a GitHub admin (no token is stored); an organization that removes a compromised admin should also cancel that admin's waiting address.

**Identity marks.** A pasted address proves nothing about who holds it, so marks that read the payout wallet as the maintainer's own require a wallet-signature binding: the Official market mark, the maintainer's ✓ X handle on the token page and trust panel, "Maintainer's payout wallet" on the launcher (a pasted one is labelled "Pasted payout address"), and the Builder label (and exclusion from holder counts) in Backers. The verification-bonus review flags a launcher link when a pasted request names the launcher wallet; the automatic self-launch rule is unchanged, since a pasted address needs no key and could otherwise be used to deny someone else's bonus.

**Claim path and reviews.** The claim resolves its recipient under the repository lock: it activates a due address first, then reads only the active binding. A repository whose only address is still in its hold is refused (`…in its 48-hour hold until <time>. Claims open then.`). The review's recipient, binding time and paid revision are now checked before any chain read. Activation changes `bound_at`, so a review sealed for the previous recipient fails exactly as a wallet change always has, and nothing is paid. The batch wallet-signature setup treats a due pasted address as an existing payout address. The Official market mark requires a signature-bound wallet.

**Notice.** When builder reminders are configured, confirmed subscribers among the requester, the GitHub user whose binding would be replaced, and the author of a superseded waiting address get a "Payout address change requested" email at once (best effort; it never blocks or undoes the change).

### Local verification

New suites: `tests/payout-address.test.mjs` (no services: every validation rejection, the account check, the hold, recipient resolution, claim steps, identity marks, the notice) and `tests/payout-address-db.test.mjs` (PostgreSQL: authorization for paste, replace, cancel and batch; the rate limit before any GitHub call; the hold and every database guard, including stamped inserts; activation and its audit row; exact superseding by a binding stamped by a lagging clock; a busy lock refusing promptly; wallet signatures superseding a waiting address; the claim path refusing a waiting recipient and rejecting a review of the replaced recipient before any chain read; the HTTP route with stubbed GitHub and RPC). `tests/verification-bonus-db.test.mjs` checks the reviewer flag for a pasted launcher wallet.

The local validator claim suite adds a pasted-address payout: while a pasted address waited, a reviewed claim paid **24,850 lamports** to the signature-bound wallet and nothing to the pasted address. After the hold, the old review was refused with no balance change; a new review paid **24,850 lamports** to the pasted address (slot 373, receiver delta equal to the fee plus the SDK's wrapped-SOL rent refund), and reconciliation returned MATCH with zero remaining. Local signatures (not mainnet): `4Q9LE6beDicdHucTsWUhhEuAv1RY78bdux16f4PzQnLMcfbY3nxCTXQi3UifYwVUwSc1qpbbL2zjYLqz1iq5zYrr` (during the hold), `SotmQC5Ln1Z1crBMgTxxZiGRmjWtAY5ynxgjNhWDGh4mCCKAa1sWhqSXHa34vUxu8Xz6FZJTLKGYi8UddJv3HRL` (after it). The temporary ledger was removed after verification.

## Manual collection of unclaimed builder SOL fees

Migration `0078_builder_fee_collections` adds a distinct platform collection ledger. Production already applied the same SQL hash and timestamp under the local name `0077_builder_fee_collections`; the integrated journal preserves that identity without changing the applied database record. Owner entitlement is `builder_fee_credits - settled repo_claims - settled builder_fee_collections`; reconciliation, owner claims, signed owner reviews and public available balances include this debit. A pending collection blocks owner claims under the same repository advisory lock. A collection is never an owner payout or a partner-revenue allocation.

Collections are manual and repository-specific, including already-accrued fees. Each approval collects floor(current unclaimed DBC lamports / 2); the odd lamport stays for the owner. Repeated fresh approvals can take half the remaining DBC balance again, with no lifetime 50% limit. This path supports SOL-only ordinary DBC fees before or after graduation and refuses stock-paired and transfer-hook pools.

The reviewed `feeSource: "DBC"` identifies only the original curve's fees. Its earned amount comes from `fee_events`; owner-paid DBC fees are settled `repo_claims.amount_base_units - damm_amount_base_units`. DAMM credits and the DAMM portion of owner payouts are excluded, so graduated-fee accrual cannot inflate the collectible amount or invalidate a DBC-only approval. After graduation the exact withdrawal must still fit the curve's reconciled `creatorQuoteFee`. DAMM position fees are not collected: the installed program's position-fee claim has no amount argument and would claim the whole position. Remaining DBC and DAMM builder entitlements stay available to the normal owner-claim flow.

Use the protected web runtime, not an HTTP endpoint. Keep `BUILDER_FEE_COLLECTION_ENABLED=false` by default:

```sh
node scripts/collect-builder-fees.mjs review REPO_ID RECEIVER
BUILDER_FEE_COLLECTION_ENABLED=true node scripts/collect-builder-fees.mjs simulate REVIEW_ID TERMS_HASH
BUILDER_FEE_COLLECTION_ENABLED=true node scripts/collect-builder-fees.mjs claim REVIEW_ID TERMS_HASH --approve
node scripts/collect-builder-fees.mjs receipt REVIEW_ID
```

Simulation also requires the gate for that one command but does not broadcast. Review the exact SOL amount, receiver, retained owner balance and full terms before granting execution. Default receiver is buyback custody `FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy`; a custody transfer does not trade. Reviews expire after ten minutes, bind the exact state, and cannot be replayed after execution.

The creator signer pays network fees, receives only refunded temporary-account rent, and never receives the collected principal. Signed bytes and signature are persisted before broadcast. Primary and independent RPCs must agree on canonical finalized pool/config bytes and finalized transaction receipts, including exact destination credit, pool vault debit, source fee, closed temporary accounts and creator-fee event. Uncertain receipts remain pending; the worker recovers only already-signed intents without a creator key. Expiry proof reads finalized height and slot from the same epoch-info bank and requires signature history at least that fresh before abandoning an expired transaction.

Public policy: `/how-it-works#builder-collections`. `tests/builder-fee-collections.test.mjs` exercises real validator transfers, owner remainder, replay/staleness guards and keyless recovery with a disposable PostgreSQL ledger.

### Mainnet verification, 2026-10-15

One explicitly approved collection for repository `1332056763` (`dhh/omarchy-giants-theme`), mint `C1HJq5FFY9o63Evhz6V5nPkBQwFpaDvyykBFS32Lkt8C`, finalized in slot `457277173`: [transaction](https://solscan.io/tx/35iRQRLiUkhGCX2Tpfh4xnY8EcgdvywvwVXEt5yBNS8JuwcvhnN1b7Xqii3FoGUPwCmocK4cEKR3dKmtw7r9bvS1). Custody received exactly `1,358,933,298` lamports; `1,358,933,299` remained as the owner's unclaimed entitlement. Both finalized RPCs agreed, reconciliation returned MATCH, owner-paid total remained zero and partner fees remained `555,057,272` lamports. One collection settled, none remained pending, and the execution gate stayed off globally. No buyback trade was executed.

The providers returned identical receipt values with different JSON property order. Comparing serialized objects incorrectly kept the landed transaction pending. Recovery now uses `isDeepStrictEqual` for receipt fields: property order is irrelevant, but every balance, event/instruction value, fee, slot and signed message must still agree. The fixed service settled the existing signature without signing or submitting another payout. The recovery regression supplies reordered independent receipt keys and still rejects changed balances.

### Explicit exact-amount approvals

The default `review` still selects half the current balance. When an operator separately authorizes an exact amount and receiver, use `node scripts/collect-builder-fees.mjs review-exact REPO_ID RECEIVER LAMPORTS`, then the same simulation and explicit approval commands. Exact amounts must be positive integer lamports no greater than the reconciled unclaimed balance; they may include the entire remainder. The persisted `selection: "exact"` distinguishes this approval from the half-only default. Both balance and destination remain review-bound, and no automatic collection mode is enabled.

