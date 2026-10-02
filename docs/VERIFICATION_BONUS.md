# Verification bonus

**Approved by the owner on 2026-10-01:** launchers get a **one-time 0.25 SOL bonus**, paid from platform revenue, when the repository's maintainer verifies within **30 days** of the launch. The goal is that launchers pick repositories whose owners will actually show up, and go recruit them.

The feature ships dark. Enrollment starts only when `VERIFICATION_BONUS_LAMPORTS` is set, and payouts start only when `VERIFICATION_BONUS_PAYOUTS_ENABLED=true`. Every bonus is reviewed by an operator before it is paid.

## Rules (rules version 1)

**Enrollment.** When the server reserves a **new** launch, it stamps `markets.verification_bonus_lamports` with `VERIFICATION_BONUS_LAMPORTS` (expected `250000000`). This follows the same pattern as `discovery_version`. The stamp on each market is its policy: changing the variable later affects only later launches. Existing, submitted and recovered markets are never enrolled retroactively. A value outside 0.001–1 SOL is treated as unset, so a typo cannot promise 2.5 SOL. `/operations/bonuses` shows that error.

**Trigger.** The bonus is decided once, from the repository's **first** admin verification: the earliest `repo_verifications` row with `permission = 'admin'`. Later verifications, by the same or another admin, never re-open the decision.

A bonus is **eligible** only if every rule passes. Each failing rule is recorded on the bonus as `ineligible`, with the rule's own wording as the reason, so operators and the launcher can see why:

