# Market speed and creator claim flow

2026-09-25 · implementation commit `300d5cc`.

## Changes

- Token pages render stored repository information and trading controls before GitHub metadata, SOL/USD conversion, or creator-fee reconciliation complete. Independent Suspense boundaries refresh repository details and earnings. Public metadata refreshes are deduplicated, bounded to 500 entries, and reused for five minutes; they never authorize payments.
- Mint and repo lookups query only the selected canonical market instead of calling the full market list. React render-scoped caching deduplicates metadata/page reads. The returned per-repository amounts match the existing aggregate query in the database regression test.
- Chart, bonding-progress and wallet-balance display polling pauses in hidden tabs and resumes immediately on return. Signed-transaction settlement/recovery polling continues. The MetaMask integration loads when the wallet picker opens or a previously selected MetaMask wallet needs reconnection.
- Claim pages stream the repository shell, then load independent status checks concurrently. The UI shows available SOL and approximate USD, one active step, collapsed completed steps, explicit payout-wallet changes, pending states and a settled receipt. The existing README badge is offered after a successful payout.
- A bounded encrypted GitHub user session removes the second OAuth trip while preserving fresh current-admin checks. Payouts require a same-origin POST and a signed, expiring review. See [claim safety and concurrent trading](CLAIM.md#2026-09-25-progressive-claim-review-and-session-reuse).
- “Invite repository owner” on launch success and unclaimed builder earnings opens a copy/share invitation containing a direct claim link and current reconciled fees when available. Unknown fees are explicitly unknown. No messages or GitHub issues are sent automatically.

## Verification

31 focused checks passed: 8 local-validator payout checks, 10 GitHub authority and signed-wallet checks, 12 encryption/session/polling/wallet/progress checks, and one database market-isolation check. Final local reconciliation matched: 198,800 lamports earned, 198,800 paid, zero remaining. The production build and `git diff --check` passed.

Synthetic browser checks covered GitHub verification, wallet setup, payout review, settled receipt, badge availability, owner invitation, and remembered-wallet restoration across full navigations. Desktop and 390px mobile layouts were checked visually; the mobile review and invitation had no horizontal overflow. The local payout route returned 403 for a cross-origin request and 303 back to verification for an expired/invalid review. The temporary UI route was removed before the final build; the temporary validator and database were stopped and deleted (about 2.3 GB).

Automatic approval review rejected exporting production payout rows into a local test fixture. No export occurred. Synthetic records were used instead.

## Response timings

These are three ordinary public HTTPS GETs from this Mac, with no browser throttling. They measure first byte and full streamed response, not mobile Core Web Vitals or a throughput/load test.

Before deployment:

| Page | First byte, seconds | Complete response, seconds |
| --- | --- | --- |
| SKILLS market | 0.820, 0.780, 0.820 | 0.827, 0.791, 0.832 |
| SKILLS claim | 0.217, 0.291, 0.257 | 1.184, 1.176, 1.256 |

After successful Railway web deployment `f63d493a-b485-40c2-87a7-ec25fe796837`:

| Page | First byte, seconds | Complete response, seconds |
| --- | --- | --- |
| SKILLS market | 0.424, 0.295, 0.496 | 1.082, 0.303, 0.574 |
| SKILLS claim | 0.337, 0.332, 0.292 | 0.754, 0.708, 0.691 |

Market median first byte fell from 0.820s to 0.424s (about 48%). The claim page already streamed an early shell; its complete-response median fell from 1.184s to 0.708s (about 40%). The first market response after deployment still took 1.082s to complete background data. These samples are directional observations, not a performance guarantee.

Live browser checks confirmed the SKILLS market, the invitation with its reconciled 0.00185892 SOL available at the check, and the OntologyEX claim page with 0.000695526 SOL lifetime earned/paid and zero available. Both had no horizontal overflow at 390px. `GET /api/claim` returned 405 and `/claims-qa` returned 404. The GitHub verification entry opened the correct repo.ing App authorization flow, but this browser was signed out of GitHub; an authenticated production return and a new mainnet payout were not exercised.

The live Backpack connection restored to the same wallet after full navigation. The wallet picker showed Phantom, Backpack, and MetaMask; opening it loaded two additional script resources (12 before, 14 after). Closing it preserved the existing Backpack connection. The picker had no mobile horizontal overflow. The QA TaskSpace was closed after verification.
