# Reserve movement notifications

## Scope

Lightweight operator record of real reserve growth or decline, and the delivery queue for operator notifications. By default the queue sends only what needs an operator: a low operating balance (below) and a ledger that stopped matching the chain ([What is sent](#what-is-sent)). Reserve moves are recorded for the operations pages and sent only when `RESERVE_MOVE_NOTIFICATIONS=true`. No funnel events, attribution tokens, featured-market rules, economic policy changes or automated transactions.

The existing P5 worker supplies fresh finalized pool/config snapshots agreed by both RPC providers. No extra Solana subscription or polling service is introduced. The worker checks all finalized indexed SOL-quoted markets in its paced graduation pass (30 seconds after each pass completes, plus per-market verification time); stock-paired markets raise no reserve movement alerts. Notification delivery runs independently two minutes after its previous batch, so a failed receiver cannot block fee indexing or transaction recovery. This is observation-based monitoring, not an instant notification for every trade.

## Meaningful changes

- Record on **at least 0.05 SOL of net movement in either direction** from the last recorded reserve.
- Small moves accumulate. Offset buys/sells can cancel; trading volume is not reserve growth.
- **Five-minute cooldown per market.** During cooldown retain the last notified baseline, then notify if the net move still qualifies.
- The first verified observation only establishes a baseline. Enabling monitoring never announces historical activity as new.
- CURVE uses the canonical DBC `quoteReserve` and actual config threshold. GRADUATED uses the verified DAMM SOL-side balance, explicitly labeled. DAMM movements may include liquidity additions/removals, not just trades.
- Migration establishes a new quiet DAMM baseline rather than comparing different pools and reporting a false sell. Existing P5 graduation evidence/alerts are unchanged.
- Alerts contain repo identity/name, canonical mint/pool/link, previous/current reserves, signed delta, actual graduation percentage/threshold, observation time, interval start and both providers' slots.

## Persistence and failure behavior

The last notified baseline lives in `graduation_observations.observation.reserveAlert`. The baseline update and `graduation_alerts` event (kind `RESERVE_MOVED`) commit in one transaction under the existing market advisory lock. A crash cannot consume a move without recording its notification. Immutable event keys and a global delivery lock prevent ordinary replay or simultaneous delivery by worker replicas. Stale data, identity/config/pool mismatch, RPC disagreement and slot regression do not generate reserve movement notifications.

Delivery metadata is stored separately from the evidence inside the existing alert's `detail.delivery`. No schema migration or second accounting ledger is added. HTTP retries use exponential backoff from 30 seconds to 15 minutes, with at most 12 attempts. Events older than six hours are marked expired instead of flooding a newly configured receiver: each run expires all of them in one statement before it sends, so a backlog never delays the alerts behind it. Permanent failure/expiry stays visible in the operator view. Acknowledging the operator alert does not falsely mark an external notification sent.

Delivery is **at least once**, not exactly once: if a receiver accepts a request and its response is lost, a retry may appear twice. Each message includes a stable alert ID; the generic webhook sends `Idempotency-Key: repoing-reserve-<id>` so the receiver can deduplicate. No money moves during delivery or retry.

## Worker configuration

`RESERVE_ALERTS_ENABLED=true` starts observation and queue processing. The private `RESERVE_ALERT_WEBHOOK_URL` is optional until a destination is chosen. With no receiver, detection still records operator alerts and delivery reports `DESTINATION_REQUIRED`. It never claims that a user was notified.

`RESERVE_MOVE_NOTIFICATIONS=true` also queues each reserve move for the receiver. Without it a move is recorded with `detail.delivery.status` `off` and shown on the operations pages only (one busy market produces about a hundred a day).

The initial adapter accepts a trusted HTTPS receiver and POSTs JSON:

```json
{ "event": "reserve_moved", "id": 123, "text": "Human-readable alert", "market": { "repoId": "...", "previousReserveLamports": "...", "reserveLamports": "...", "deltaLamports": "...", "progressPercent": 0.5 } }
```

The real `market` payload also contains the public proof fields listed above. It excludes delivery metadata and credentials. Requests have a 10-second timeout, reject redirects and accept only successful HTTP responses. Receiver acceptance is not proof that a human read the alert. Provider-specific Telegram/Discord formatting requires the chosen destination to be configured and tested; no credentials or destination have been supplied yet. Keep credentials in Railway worker variables or ignored secret files, never in Git or browser configuration.

Pause delivery and reserve observations with `RESERVE_ALERTS_ENABLED=false`; existing events remain durable. P3, P4 and buyback execution settings are untouched.

## What is sent

Always queued for the receiver, when `RESERVE_ALERTS_ENABLED=true`:

- `OPS_WALLET_LOW`: an operating wallet below its minimum (next section).
- `RECONCILIATION_MISMATCH`: a ledger that has stayed unmatched, or could not be checked, for **15 minutes** (`src/ledger-alerts.mjs`, `src/reconcile.mjs` `createReconcileEpisodes`):
  - **What is watched:** each SOL market's fee ledger, the platform's revenue and liquidity ledgers, and the monitor's own chain checks. While both RPC providers cannot be verified, no ledger is checked at all; that is an alert of its own.
  - **One rule:** an episode runs from the first pass that does not match to the next that does, and alerts once it has lasted 15 minutes, whatever kept it from matching:
    - the ledger behind the chain (fees from a trade the worker has not recorded yet; this normally clears in under a minute);
    - a claim in flight, or a read that keeps failing;
    - the ledger ahead of the chain, or a claim or withdrawal difference;
    - a pass that fails before it reaches the ledger (for example a pool that is not the market's), which leaves the ledger unchecked.
  - A ledger that matches again inside the 15 minutes never alerts.
  - **Repeats:** while an episode lasts it is announced again every six hours. A new episode is a new alert.
  - **Many at once:** an RPC or database fault touches every market in the same pass. One pass sends at most three new fee-ledger alerts one by one. The rest are recorded with `detail.delivery` `{"status":"off","reason":"SUMMARIZED"}`, and one alert says how many there are.
  - **Restarts:** the hold lives in the worker process. After a restart, a ledger that still does not match alerts again once it has been seen unmatched for 15 minutes.

The alert text uses fixed wording: a reason is sent only when it is one of this codebase's own, never a failed read's message. `RECONCILIATION_MISMATCH` alerts recorded before these were delivered carry no `detail.delivery` and are left as they are.

Stock-pair ledgers raise the same kind from `src/stock-reconcile.mjs`. Those alerts are recorded for the operations pages and are **not queued for the receiver yet**.

Queued only with `RESERVE_MOVE_NOTIFICATIONS=true`: `RESERVE_MOVED`.

## Slack and operating balances

For Slack, set `RESERVE_ALERT_WEBHOOK_URL` to the incoming webhook for the chosen operator channel. HTTPS `hooks.slack.com` receivers receive Slack's `{ "text": "..." }` payload. Keep the webhook private in Railway worker variables. Destination setup and a successful delivery test are required before calling Slack notifications live.

Set `OPS_PAYOUT_WALLET` and `OPS_COLLECTION_WALLET` on the worker to the public addresses of the existing payout and collection signers. No private signing key is needed for monitoring. Every 15 minutes the worker compares finalized balances from the two configured RPC providers. Disagreement fails closed and logs `OPERATING_BALANCE_UNVERIFIED`.

- Payout signer: alert below **0.03 SOL**.
- Collection signer: alert below **0.01 SOL**.
- Each low role produces at most one durable `OPS_WALLET_LOW` alert per UTC day, using the same outbox and delivery retries as reserve alerts. It is always queued for the receiver.
- The operator page shows role, balance, threshold and delivery status. Monitoring never transfers funds or tops up a wallet.
- Balance observation remains active when reserve delivery is paused; removing the monitoring public-address variables disables it.

## Expired launch recovery

An operator can inspect a blocked launch with `node scripts/recover-expired-launch.mjs --repo=<GitHub ID>`. The default is read-only. After reviewing the result, repeat with `--apply` to release only an expired, unlanded attempt.

Both independent mainnet RPCs must agree: finalized height exceeds the transaction's last valid height by more than 150 blocks, blockhash is invalid, transaction and historical signature status are absent, and both mint and pool accounts are absent. Slot disagreement, stale evidence, existing accounts, or indexed launch evidence blocks recovery. The pool must derive from an approved config.

Applying recovery holds the repository advisory lock and atomically records `LAUNCH_EXPIRED` evidence with its hash before changing the matching attempt to `failed`. A new launch can then be reviewed normally. The original signature and account identities remain in the durable audit. This command never signs or broadcasts a transaction. The worker releases an expired, unlanded attempt by the same proof on its own ([launch indexer](LAUNCH_INDEXER.md)); the command remains for inspection and for a release by hand.

## Verification

Six focused reserve tests, six existing P5 guard/access tests, and one disposable Postgres integration passed. The database rehearsal covers atomic rollback, baseline restart/replay, queue retry/backoff, replica locking, expiry and unchanged zero trade/P3/P4 intent counts. All fixtures stayed local. Production build passed. External delivery is not verified until an actual destination is supplied and accepts a test notification.

## Next operational step

Recruit 5–10 discoverers who already follow active open-source/AI/dev-tool communities. Ask for a current source showing why a repo matters this week, one explicit launch and one voluntary share. Use the reserve notifications to notice genuine growth. No volume targets, paid turnover or automated outreach. First milestone: one discoverer launches a repo whose real reserve starts accumulating.

## Production detection rollout — September 27, 2026 UTC

Code `198d33a` deployed successfully to worker `c50f82c8-0698-4bc4-ac26-2e7eaca07e0e` and web `0556cec6-098d-4ea4-b940-b0e53013169a`. At `2026-09-27T01:12:35.593Z`, all **21 indexed markets** had reserve baselines; there were zero review states and zero initial movement alerts. The initial pass was intentionally quiet. No production fixture was inserted.

Worker `RESERVE_ALERTS_ENABLED=true`; no external receiver is configured. Detection and the operator alert queue are live, but **external pings remain incomplete pending the user's destination and a delivery test**. Anonymous operator access returned 401. Both services retained P3/P4/buybacks false, with zero P3/P4 intents. No funds were moved or trades generated. Git branch: `codex/trend-discovery`.

## Phantom launch assertions

The launch signer accepts a narrow compatibility case for Phantom's appended Lighthouse safety checks. The original launch instructions, payer, blockhash, account privileges and fees must remain exactly as reviewed. Only up to four trailing assertions on existing launch accounts are accepted, using the canonical Lighthouse program and account-data/info/mint/token assertion discriminators. Memory write/close, delta/CPI variants, new accounts, changed privileges and unknown instructions are rejected before platform co-signing. The user's signature must verify over the entire returned transaction, including the assertions; assertions remain intact for network preflight and execution.

References: [Phantom transaction validation](https://docs.phantom.com/developer-powertools/lighthouse), [reviewed Lighthouse instruction source](https://github.com/Jac0xb/lighthouse/blob/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse/src/instruction.rs). Mainnet unsigned simulations with two real account assertions passed for no-buy and 0.03 SOL launches with identical reviewed wallet costs. This simulation is not proof of a successful launch on an affected mobile device.