| Rule | Passes when | Evidence |
| --- | --- | --- |
| Window | First verification at or after the DBC pool's activation point, and strictly before activation + 30 days | `markets.launch_block_time`: the finalized pool's `activationPoint`, the same clock discovery rewards use. Bonus-stamped markets record it even without discovery. |
| Not a self-launch | The repository's current payout wallet is not the launcher wallet, **and** the verifying GitHub user has never bound the launcher wallet for any repository | `repo_beneficiaries` (current bindings) and consumed `wallet_binding_challenges` (every wallet that user ever signed for) |
| Repository age | Created at least 30 days before activation | GitHub `created_at`, read by immutable repository ID at accrual time (the database stores no creation date) |
| Stars | At least 10 stars when the bonus accrues | GitHub `stargazers_count`, same read |
| Outside interest | At least **1 SOL** of curve (DBC) volume from wallets other than the launcher, traded before the verification | `trade_events.trader` (recorded for every trade since migration 0026: the swap's user, or the fee payer on aggregator routes). Rows with no recorded trader are reported but never counted. |
| Not declined | The maintainer has no active decision to decline the market or opt the repository out ([maintainer opt-outs](../src/maintainer-opt-outs.mjs)) | `maintainer_opt_outs` (active rows). Declining a market records an admin verification, so a maintainer who shows up only to turn the market down never earns the launcher a bonus. |
| Still public | GitHub still serves the repository publicly | A 404, 410 or 451, a 403 "repository access blocked", or a private repository is a decision (ineligible). Any other GitHub failure (an outage, a rate limit) is retried. |

**At most one bonus per market** (the primary key is the repository ID). A decided market is never re-evaluated. A bonus that fails **only** the volume rule is not decided until two hours after the verification. That gives the trade index time to catch up on trades made before the verification, because idle markets are indexed every few minutes and outages back off further.

### Why these rules

- **Declines.** The point is maintainers who show up to take part. A decline is the opposite, and because declining verifies the maintainer, it must not count. Approval and payment re-check the decision, so a decline made after accrual blocks the bonus until it is withdrawn.
- **Self-launch.** The cheapest abuse is launching your own repository and verifying it yourself. A maintainer who binds the launcher wallet, now or ever, to any repository has proven they control it. Approval and payment re-check this against the bindings at that moment, so a wallet bound after accrual still blocks the bonus.
- **Age and stars.** These rules make it expensive to create a throwaway repository just to farm the bonus.
- **Outside volume.** At least one other person has to care about the market before the maintainer shows up. Wash volume is possible, but trading 1 SOL costs real fees (the 1.75% curve fee in each direction), and the reviewer sees the wallet breakdown.
- **30-day window.** The incentive is to recruit the maintainer promptly, while the market is new.
- **Operator review and a rolling cap.** A determined abuser with an aged, starred repository and separate wallets can pass every automated rule. Review is the human backstop, and the cap (default 5 SOL per 30 days) bounds the worst case.
- **Fail closed.** Unknown trader attribution never counts. A GitHub outage creates no row and is retried. Malformed payout limits stop payouts. A payout that cannot be proven landed is never replaced. Missing rule inputs (wallet or volume facts) throw instead of passing.

## Flow

1. **Accrual (worker).** About every 60 seconds, the worker looks for stamped, finalized markets that have an admin verification and no bonus row yet. It waits until the first verification is **10 minutes** old, because maintainers usually bind a payout wallet right after verifying and the self-launch rule should see that binding. It evaluates the local rules first and reads GitHub only if they pass. It inserts one row: `pending_review`, or `ineligible` with the reasons. The insert uses `on conflict do nothing`, so concurrent workers are harmless. An undecided repository is retried with a growing delay (1, 2, 4… minutes, up to an hour), so one that keeps failing cannot starve newer ones. A worker pass is more robust than accruing in the OAuth callback: it retries GitHub, honours the grace period, and catches every path that records a verification.
2. **Review (`/operations/bonuses`).** Access is the same as the other operations pages: a GitHub session whose immutable user ID is in `PLATFORM_OPERATOR_GITHUB_IDS`. For each pending bonus the page shows:
   - the repository (GitHub link, stars when checked and now, age at launch);
   - the launch and verification times, and the verifier's GitHub login;
   - the launcher wallet and the repository's payout wallet, flagging any wallet link;
   - curve volume: from other wallets before verification, the launcher's own, unattributed, and all-time.

   **Approve** re-checks the wallet link and the maintainer's decision (the page flags an active decline). **Reject** needs a reason of 3–300 characters. The reason is kept for operators only; launchers and visitors see "not approved after review", because a free-text reason (for example, suspected wash trading) is not something to publish on a token page.

   An approved bonus can still be rejected while no payout is in flight or settled; the row keeps who approved it and who rejected it. Every decision carries the amount and launcher wallet the operator saw, and the server refuses a decision on anything else.

   Decisions and payouts take one advisory lock without waiting. If another bonus operation holds it (a payout broadcast lasts up to about 12 seconds), the action is refused with "in progress; try again", and the worker skips that pass.

   The wallet-link check only sees bindings that exist. When the page flags "Maintainer has no payout wallet yet", an operator may wait for the maintainer to set one before approving. Nothing expires while a bonus waits for review.
3. **Payout (web, only when enabled).** With payouts on, **Approve** pays immediately. Bonuses approved while payouts were off show a **Pay** button. Any refusal (cap, funding, fees) leaves the bonus `approved`.
4. **Settlement.** The worker (no key) settles or rebroadcasts the signed payout until finality; **Check status** does the same from the page. The bonus becomes `paid` in the same database transaction that settles the payout.

The launcher sees the state in the token page's launcher-rewards card and on `/wallet`: offered (with the exact verification deadline in UTC), checking, "earned, in review", approved, sending, paid (receipt link), "ineligible: reason", "not approved after review", or not earned. The launch page states the rules in one line. `/stats` shows the total paid once the first bonus settles.

## Payout

The payer is the **protected partner signer** (`PLATFORM_PARTNER_SECRET_KEY`, web only), the same key that pays discovery-claim network fees. The transaction is a plain `SystemProgram.transfer` of exactly the bonus, from the partner to the launcher wallet. A memo names the bonus: `repo.ing verification-bonus:v1:<repo id>:<attempt> payout <uuid> lamports <amount>`. The partner is the only signer and the fee payer.

Before signing, the server requires all of the following, under the one advisory lock that serializes every bonus decision, payout and settlement:

- payouts are enabled and their limits are well formed;
- the bonus is `approved`;
- the amount and launcher wallet equal both the market's stamp and the operator's view;
- there is no wallet link, and the maintainer has no active decline or opt-out;
- the rolling cap holds: settled payouts in the last 30 days plus every in-flight payout plus this one stay within `VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS`;
- the RPC reports Solana mainnet's genesis (local validators are allowed only for tests);
- the launcher wallet is not the payer;
- the network fee is at most 0.000805 SOL (one signature plus the bounded priority fee) and below a twentieth of the bonus;
- after paying, the payer still holds everything it must not spend:
  - every payout still in flight from it, counted as already spent;
  - the platform revenue the ledger says it holds for other uses: settled claims it received that are not yet allocated, plus the liquidity share allocated from those claims and not yet deployed (read-only; the 60/20/20 ledger is unchanged);
  - `VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS` as an operating float;
- a simulation with signature verification succeeds.

Money discipline matches discovery claims:

- **Durable intent.** The fully signed bytes, signature and last valid block height are committed as `pending` **before** the first broadcast. Landing uses the shared helpers in `src/trade-landing.mjs`: priority fee, compute limit, rebroadcast.
- **Never twice.** A partial unique index allows one `pending` or `settled` payout per bonus, and each attempt has a unique idempotency key. Paying again returns the existing payout and never signs a second one.
- **Exact receipt.** `settled` requires the successful finalized transaction matching the saved message, the launcher's balance rising by **exactly** the bonus, and the payer's balance falling by **exactly** the bonus plus the network fee. Anything else stays `pending` and is reported for review; the worker exits non-zero.
- **Recovery without blind re-sends.** Recovery only rebroadcasts the saved bytes. An attempt is `aborted` only on a finalized failure, or on provable blockhash expiry with no transaction in finalized history. A processed or confirmed status is never aborted. After an abort the bonus stays `approved` and can be paid again (attempt *n*+1).

## Environment

| Variable | Service | Default | Meaning |
| --- | --- | --- | --- |
| `VERIFICATION_BONUS_LAMPORTS` | web | unset (no enrollment) | Amount stamped on each new launch, in lamports; 0.001–1 SOL. Expected `250000000`. |
| `VERIFICATION_BONUS_PAYOUTS_ENABLED` | web | `false` | `true` lets operators pay approved bonuses. While off, approved bonuses wait as `approved`. |
| `VERIFICATION_BONUS_MAX_PER_30D_LAMPORTS` | web | `5000000000` (5 SOL) | Rolling 30-day cap: settled plus in-flight payouts. `0` pauses payouts. A malformed value stops payouts. |
| `VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS` | web | `50000000` (0.05 SOL) | Operating float the payer keeps after each payout, **on top of** in-flight payouts and the unallocated and liquidity revenue it holds. |
| `PLATFORM_PARTNER_SECRET_KEY` | web only (existing) | — | The payer. Never give it to the worker or a `NEXT_PUBLIC_` variable. |
| `PLATFORM_OPERATOR_GITHUB_IDS` | web (existing) | — | Who may review and pay. |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_APP_INSTALLATION_ID` | worker (existing; Dev Pulse uses them) | — | GitHub reads at accrual. Without them in production, accrual defers (logged) and creates nothing. |

## Funding the payer from the treasury allocation

Under [revenue policy V1](REVENUE_POLICY_V1.md) (60% buyback / 20% liquidity / 20% treasury), `scripts/platform-sweep.mjs` moves only the buyback share from the partner wallet to custody. **The liquidity and treasury shares stay in the partner wallet**, which is also the bonus payer. Bonuses are a treasury expense, and the allocation ledger is unchanged: a bonus is not recorded as an allocation.

Payouts protect what the ledger can see automatically. They never spend in-flight payouts, the payer's unallocated revenue, or its undeployed liquidity share. `/operations/bonuses` shows each of these and what is left to spend on bonuses.

1. **Confirm the buyback share was swept.** The ledger does not track partner-to-custody transfers, so payouts cannot see an allocated buyback share still sitting in the partner wallet. Check that the last `node scripts/platform-sweep.mjs --execute` reported its transfer as `sent` (not partial or skipped). Otherwise raise `VERIFICATION_BONUS_PAYER_RESERVE_LAMPORTS` by the unswept amount until the next sweep.
2. **Budget against the treasury share.** On `/operations/fees` (or `/operations/health` → Revenue), read the allocated **treasury** total. Subtract treasury spending already made, including bonuses paid (the `/stats` total, or `select sum(amount) from verification_bonus_payouts where status = 'settled'`).
3. **Top up if needed.** If the treasury share does not cover the bonuses waiting, top up the partner wallet (`H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3`) with treasury SOL held elsewhere. **Never** use the custody wallet `FgzeY…`: it holds the buyback reserve.
4. **Keep records.** Keep a record of each top-up. Bonuses paid are public on `/stats`, and each one has a finalized receipt in the database.

## Turning it on

1. **Migrate.** Merge, then deploy **web**: its pre-deploy step runs `npm run db:migrate` and applies `0047_verification_bonus`. Deploy the **worker** after web; the worker does not migrate. Until migration, its bonus pass logs `VERIFICATION_BONUS_NOT_MIGRATED` and does nothing.
2. **Enroll new launches.** Once the new worker is running, set `VERIFICATION_BONUS_LAMPORTS=250000000` on web. The launch page then shows the bonus line, and every new reservation is stamped.

   The new worker must index stamped launches first. Its launch indexer records the DBC activation point for bonus-stamped markets. An older worker would record the RPC block time for a stamped market without discovery rewards, and that timestamp is immutable once set. In production every new launch also has discovery v2, which already uses the activation point.
3. **Review.** Check that the worker's GitHub App variables are present (Dev Pulse needs them already), then review accrued bonuses on `/operations/bonuses`.
4. **Pay.** Fund the payer and confirm the last sweep moved the buyback share (above). Choose the reserve and cap deliberately: the reserve covers anything the ledger cannot see, such as an unswept buyback share. Then set `VERIFICATION_BONUS_PAYOUTS_ENABLED=true` on web. Approve pays at once; earlier approvals show **Pay**.
5. **Check the first payout.** Verify the first receipt on the explorer and the total on `/stats`.

**Turning it off:**

- Unset `VERIFICATION_BONUS_LAMPORTS` to stop enrolling. Markets already stamped keep their promise.
- Set `VERIFICATION_BONUS_PAYOUTS_ENABLED=false` to stop new payouts. In-flight payouts still settle through the worker, which needs no key.
- Never delete bonus or payout rows.

**Migration order.** `0047` carries journal `when` `1790910007000` and must stay the **last** journal entry. drizzle applies only journal entries whose `when` is newer than the last applied migration, so every earlier migration (0040–0046, from other branches) must be applied before 0047. Otherwise drizzle skips them. The migration is idempotent (`if not exists` throughout), so re-applying it is harmless.

## Data model (migration 0047)

- `markets.verification_bonus_lamports` (nullable bigint, 1,000,000–1,000,000,000). The trigger `protect_indexed_verification_bonus` makes it immutable once the launch is indexed (like `protect_indexed_discoverer` for `discovery_version`), so a market cannot be enrolled or un-enrolled retroactively.
- `verification_bonuses`: one row per market, with:
  - status `pending_review | ineligible | approved | rejected | paid`;
  - the amount, the launcher wallet, and the first verification (ID, GitHub user, login, time);
  - the activation time;
  - `evidence` (JSON: rule inputs and thresholds, wallet facts, volume split, GitHub facts, failures), the reason, the latest reviewer, the approver (kept even if the bonus is rejected later) and `paid_at`.

  Check constraints tie reasons, reviews and payment to the status.
- `verification_bonus_payouts`: durable intents, with the attempt, a unique idempotency key, the wallet, payer, amount, memo, signature, signed bytes, last valid block height, network fee, slot, timestamps and resolution. It has unique indexes on the signature and the idempotency key, and the partial unique index `one live payout per bonus`.

## Verification

- `tests/verification-bonus.test.mjs` runs with the quick tests and needs no services. It covers:
  - environment parsing;
  - every rule failing in turn, and each boundary;
  - cap logic and the bonus and payout state machines;
  - review binding;
  - the public status and launcher copy;
  - the exact payout transaction shape;
  - the payer floor;
  - GitHub fact reads, including blocked repositories;
  - activation-clock selection.

  The operator route is also covered by the treasury-route auth test (`tests/platform-operator.test.mjs`).
- `tests/verification-bonus-db.test.mjs` needs PostgreSQL and is listed in `scripts/ci/needs-services.txt`. It covers:
  - new-launch stamping, and that the stamp is never retroactive (including the immutability trigger);
  - idempotent and concurrent accrual, every ineligible reason, GitHub outage retries with backoff, and the deferred volume rule;
  - review, including the approver kept on a later rejection and the private rejection reason;
  - the payer floor against the real revenue tables, and in-flight payouts counted as spent;
  - a maintainer decline blocking accrual, approval (until withdrawn) and payment;
  - the lock refusing promptly when held, with the worker skipping;
  - the payout intent lifecycle against a scripted chain: intent saved before broadcast, idempotent pay, the unique index, worker rebroadcast of identical bytes, a wrong-delta receipt held for review, exactly one settlement, finalized-failure and provable-expiry aborts, ambiguous status never aborted, the cap counting in-flight payouts, and the self-launch re-check at payment.

  With a local `solana-test-validator` (CI's full suite), it also lands a real payout, settles it with exact balance deltas and refuses to pay twice. No mainnet transaction is sent by any test.
