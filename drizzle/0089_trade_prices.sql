-- One source of truth for prices (owner 2026-10-28). Every trade row stores the price actually paid: quote amount over
-- base amount, each scaled by its mint's on-chain decimals (never a hardcoded 6/9). mint_facts holds each mint's
-- decimals and on-chain supply (read from the mint by the chart writer); sol_usd_minutes holds SOL/USD per UTC minute,
-- so USD and market cap use the SOL price at the trade's or candle's time. trade_prices is the one view every price
-- reader uses: curve, graduated (DAMM) and Hooks coin trades. A row whose mint facts are not known yet keeps price_sol
-- null (the chart withholds it) until the chart writer reads the mint and fills it in; no price is ever guessed.
-- Expand-only and idempotent: new tables, nullable columns, functions, triggers and a view, each created only if missing.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mint_facts" (
  "mint" varchar(44) PRIMARY KEY,
  "decimals" smallint NOT NULL CHECK ("decimals" BETWEEN 0 AND 18),
  "supply" numeric(39, 0) NOT NULL CHECK ("supply" >= 0),
  "slot" bigint NOT NULL CHECK ("slot" > 0),
  "read_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sol_usd_minutes" (
  "minute" timestamptz PRIMARY KEY CHECK (date_trunc('minute', "minute") = "minute"),
  "usd" numeric NOT NULL CHECK ("usd" > 0),
  "source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_events" ADD COLUMN IF NOT EXISTS "price_sol" numeric;
--> statement-breakpoint
ALTER TABLE "damm_trade_events" ADD COLUMN IF NOT EXISTS "price_sol" numeric;
--> statement-breakpoint
ALTER TABLE "live_trade_events" ADD COLUMN IF NOT EXISTS "price_sol" numeric;
--> statement-breakpoint
-- Hooks coins live in their own table (src/hooklab-coin-trades-schema.sql); a database without them skips this.
DO $$ BEGIN
  IF to_regclass('public.hook_lab_coin_trades') IS NOT NULL THEN
    ALTER TABLE "hook_lab_coin_trades" ADD COLUMN IF NOT EXISTS "price_sol" numeric;
  END IF;
END $$;
--> statement-breakpoint
-- The price functions run as their owner (SECURITY DEFINER, fixed search_path): every writer of these tables (the site, the
-- chart writer, the Hooks site role) can insert without being granted mint_facts.
-- Quote per whole base token: (quote / 10^quote decimals) / (base / 10^base decimals). Null when either side is unknown.
CREATE OR REPLACE FUNCTION trade_price(quote numeric, base numeric, quote_mint text, base_mint text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (quote / power(10::numeric, q.decimals)) / (base / power(10::numeric, b.decimals))
  FROM mint_facts q, mint_facts b
  WHERE q.mint = quote_mint AND b.mint = base_mint AND quote > 0 AND base > 0
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION trade_events_price() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.price_sol := (SELECT trade_price(
    (CASE WHEN NEW.direction = 'buy' THEN NEW.input_base_units ELSE NEW.output_base_units END)::numeric,
    (CASE WHEN NEW.direction = 'buy' THEN NEW.output_base_units ELSE NEW.input_base_units END)::numeric,
    coalesce(m.quote_mint, 'So11111111111111111111111111111111111111112'), m.mint)
    FROM markets m WHERE m.pool = NEW.pool LIMIT 1);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION repo_trade_price() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.price_sol := (SELECT trade_price(NEW.quote_amount::numeric, NEW.base_amount::numeric,
    coalesce(m.quote_mint, 'So11111111111111111111111111111111111111112'), m.mint)
    FROM markets m WHERE m.github_repo_id = NEW.github_repo_id LIMIT 1);
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trade_events_price ON trade_events;
--> statement-breakpoint
CREATE TRIGGER trade_events_price BEFORE INSERT ON trade_events FOR EACH ROW EXECUTE FUNCTION trade_events_price();
--> statement-breakpoint
DROP TRIGGER IF EXISTS damm_trade_events_price ON damm_trade_events;
--> statement-breakpoint
CREATE TRIGGER damm_trade_events_price BEFORE INSERT ON damm_trade_events FOR EACH ROW EXECUTE FUNCTION repo_trade_price();
--> statement-breakpoint
DROP TRIGGER IF EXISTS live_trade_events_price ON live_trade_events;
--> statement-breakpoint
CREATE TRIGGER live_trade_events_price BEFORE INSERT ON live_trade_events FOR EACH ROW EXECUTE FUNCTION repo_trade_price();
--> statement-breakpoint
-- Hooks coins quote in SOL ('lamports' native, 'bridged-sol' the wrapped mint): both priced with the SOL mint's decimals.
DO $$ BEGIN
  IF to_regclass('public.hook_lab_coin_trades') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION hook_coin_trade_price() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
    BEGIN
      NEW.price_sol := trade_price(NEW.quote_amount::numeric, NEW.base_amount::numeric, 'So11111111111111111111111111111111111111112', NEW.mint);
      RETURN NEW;
    END $f$;
    DROP TRIGGER IF EXISTS hook_lab_coin_trades_price ON hook_lab_coin_trades;
    CREATE TRIGGER hook_lab_coin_trades_price BEFORE INSERT ON hook_lab_coin_trades FOR EACH ROW EXECUTE FUNCTION hook_coin_trade_price();
  END IF;
END $$;
--> statement-breakpoint
-- Every price reader's one source: a trade, its market's mint, and the price actually paid. Graduated trades count only
-- on the verified migration pool from the migration slot on (as the chart reads them). Hooks coins join when present.
DO $$ BEGIN
  EXECUTE 'CREATE OR REPLACE VIEW trade_prices AS
  SELECT m.mint::text, ''DBC''::text AS venue, t.pool::text, t.signature::text, t.event_index, t.slot, t.traded_at, t.direction::text,
    (CASE WHEN t.direction = ''buy'' THEN t.input_base_units ELSE t.output_base_units END)::numeric AS quote_amount,
    (CASE WHEN t.direction = ''buy'' THEN t.output_base_units ELSE t.input_base_units END)::numeric AS base_amount,
    t.price_sol, t.trader::text
  FROM trade_events t JOIN markets m ON m.pool = t.pool
  UNION ALL
  SELECT m.mint::text, ''DAMM''::text, d.pool::text, d.signature::text, d.event_index, d.slot, d.traded_at, d.direction::text,
    d.quote_amount::numeric, d.base_amount::numeric, d.price_sol, d.trader::text
  FROM damm_trade_events d JOIN markets m ON m.github_repo_id = d.github_repo_id
    JOIN graduation_events g ON g.github_repo_id = d.github_repo_id AND g.pool = d.pool AND d.slot >= g.slot'
  || CASE WHEN to_regclass('public.hook_lab_coin_trades') IS NOT NULL THEN '
  UNION ALL
  SELECT h.mint, ''HOOK''::text, h.pool, h.signature, h.event_index, h.slot, h.traded_at, h.side,
    h.quote_amount::numeric, h.base_amount::numeric, h.price_sol, h.trader
  FROM hook_lab_coin_trades h' ELSE '' END;
END $$;
--> statement-breakpoint
-- The prices job on the indexer host (scripts/prices-job.mjs, chart role) reads every mint in use, stores its facts and
-- SOL/USD minutes, and fills prices the triggers could not set yet (a mint first seen after its trade).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repoing_chart_recovery') THEN
    GRANT SELECT, INSERT, UPDATE ON mint_facts, sol_usd_minutes TO repoing_chart_recovery;
    GRANT UPDATE (price_sol) ON trade_events, damm_trade_events, live_trade_events TO repoing_chart_recovery;
    GRANT SELECT ON live_trade_events, trade_prices TO repoing_chart_recovery;
    IF to_regclass('public.hook_lab_coin_trades') IS NOT NULL THEN
      GRANT SELECT, UPDATE (price_sol) ON hook_lab_coin_trades TO repoing_chart_recovery;
    END IF;
  END IF;
END $$;

--> statement-breakpoint
-- The site reads these through its public role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repoing_account_web') THEN
    GRANT SELECT ON mint_facts, sol_usd_minutes, trade_prices TO repoing_account_web;
  END IF;
END $$;
