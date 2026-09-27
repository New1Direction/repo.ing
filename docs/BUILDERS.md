# Builder dashboard and recent payouts

> This report covers the original dashboard release. The shared claim path was subsequently extended to graduated DAMM builder fees; see [Graduated fees](GRADUATED_FEES.md). For current instructions, use the [User guide](USER_GUIDE.md).

2026-09-25

## User flow

`/builders` is available from the main navigation and individual claim pages. Connect GitHub once to see tokenized public repositories where the current GitHub account has admin permission. Three totals show available fees, lifetime earned and lifetime paid. An unavailable balance is not represented as zero.

Repositories without payout wallets can be set up together, with one wallet message listing each immutable repo ID, nonce and expiry. At most 100 repositories are included in one setup message. Existing payout wallets are never overwritten by this action; use the individual claim page to change one explicitly.

The page shows the exact ready total and saved recipients before the user clicks **Claim all ready fees**. This starts independent claims, at most two at a time, with per-repository pending, paid, attention-needed and receipt states. A problem with one repository does not hide another's successful payout. Individual Claim buttons remain available. The browser must remain open to submit the remainder of its queue; already submitted transactions have durable database intents. Refresh retrieves current balances and pending signatures. No background scheduling or automatic retries were added.

`/stats` now lists the ten most recent completed builder payouts: repository, SOL amount, current USD estimate, UTC settlement time and transaction receipt. Pending, aborted and non-canonical/non-indexed records are excluded. Wallet addresses are not included in that public feed query.

## Authorization and accounting

- Dashboard OAuth identifies the user; it does **not** record a blanket admin grant. The existing encrypted, Secure, HttpOnly, same-site one-hour session is retained. Legacy repo-scoped sessions can also enter the dashboard, but all protected actions still perform fresh authority checks.
- Repository discovery paginates GitHub's `GET /user/repos`, filters current public, unarchived, admin-access repositories, and matches immutable IDs to canonical indexed markets. GitHub documents Metadata read for this user-token endpoint: <https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user>. There are no new GitHub App permissions.
- Before each wallet challenge, batch binding and payout, verify the current GitHub user ID, immutable repository ID and current effective admin permission using the existing verifier. The listing is for discovery, never payout authorization.
- Batch wallet signatures are domain-separated and cover the Solana chain, GitHub user ID, wallet, every repo ID, nonce and expiry. Verification, one-time consumption and inserts occur in one database transaction under sorted per-repo locks. A changed existing wallet, invalid/subset signature, stale authority, expiry or replay rejects the batch without partial bindings.
- Each claim requires an exact same-origin POST and a signed review bound to the session, GitHub user, repo ID, saved recipient/binding timestamp, cumulative paid revision and exact approved amount. Dashboard reviews expire after at most 30 minutes, bounded by the GitHub session, to accommodate longer queues. Individual claim reviews retain their existing ten-minute limit.
- Each payout uses the original canonical DBC claim path, current GitHub check, reconciled ledger, per-repo lock, simulation, durable signature before broadcast and finalized recipient receipt before settlement. A queue review caps the transfer to its approved amount; later earnings remain in the pool. A paid revision or binding change invalidates the old review.
- Each successful claim has its own transaction, not one large atomic transaction. A failed/uncertain request is never blindly resubmitted. Pending signatures block new payouts; an already-settled review is reported separately.
- No schema migration, permission increase, new signer or worker change is required. This remains the DBC creator-fee path; it does not implement DAMM post-graduation claims.

## Verification

30 focused checks passed: five dashboard/session/queue unit tests, three existing encrypted-session/CSRF tests, two new batch-binding database tests, six GitHub verification tests, four existing wallet-binding tests, nine local-validator claims tests, and one payout-feed database test. The production build and `git diff --check` passed.

The local-validator queue paid 49,700 lamports from repo `1384142609` and 99,400 lamports from repo `1384142610`, to the saved wallet. Each received the reviewed amount plus the SDK's temporary wrapped-SOL rent refund. The first pool retained 49,700 unreviewed lamports. Both reconciliations were MATCH; replaying either review was rejected.

Local signatures (not mainnet):

- `2WvFRu9p1bwAhUCL89rG52SvX4BCqcR4uTB6iHPH1xRLfUaQYEhQq4xboJEjUjCjTdzCAGgmxaUhncs98kKYeaYg`
- `53pCVgv52teR4RiXMsvYPSc4Zot5a1WjtsdunZ3dexVaVTEvP8astmuaqmmjcdJr5eJmA41dAWWHhWAF9qjir5Jg`

Synthetic browser checks covered ready/unbound/unavailable/pending repositories, a claim-all run with one success and one permission failure, preserved receipts, desktop and 390px mobile layouts in light/dark themes, and no mobile horizontal overflow. The temporary QA route was deleted before the release build. Local API checks returned 401 without a session, 403 for invalid/cross-origin claim reviews and 400 for cross-origin binding, all with private/no-store responses.

No real wallet signature or mainnet payout was submitted during this implementation. Authenticated production dashboard discovery and a real claim-all run require the repository owner's GitHub session and explicit use of the live UI.

## Production release

Implementation commit `04e9751`. Railway web deployment `dede1c1b-0cdf-4740-a5e6-2a55d659ed91` succeeded. Live `/builders` and `/stats` returned HTTP 200; the former displayed the GitHub connection entry and the latter the recent payout feed. The unauthenticated dashboard API returned 401/private/no-store, GET on the payout mutation returned 405, and the removed QA route returned 404. The dashboard OAuth start returned the correct GitHub authorize endpoint and production callback with state present. Existing Backpack restored to the user's connected wallet on the live builder page.

Temporary local PostgreSQL and validator services were stopped and their disposable data directories deleted after verification.

The live Stats feed rendered three existing settled receipts: OHIYO and two OntologyEX payouts, each linked to its Solscan transaction. At 390px the live page had no horizontal overflow; Backpack remained connected after navigating from Builders to Stats. The browser QA TaskSpace was closed after verification.
