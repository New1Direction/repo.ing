# Reserve movement notifications

## Scope

Lightweight operator notification for real reserve growth or decline. No funnel events, attribution tokens, featured-market rules, economic policy changes or automated transactions.

The existing P5 worker supplies fresh finalized pool/config snapshots agreed by both RPC providers. No extra Solana subscription or polling service is introduced. The worker checks all finalized indexed markets in its paced graduation pass (30 seconds after each pass completes, plus per-market verification time). Notification delivery runs independently every 30 seconds after its previous batch, so a failed receiver cannot block fee indexing or transaction recovery. This is observation-based monitoring, not an instant notification for every trade.

## Meaningful changes

- Notify on **at least 0.05 SOL of net movement in either direction** from the last notified reserve.
- Small moves accumulate. Offset buys/sells can cancel; trading volume is not reserve growth.
- **Five-minute cooldown per market.** During cooldown retain the last notified baseline, then notify if the net move still qualifies.
- The first verified observation only establishes a baseline. Enabling monitoring never announces historical activity as new.
- CURVE uses the canonical DBC `quoteReserve` and actual config threshold. GRADUATED uses the verified DAMM SOL-side balance, explicitly labeled. DAMM movements may include liquidity additions/removals, not just trades.
- Migration establishes a new quiet DAMM baseline rather than comparing different pools and reporting a false sell. Existing P5 graduation evidence/alerts are unchanged.
- Alerts contain repo identity/name, canonical mint/pool/link, previous/current reserves, signed delta, actual graduation percentage/threshold, observation time, interval start and both providers' slots.

## Persistence and failure behavior

The last notified baseline lives in `graduation_observations.observation.reserveAlert`. The baseline update and `graduation_alerts` event (kind `RESERVE_MOVED`) commit in one transaction under the existing market advisory lock. A crash cannot consume a move without recording its notification. Immutable event keys and a global delivery lock prevent ordinary replay or simultaneous delivery by worker replicas. Stale data, identity/config/pool mismatch, RPC disagreement and slot regression do not generate reserve movement notifications.

Delivery metadata is stored separately from the evidence inside the existing alert's `detail.delivery`. No schema migration or second accounting ledger is added. HTTP retries use exponential backoff from 30 seconds to 15 minutes, with at most 12 attempts. Events older than six hours are marked expired instead of flooding a newly configured receiver. Permanent failure/expiry stays visible in the operator view. Acknowledging the operator alert does not falsely mark an external notification sent.

Delivery is **at least once**, not exactly once: if a receiver accepts a request and its response is lost, a retry may appear twice. Each message includes a stable alert ID; the generic webhook sends `Idempotency-Key: repoing-reserve-<id>` so the receiver can deduplicate. No money moves during delivery or retry.

## Worker configuration

`RESERVE_ALERTS_ENABLED=true` starts observation and queue processing. The private `RESERVE_ALERT_WEBHOOK_URL` is optional until a destination is chosen. With no receiver, detection still records operator alerts and delivery reports `DESTINATION_REQUIRED`. It never claims that a user was notified.

The initial adapter accepts a trusted HTTPS receiver and POSTs JSON:

```json
{ "event": "reserve_moved", "id": 123, "text": "Human-readable alert", "market": { "repoId": "...", "previousReserveLamports": "...", "reserveLamports": "...", "deltaLamports": "...", "progressPercent": 0.5 } }
```

The real `market` payload also contains the public proof fields listed above. It excludes delivery metadata and credentials. Requests have a 10-second timeout, reject redirects and accept only successful HTTP responses. Receiver acceptance is not proof that a human read the alert. Provider-specific Telegram/Discord formatting requires the chosen destination to be configured and tested; no credentials or destination have been supplied yet. Keep credentials in Railway worker variables or ignored secret files, never in Git or browser configuration.

Pause with `RESERVE_ALERTS_ENABLED=false`; existing events remain durable. P3, P4 and buyback execution settings are untouched.

## Verification

Six focused reserve tests, six existing P5 guard/access tests, and one disposable Postgres integration passed. The database rehearsal covers atomic rollback, baseline restart/replay, queue retry/backoff, replica locking, expiry and unchanged zero trade/P3/P4 intent counts. All fixtures stayed local. Production build passed. External delivery is not verified until an actual destination is supplied and accepts a test notification.

## Next operational step

Recruit 5–10 discoverers who already follow active open-source/AI/dev-tool communities. Ask for a current source showing why a repo matters this week, one explicit launch and one voluntary share. Use the reserve notifications to notice genuine growth. No volume targets, paid turnover or automated outreach. First milestone: one discoverer launches a repo whose real reserve starts accumulating.

## Production detection rollout — September 27, 2026 UTC

Code `198d33a` deployed successfully to worker `c50f82c8-0698-4bc4-ac26-2e7eaca07e0e` and web `0556cec6-098d-4ea4-b940-b0e53013169a`. At `2026-09-27T01:12:35.593Z`, all **21 indexed markets** had reserve baselines; there were zero review states and zero initial movement alerts. The initial pass was intentionally quiet. No production fixture was inserted.

Worker `RESERVE_ALERTS_ENABLED=true`; no external receiver is configured. Detection and the operator alert queue are live, but **external pings remain incomplete pending the user's destination and a delivery test**. Anonymous operator access returned 401. Both services retained P3/P4/buybacks false, with zero P3/P4 intents. No funds were moved or trades generated. Git branch: `codex/trend-discovery`.
