-- Hooks coin trades for the coin page's chart and trades list (src/hooklab-coin-trades.mjs): one row per trade event the
-- swap program emitted about a listed coin's pool, read from finalized transactions, so a row never changes. Display only:
-- nothing that moves money reads these tables. Same database as hook_lab_launch_requests; nothing here references it.
-- SwappedNative / lamports are allowed ahead of native-SOL pools so their trades need no further migration.
create table hook_lab_coin_trades (
 signature text not null check(signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 event_index integer not null check(event_index>=0),
 event text not null check(event in ('Swapped','SwappedNative')),
 quote_asset text not null check(quote_asset in ('bridged-sol','lamports')),
 pool text not null check(pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 mint text not null check(mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 slot bigint not null check(slot>0),
 traded_at timestamptz not null,
 -- The pool's swap counter after this swap: one per swap, so it orders a pool's trades exactly, within a slot too.
 swap_count numeric(20,0) not null check(swap_count>0),
 side text not null check(side in ('buy','sell')),
 trader text not null check(trader ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 -- SOL (or lamports) the trader paid on a buy or received on a sell; the coin amount bought or sold (raw units).
 quote_amount numeric(20,0) not null check(quote_amount>0),
 base_amount numeric(20,0) not null check(base_amount>=0),
 quote_fee numeric(21,0) not null check(quote_fee>=0),
 -- The curve's pricing reserves after the swap (real plus virtual): price = curve_quote / curve_base.
 curve_base numeric(21,0) not null check(curve_base>0),
 curve_quote numeric(21,0) not null check(curve_quote>0),
 indexed_at timestamptz not null default clock_timestamp(),
 primary key(signature,event_index),
 unique(pool,swap_count)
);
create index hook_lab_coin_trades_pool_time on hook_lab_coin_trades(pool,traded_at);
-- Per pool: the newest finalized transaction naming the pool that has been read (trades or not).
create table hook_lab_coin_trade_cursors (
 pool text primary key check(pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 mint text not null check(mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 last_signature text not null check(last_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
 last_slot bigint not null check(last_slot>0),
 updated_at timestamptz not null default clock_timestamp()
);
