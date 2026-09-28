# Protocol analytics

[Documentation](README.md) / Analytics

[Open the live dashboard](https://repo.ing/stats). The public `/stats` page shows protocol activity and revenue transparency using existing ledgers. It does not create another accounting system or expose operator controls.

![repo.ing protocol analytics](assets/analytics.png)

*Production snapshot, September 26, 2026. Figures change as finalized activity is indexed.*

## Metrics and sources

| Metric | Definition | Source |
| --- | --- | --- |
| Paid to builders | Settled SOL fee payouts in the selected period | `repo_claims`, `status = settled`, settlement time |
| Earned by builders | Indexed builder fee credits, including fees already paid | `fee_events` + verified-pool `damm_fee_events`, indexing time |
| Trading volume | DBC buy SOL input / sell SOL output, plus verified DAMM SOL quote amounts | `trade_events` + `damm_trade_events`, chain trade time |
| Live markets | Confirmed, finalized launches with completed indexing | `markets` |
| Graduated markets | Canonical markets with durable migration evidence | `graduation_events` |
| Platform fees claimed | Settled DAMM partner fee claims | Existing platform revenue summary |
| Buyback reserve | Buyback allocations minus settled buyback spending | Existing platform revenue ledger |
| Available liquidity reserve | Liquidity allocations minus open commitments and settled investment | Existing liquidity reserve summary |
| Allocated to treasury | Cumulative treasury allocations, not a current wallet balance | `platform_revenue_allocations` |
| SOL bought back | Verified buyback receipt totals, gross SOL including trading fees | `app/lib/buyback-receipts.mjs`; launch and early team purchases excluded |

Only canonical, confirmed, indexed, finalized markets enter the activity aggregates. DAMM events must match the same repository's durable graduation pool. Wrong-pool events, unindexed launches, pending payouts, liquidity deposits, and migration transfers are excluded. The launch purchase is counted through its swap event, never again as a synthetic volume row.

Discovery payouts and builder token allocations are separate from SOL builder fee payouts. Volume is turnover, not reserve growth or market liquidity.

## Time and currency

- **24h / 7d / 30d:** rolling periods ending at the read timestamp.
- **All time:** totals cover all indexed history; charts show the latest 14 UTC calendar days.
- **24h chart:** hourly UTC buckets. Other charts use daily UTC buckets. Edge buckets can be partial.
- **Zero activity:** zero-height bars and an explicit empty message. Missing data is not replaced with fabricated activity.
- **Exact data:** expand **View data** for lamport-precise SOL values, including zero buckets.
- **USD:** each SOL value is converted using the current available SOL price. Historical earnings are not valued at their original trade-day exchange rate. If the price is unavailable, SOL still displays.

Fee charts use indexing time because fee credits may be recorded in checkpoints or backfills. They are not an exact reconstruction of the time every underlying fee was generated. The dashboard describes this distinction below the charts.

## Read consistency and failures

`src/protocol-analytics.mjs` reads through one PostgreSQL **repeatable-read, read-only transaction**, with a five-second per-statement timeout. All activity totals, chart buckets, payout receipts, and reserve summaries use that database snapshot. Money stays in integer base units; floating point is limited to display conversion and bar heights.

The existing platform revenue and liquidity reconciliation functions must both return `MATCH` before public reserve values are returned. A mismatch produces **Being verified** and hides those totals. A failed database read produces an unavailable state, not zeros. Internal reviews, signed transactions, private credentials, and operator identifiers are not returned.

The update timestamp is the dashboard read time, not proof that the worker has observed every latest transaction. Values reflect finalized indexed evidence and can lag the chain. Reload or change period to refresh. Platform allocation/reserve values and market counts are all-time regardless of the activity filter.

## Verification

`tests/protocol-analytics.test.mjs` covers rolling windows, UTC buckets, canonical market filtering, verified DAMM pool binding, settled-only payouts, fee accounting, policy allocation, reserve reconciliation failure, and exclusion of private signed data. It creates and drops one dedicated local database and rejects any other `DATABASE_URL`.

```sh
DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/repoing_analytics_test \
  node --test tests/protocol-analytics.test.mjs
```

Requires the disposable local Postgres setup at that address. No mainnet transactions are submitted.

## Reserve coverage and buyback receipts

The ledger reconciliation label refers to accounting entries. Buyback and liquidity cards are recorded allocations after ledger spending, not live spendable balances. Stats separately checks the recorded platform receiving wallet using two finalized mainnet RPC balance reads. A shortage is displayed as **Reserve balances need reconciliation**; RPC failure, disagreement, wrong network, slot drift over 150 slots, or multiple receiving wallets with unresolved attribution displays **not verified**. The check includes remaining buyback, liquidity and unallocated funds; historical treasury allocation is not an outstanding reserve obligation. RPC requests are bounded to 2.5 seconds and failed checks do not reuse a prior positive result.

This read-only display does not reconcile the purpose of external transfers, change allocations, or unlock financial execution. Multiple receiving wallets require per-allocation custody review before a combined funded status can be shown. The public buyback card shows one SOL total from verified purchase receipts, with receipt links under a collapsed disclosure. No wallet is automatically listed from a discovered transfer. Publishing a receipt does not insert an executor intent or debit the platform reserve.

[September 28 audit](BUYBACK_AUDIT_2026_09_28.md).
