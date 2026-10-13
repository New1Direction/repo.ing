# Maintainer claim funnel

[Documentation](README.md) / Claim funnel

Builder fees only reach open-source maintainers when a current GitHub admin finds the claim page, verifies, sets a payout wallet and claims. This page describes how maintainers are routed there, what each GitHub sign-in outcome shows, and how the funnel is measured. Payout rules are unchanged: every payout still re-checks current admin access and the on-chain fees ([claims](CLAIM.md), [GitHub authority](GITHUB_VERIFICATION.md), [wallet binding](WALLET_BINDING.md)).

## Discovery

| Entry point | Where it leads | `?src=` |
| --- | --- | --- |
| `/waiting` row: "I'm the maintainer → Claim" | `/claim/<repo>` | `waiting` |
| `/waiting` row: "Tag them on X" (the post's link) | `/claim/<repo>` | `x` |
| `/waiting` header: "Maintainer? Find your fees" | `/builders?owner=<name>` | — |
| Operator GitHub issue invite (`/operations/invites`) | `/claim/<repo>` | `invite` |
| Token page "Invite repository owner" text | `/claim/<repo>` | `share` |
| Token page hero, earnings card, trust panel, details link | `/claim/<repo>` | `token` |
| Builder dashboard row "Manage" | `/claim/<repo>` | `builders` |
| Owner lookup result | `/claim/<repo>` | `lookup` |
| Link a non-admin copies for an admin | `/claim/<repo>` | `admin` |

`?ref=` stays the wallet referral (`app/lib/referral.mjs`); attribution uses `?src=`, and only the values above are accepted (`app/lib/claim-funnel.mjs`). The source travels through GitHub sign-in inside the sealed OAuth state cookie and comes back on the claim page.

**Owner lookup.** `/builders?owner=<GitHub user or organization>` lists every GitHub market for that owner, largest unclaimed first, with no sign-in (`app/lib/owner-lookup.mjs`). It uses the shared market list: the same indexed builder fee credits minus settled claims that Explore and `/waiting` show. It finds repositories the dashboard cannot list yet because they have not been shared with the GitHub App. The claim page still checks the chain before any payout. A signed-in dashboard with no repositories links to the lookup for the signed-in login.

## Claim page

- **Next step first.** While fees are waiting and the claim is not ready, the claim page states the amount, the repository and the next action (give the GitHub App read-only access, verify with GitHub, or set a payout wallet), with the verify button beside it.
- **Before verifying.** Three facts under the checklist: read-only GitHub metadata access (repo.ing cannot change code); no seed phrase or private key is ever asked for, and setting a wallet is a signed message, not a payment; participation is optional and a community-created market does not imply endorsement. The existing disclosures (SOL settlement, USD estimates, receipts only after settlement) are unchanged.

## GitHub verification outcomes

`app/api/github/callback/route.js` classifies the sign-in with `verificationOutcome` and returns to the claim page with:

| Outcome | Cause | `?error=` | Claim page |
| --- | --- | --- | --- |
| Verified | Current admin | — (`verified=1`) | Continues to the payout wallet step |
| Not an admin | GitHub confirmed the account; permission is maintain, write, triage, read or none | `not-admin` (with `github` and `permission`) | Names the account and its access; copies a claim link for an admin (`?src=admin`); explains switching GitHub accounts (sign out at github.com, verify again). No session is kept. |
| Cancelled | GitHub returned `error=access_denied` | `github-cancelled` | "Nothing was verified or shared", Verify with GitHub again |
| Failed | Anything else (GitHub or network error, state mismatch, repository not public, market not indexed) | `verification-failed` | "Usually temporary", Verify with GitHub again |

The `github` and `permission` values are re-validated on the page (a login pattern and GitHub's permission names); anyone can type them into a URL, and they only change that person's own view. The builder dashboard shows the cancelled message for `github-cancelled`; other identity sign-ins (opt-out, contributor wallet, handoff, credits) keep `verification-failed`.

## Measurement

**Events** (`funnel_events`, migration `0070`, `src/funnel-store.mjs`). Each row is an event, an optional source and outcome from fixed lists, and an optional public repository id. No login, GitHub user id, wallet, cookie, URL or IP is stored. Rows older than 180 days are deleted by the web service (at most hourly per process).

| Event | Recorded by |
| --- | --- |
| `claim_view`, `builders_view`, `waiting_view` | Browser beacon on page view (`app/components/funnel-beacon.jsx` → `POST /api/funnel`, strict shape, rate-limited per client key hash and globally) |
| `verify_start`, `app_access_required` | `/api/github/start` |
| `verify_result` (`verified`, `not-admin`, `cancelled`, `failed`) | `/api/github/callback` |
| `builders_connect`, `builders_result` | Dashboard GitHub sign-in |
| `owner_lookup` (`found`, `none`) | `/builders?owner=` |

Recording is best effort: a failed write never changes a redirect or a page.

**Ledger funnel.** Verification, payout wallet and payout stages come from the existing ledgers, not from events: canonical GitHub SOL markets with indexed builder fee credits → an admin verification recorded (`repo_verifications`) → a payout wallet (`repo_beneficiaries`) → at least one settled claim (`repo_claims`), with SOL earned, paid and still waiting for a maintainer (no verification and no wallet, as on `/waiting`). Outside builders and team repos are split as on [/stats](ANALYTICS.md).

**Operator view.** `/operations/funnel` (platform operators only, linked from `/operations/health`) shows the ledger funnel, event counts for 24 hours, 7 and 30 days, and views → verified by source for 30 days.

## Deploying

Migration `0070_funnel_events` is additive (one new table and index) and runs in web's pre-deploy `npm run db:migrate`. The worker does not read it. Before the migration is applied the web service still serves every page; event writes fail quietly and `/operations/funnel` shows "temporarily unavailable".

## Verification

`tests/claim-funnel.test.mjs` (quick suite) covers sources and links, outcome classification, the callback's redirects and recorded events, beacon validation, the store and its ledger query parameters, the migration and schema, the owner lookup, and the claim page's next step, trust notes, not-admin, cancelled and failed states.
