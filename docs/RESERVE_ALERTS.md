# Reserve movement notifications

## Scope

Lightweight operator record of real reserve growth or decline, and the delivery queue for operator notifications. By default the queue sends only what needs an operator: a low operating balance (below) and the ledgers that stopped matching the chain, as one message at most once an hour ([What is sent](#what-is-sent)). Reserve moves are recorded for the operations pages and sent only when `RESERVE_MOVE_NOTIFICATIONS=true`. No funnel events, attribution tokens, featured-market rules, economic policy changes or automated transactions.

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

Delivery metadata is stored separately from the evidence inside the existing alert's `detail.delivery`. No schema migration or second accounting ledger is added. HTTP retries use exponential backoff from 30 seconds to 15 minutes, and go on until the alert is six hours old. Then it is marked expired, like any event that old, instead of flooding a newly configured receiver: each run expires all of them in one statement before it sends, so a backlog never delays the alerts behind it. Why a send failed is kept as a fixed code in `detail.delivery.errorCode` (`HTTP_<status>`, `TIMEOUT` or `NETWORK`), never the receiver's answer. An alert whose text cannot be made fails at once with `RENDER_FAILED`. Failure and expiry stay visible in the operator view. Acknowledging the operator alert does not falsely mark an external notification sent.

Delivery is **at least once**, not exactly once: if a receiver accepts a request and its response is lost, a retry may appear twice. Each message includes a stable alert ID; the generic webhook sends `Idempotency-Key: repoing-reserve-<id>` so the receiver can deduplicate. No money moves during delivery or retry.

## Worker configuration

`RESERVE_ALERTS_ENABLED=true` starts observation and queue processing. The private `RESERVE_ALERT_WEBHOOK_URL` is optional until a destination is chosen. With no receiver, or one the sender refuses (`ALERT_DESTINATION_INVALID`), detection still records operator alerts and delivery reports `DESTINATION_REQUIRED`. It never claims that a user was notified.

`RESERVE_MOVE_NOTIFICATIONS=true` also queues each reserve move for the receiver. Without it a move is recorded with `detail.delivery.status` `off` and shown on the operations pages only (one busy market produces about a hundred a day).

The initial adapter accepts a trusted HTTPS receiver and POSTs JSON:

```json
{ "event": "reserve_moved", "id": 123, "text": "Human-readable alert", "market": { "repoId": "...", "previousReserveLamports": "...", "reserveLamports": "...", "deltaLamports": "...", "progressPercent": 0.5 } }
```

The real `market` payload also contains the public proof fields listed above. It excludes delivery metadata and credentials. Requests have a 10-second timeout, reject redirects and accept only successful HTTP responses. Receiver acceptance is not proof that a human read the alert. Slack, Discord and Telegram destinations get the message in their own format ([Destinations](#destinations)). Keep credentials in Railway worker variables or ignored secret files, never in Git or browser configuration.

Pause delivery and reserve observations with `RESERVE_ALERTS_ENABLED=false`; existing events remain durable. P3, P4 and buyback execution settings are untouched.

## What is sent

Always queued for the receiver, when `RESERVE_ALERTS_ENABLED=true`:

- `OPS_WALLET_LOW`: an operating wallet below its minimum (next section).
- `RECONCILIATION_MISMATCH`: what the graduation monitor's checks found and could not clear (`src/ledger-alerts.mjs`, `src/reconcile.mjs` `createReconcileEpisodes`, `src/ledger-digest.mjs`):
  - **What is watched:**
    - each SOL market's fee ledger (`ledger: "fees"`);
    - each SOL market's pass as a whole (`"market"`): a pass that keeps ending in review, at whichever step, leaves the market's public progress unrefreshed, and its ledger unchecked when it fails before the ledger is read;
    - the platform's revenue and liquidity ledgers (`"platform"`);
    - whether the pass gets through its markets at all (`"checks"`): the two RPC providers cannot be verified, the pass's own ledger reads fail (`LEDGER_READS_FAILED`), it dies between two markets (`MARKET_PASS_FAILED`), or passes come round less often than public progress lasts (`PASS_TOO_SLOW`: a pass takes more than five minutes, or starts more than five minutes after the one before).
  - **When something is recorded:** an episode runs from the first pass that does not match (or verify) to the next that does. What a pass found has its own hold, by kind:
    - **a difference** (the ledger ahead of the chain, a claim or withdrawal difference, a pool that is missing or is not the market's): recorded when it is seen again **15 minutes** or more after it was first seen. One read from a lagging RPC node never is. Lag may hide a real difference on the passes between.
    - **unchecked** (a read that keeps failing, a claim in flight, a pass that fails first): recorded after **15 minutes** without one completed check. Any completed check starts the count again.
    - **behind the chain** (fees from trades the worker has not recorded yet; normal after a trade): recorded when the worker has recorded **nothing new for the ledger for 60 minutes** (`stalled`), or when the ledger has gone **6 hours** without one matching pass. A market traded without a pause is behind on every pass and is not recorded while its fees keep being recorded. Measured on the busiest market over five days (3,851 swaps): fees recorded in a median 21 seconds, about 10 minutes at most.
    - A problem that changes kind (reads fail, then a real difference shows) is recorded again as the new kind.
    - While an episode lasts, each kind is recorded again every six hours, as a repeat.
    - An episode also ends, without a match, when more than two passes in a row did not reach its ledger (the passes died first, or another worker held the market: `BUSY` is settled by that worker), or when nothing settled it for an hour. Slow passes do not end it.
    - When the ledger matches again, every row recorded for it is marked `clearedAt`, also rows recorded by a worker that has since been replaced.
    - Recording never fails the pass that did the checking. A row that cannot be stored or marked is counted in that pass's result (`ALERTS_NOT_RECORDED`) and is stored or marked by the next pass.
  - **What is sent:** recorded rows are never sent one by one. The delivery job gathers them into **one message**:
    - **News** is a ledger with a kind of trouble that no message has told the operator about. A message with news waits until its newest news is 3 minutes old (10 at most), so the rows of one fault go out together. Messages are **at least one hour apart**.
    - **Reminders** ride along with news; by themselves they go out **once per six hours**. A reminder is:
      - a repeat of an episode already announced;
      - trouble that a message covered in the last six hours and that has not cleared since (the same problem, recorded again by a worker that restarted);
      - the same kind of trouble come back, after it cleared, for a ledger a message covered in the last six hours, **while it is less than an hour old** (a provider that fails on and off). Once it has lasted an hour it is news.
    - **One message at a time:** while the last message still waits to be sent, nothing new is written.
    - A ledger that matched again before its row went out is dropped (`detail.delivery` `{"status":"off","reason":"CLEARED"}`), and a row that waited more than eight hours is expired.
    - A message about one ledger is that ledger's own alert. About several, it names up to ten (the ones that need an operator most first), counts the rest and links the list on `/operations/graduation`.
  - **In the database:** a recorded row has `detail.delivery` `{"status":"digest","queuedAt":…}`, plus `"digest": <alert id>` once a message covers it. The message is a `graduation_alerts` row of its own (`detail.ledger` `"digest"`), delivered and retried like any other alert. Both are written in one transaction; a run that fails writes neither and the next run plans the same rows.
  - **No destination:** the message is still written, with `detail.delivery` `{"status":"off","reason":"DESTINATION_REQUIRED"}`, so a destination set later is not sent old news.
  - **When planning fails:** the run reports `digestError` with a code and still sends whatever else is queued. After three failed runs in a row the queue says so itself through the destination, at most once per six hours for one worker process.
  - **Restarts:** the holds live in the worker process. After a restart, a problem that is still there is recorded again once it has been seen for its hold; a message that already covered it makes that row a reminder, not news. What the messages covered, and when the last one was written, is in the database and survives a restart.
  - **What a message does not tell:** "Since" is when the running worker first saw the problem. A message that waited for a receiver that was down goes out as it was written. An acknowledged alert is still repeated while its problem lasts.

The alert text uses fixed wording: a reason is sent only when it is one of this codebase's own, never a failed read's message. `RECONCILIATION_MISMATCH` alerts recorded before these were delivered carry no `detail.delivery` and are left as they are, in no message.

Stock-pair ledgers raise the same kind from `src/stock-reconcile.mjs`. Those alerts are recorded for the operations pages and are **not queued for the receiver yet**.

Queued only with `RESERVE_MOVE_NOTIFICATIONS=true`: `RESERVE_MOVED`. Without it the delivery job also marks any move that is still queued as `off` (`RESERVE_NOTIFICATIONS_OFF`) instead of sending it: the moves recorded before this setting existed, and any queued while it was on.

## Destinations

`RESERVE_ALERT_WEBHOOK_URL` on the worker is the one destination. The sender picks the format from its host. A destination whose form cannot work (not HTTPS, credentials in the URL, a Telegram URL without `chat_id`, a Discord URL that is not a webhook) is refused when the worker starts (`reserveAlertError: ALERT_DESTINATION_INVALID`); a well-formed address that is simply wrong shows only when something is sent, so test it:

| Destination | Value of `RESERVE_ALERT_WEBHOOK_URL` | What is sent |
| --- | --- | --- |
| Slack | The channel's incoming webhook, `https://hooks.slack.com/services/…` | `{ "text": "…" }` |
| Discord | The channel's webhook, `https://discord.com/api/webhooks/<id>/<token>` | `{ "content": "…" }`, with mentions disabled |
| Telegram | `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat>` | `sendMessage` with that chat and the text, link previews off |
| Any other HTTPS receiver | Its URL | The JSON event shown above |

- **Telegram:** the token comes from @BotFather. `<chat>` is the numeric id of the chat or channel the bot was added to (a channel id starts with `-100`), or `@channelname` for a public channel.
- The value is a secret: it lets anyone post to that channel. Keep it in Railway worker variables only.
- **Test it:** `railway ssh --service worker -- node scripts/send-test-alert.mjs` sends one test message through the same sender. It reads no database and no chain. A destination counts as live once that message has arrived. When the receiver refuses it, the script prints the same code the queue keeps:
  - `HTTP_404`: the webhook or bot address does not exist (a wrong or revoked link);
  - `HTTP_401` or `HTTP_403`: the token is wrong, or the bot may not post there;
  - `HTTP_400` (Telegram): the `chat_id` is wrong, or the bot was not added to that chat;
  - `HTTP_429`: the receiver is rate limiting; `TIMEOUT`, `NETWORK`: it could not be reached.

## Operating balances

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
