-- USD launch pricing for owner-approved launches (src/hooklab-launch-pricing.mjs): the SOL/USD price repo.ing fixed when
-- the owner invited a request, the sources it came from, and the virtual quote (opening price) derived from it. Written
-- in the same transaction as the invite and never changed, so the creator launches, and the owner co-signs, exactly this
-- price. Same database as hook_lab_launch_requests; requests without a row launch at the standard 1 SOL quote.
create table hook_lab_launch_request_prices (
 request_id uuid primary key references hook_lab_launch_requests(id),
 sol_usd_micros bigint not null check(sol_usd_micros>0),
 -- [{"source":"coingecko","usdMicros":"105620000"},...]: every source that answered; one more than 2% from the median
 -- of all answers carries "ignored":true, and at least two are kept.
 sources jsonb not null check(jsonb_typeof(sources)='array' and jsonb_array_length(sources) between 2 and 3),
 virtual_quote bigint not null check(virtual_quote>0),
 priced_at timestamptz not null default clock_timestamp()
);
create function hook_lab_launch_request_price_immutable() returns trigger language plpgsql as $$
begin raise exception 'Launch request prices are immutable'; end $$;
create trigger hook_lab_launch_request_price_immutable before update or delete on hook_lab_launch_request_prices
 for each row execute function hook_lab_launch_request_price_immutable();
