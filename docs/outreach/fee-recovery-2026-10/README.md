# Maintainer fee-recovery campaign, October 2026

[Documentation](../../README.md) / [Claim funnel](../../CLAIM_FUNNEL.md) / Fee-recovery campaign

**Status, 2026-10-13: prepared, nothing sent.** These are operator and outreach assets for the [maintainer claim funnel](../../CLAIM_FUNNEL.md). They do not change it. Each message is posted by hand by a repo.ing operator after the checks below. No script here posts, emails or records anything.

## Why these three

At 2026-10-13 16:16 UTC, 60 GitHub repositories had builder fees with no verified admin and no payout wallet. Together they held **26.28 SOL** (≈ $2,828 at $107.62/SOL). Only three are at or above the operator invite threshold, `MAINTAINER_INVITE_MIN_SOL` (default 0.5 SOL, `src/maintainer-invites.mjs`). The campaign does not lower it.

| # | Repository | Unclaimed (on-chain check) | Share of all waiting | Notes |
| --- | --- | ---: | ---: | --- |
| 1 | [KingKongRobotics/jumper](https://github.com/KingKongRobotics/jumper) | 19.78 SOL | 75.3% | Graduated, still trading (48 SOL volume in 24 h), so it keeps growing. **Launched by the repo.ing team wallet.** 10,000,000 JUMPER builder allocation available |
| 2 | [dhh/omarchy-giants-theme](https://github.com/dhh/omarchy-giants-theme) | 2.72 SOL | 10.3% | Community launch, no trades in 24 h |
| 3 | [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) | 0.6986 SOL | 2.7% | Community launch, no trades in 24 h |

Together the three hold 88.3% of everything waiting. Each amount is the claim page's own on-chain check (`GET /api/claim/<id>/preview`), and each matched the indexed figure on `/waiting` exactly. The next ten repositories, 0.10–0.46 SOL each, are listed in [the tracker](tracker.csv) as **hold**. Contact one only after it crosses the threshold and appears in `/operations/invites`. The full ranking and its sources are in [snapshot-2026-10-13.json](snapshot-2026-10-13.json).

Excluded: New1Direction team repositories (verified, wallet set) and one Hugging Face model (0.011 SOL). Also excluded are three markets that `/waiting` hides because their maintainers declined contact or opted out (repository ids 1181927, 162625122 and 1103012935). **Never contact those three.**

## Public contact routes (checked 2026-10-13)

Only routes the maintainer publishes for contact are used. The tracker records the URL where each route is published, never a copied address or phone number.

| Repository | Owner | Issues | Earlier repo.ing contact | First contact | One follow-up | Not used |
| --- | --- | --- | --- | --- | --- | --- |
| jumper | Organization (KingKong Technology, Beijing), not archived | On, no templates | None in its 10 issues and PRs | GitHub issue, English + Simplified Chinese | The company's general contact email, published at [kingkong.tech/contact](https://kingkong.tech/contact) and on the [org profile](https://github.com/KingKongRobotics) | Sales staff phone numbers and WeCom on the site; individual contributors (zhiyishou, tianrking, xuyutao08) |
| omarchy-giants-theme | User, not archived | On, no templates | None in its 22 issues and PRs | GitHub issue | The email on the [GitHub profile](https://github.com/dhh) | X (@dhh): a public tag reads as promotion |
| pstack-claude | User, not archived | On, no templates | None in its 266 issues and PRs | GitHub issue (the only public route) | None | The profile website, which is an employer's site; the security advisory form, which is for vulnerabilities |

None of the three READMEs mentions tokens or crypto, and none says it has "no official token". Re-check this before sending (step 2).

## Rules for every message

- **Who made the market.** Say "someone in the community" only when the launcher is not a published repo.ing wallet. **jumper's launcher is the team wallet `4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce`** ([REPO_IDENTITY.md](../../REPO_IDENTITY.md)). At 2026-10-13 it held 40,014,439.95 of 999,935,419.67 JUMPER (4.00%). Its draft says this, and says that until graduation the launching wallet was eligible for a capped share of the platform fee (the discovery reward). Do not use the `/operations/invites` text for jumper: it says the community created the market.
- **Amounts.** Fill amounts only from the script's output at send time, with the check time stated. Amounts are in SOL, never USD alone. Never promise an amount, a price or a payout date.
- **No endorsement.** Never say or imply that a maintainer, project or company endorses or partners with repo.ing. Do not ask anyone to promote, hold or buy a token.
- **Security.** Never ask for a seed phrase, private key or payment, and never offer to claim on someone's behalf. Only a current GitHub admin can claim, to a wallet they set.
- **Leaving.** Every message offers a no-action option, says how to decline the market at `/opt-out` or on the claim page, and promises not to contact them again.
- **Contact limits.** One issue per repository and at most one follow-up, on the listed route only. No X tags, DMs or contact with individual contributors.
- **Privacy.** Nothing private goes into this folder: no email addresses, phone numbers or reply contents. The tracker is in a public repository.

## Runbook

**0. Deployment gate (each sending session).** Run `node scripts/ops/fee-recovery-check.mjs`. It sends nothing and records no funnel event. It passes only when production serves the claim funnel: `GET /api/funnel` answers 405 rather than 404, and the claim page carries the `claim_view` beacon. **If it prints `FAIL` (exit 2), stop.** Nobody is contacted until the funnel from `1e6d8d1` or later is deployed ([Deploying](../../CLAIM_FUNNEL.md#deploying)). On 2026-10-13 at 16:16 UTC the gate passed. The live claim page for jumper showed the funnel's next step and trust notes.

**1. Refresh.** `node scripts/ops/fee-recovery-check.mjs --render` reprints each target as one of three states:
- `READY`: the on-chain amount is at or above `MAINTAINER_INVITE_MIN_SOL`, read from the environment, default 0.5.
- `HOLD`: below the threshold. Do not contact.
- `CHECK`: the check failed. Do not contact until it passes.

For each READY target it renders the drafts with the amount, the check time and the attributed claim link filled in. Fill the remaining `{{…}}` fields by hand.

**2. Per-target checks before sending.** Skip the target if any check fails.
- It appears in `/operations/invites`. That page applies opt-outs, the participation flag, dismissals, the 30-day snooze and its own chain check, and production may set a higher threshold. If it is not listed, do not send.
- The repository is public, not archived, and has issues on. Its README and recent issues have no new "no token" or "do not contact" statement. Nobody has already opened a repo.ing issue on it.
- Its token page does not show "declined", and `/waiting` still lists it.
- **jumper only:** fill `{{team_jumper_share}}` with the team wallet's current share of supply:

  ```bash
  RPC=https://api.mainnet-beta.solana.com MINT=HbtGZge2NcfrrmBGx2Pqf9qgrNvMa63hQHVqcWSPuNub TEAM=4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce
  held=$(curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":["'$TEAM'",{"mint":"'$MINT'"},{"encoding":"jsonParsed"}]}' | jq '[.result.value[].account.data.parsed.info.tokenAmount.uiAmount]|add // 0')
  supply=$(curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["'$MINT'"]}' | jq .result.value.uiAmount)
  awk -v h="$held" -v s="$supply" 'BEGIN { printf "about %.2f%%\n", 100 * h / s }'   # e.g. "about 4.00%"
  ```

  If the wallet has sold out, say "held none". Keep the sentence either way. Also re-check the builder allocation line: `GET /api/allocation/1391948723` should return `"state":"available"`.

**3. First contact.** From an operator GitHub account that names repo.ing on its profile, open a new issue on the repository. Paste the rendered `*-issue.md`: its title line, then the body. Then press **Invited** on that row of `/operations/invites`. This starts the 30-day snooze, and the page does not post anything itself. In [tracker.csv](tracker.csv), record `gate_checked_at`, `contacted_at`, `issue_url` and `follow_up_due` (contact date + 7 days), and set `status` to `contacted`.

**4. One follow-up.** Only where the tracker lists a secondary route. Wait at least 7 days with no reply or reaction on the issue and no verification, then send the rendered `*-email.md` once, by hand, from a repo.ing address. Fill `{{issue_url}}` and `{{issue_date}}`. Set `status` to `followed-up`. There is no third message: after 30 days without a reply, set `status` to `closed: no reply`.

**5. Replies.**
- *Not interested, or stop:* press **Dismiss** in `/operations/invites`. It is permanent and hides the repository from `/waiting`. Thank them, and close the issue if it is ours. Point them to `/opt-out` only if they ask how to decline the market. Set `status` to `closed: declined`.
- *Questions:* answer only from the docs ([user guide](../../USER_GUIDE.md#claim-builder-fees), [claims](../../CLAIM.md), [GitHub authority](../../GITHUB_VERIFICATION.md)). If unsure, say so and follow up. Never speculate about price.
- *A non-admin replies:* the claim page gives them a link to forward to an admin (`?src=admin`). Do not add other people.
- *Hostile, or saying the market misuses their name:* reply once politely, dismiss, and escalate to the owner. Do not argue in the thread.
- Record the reply as a category only (`question`, `declined`, `claimed`, `hostile`). Email contents are never copied here.

**6. Measure.** `/operations/funnel` counts claim-page views, verification starts and verified results by `?src=` over 30 days. Issue links carry `?src=invite`, which only operator invites use. Email links carry `?src=share`, which the token page's "Invite repository owner" text also uses, so email attribution is approximate. Per repository, the source of truth is the ledger: rerun the check script, where a claimed repository's next claim drops toward zero, and look at `/waiting` and the token page. Do not run `/builders?owner=` lookups to monitor targets: each lookup records an `owner_lookup` event and skews that count.

**7. Stop the campaign** if any of these happens:
- the deployment gate fails;
- a claim or verification bug is reported;
- a target or GitHub objects to the outreach channel;
- anything here turns out to be inaccurate. Fix the draft before sending again.

The campaign ends when each target is claimed, declined or closed. Record the result in the tracker and the totals in this file.

## Files

| File | What it is |
| --- | --- |
| [targets.json](targets.json) | Targets, channels, `?src=` per channel and draft paths, read by the check script |
| [tracker.csv](tracker.csv) | One row per target and hold repository: channels, attributed links, status and dates |
| [snapshot-2026-10-13.json](snapshot-2026-10-13.json) | Ranked public snapshot (all 60 waiting repositories) and its sources |
| [drafts/](drafts) | Issue and email drafts with `{{placeholders}}` |
| [`scripts/ops/fee-recovery-check.mjs`](../../../scripts/ops/fee-recovery-check.mjs) | Read-only gate, refresh and render |

Attributed claim links use the existing sources only: `invite` for GitHub issues and `share` for the follow-up email (`app/lib/claim-funnel.mjs`). An outreach-specific source would need a change to the funnel itself, which is out of scope here.
