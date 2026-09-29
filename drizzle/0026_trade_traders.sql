-- Wallet attribution for per-holding P&L. Additive and nullable: rows indexed before this migration
-- stay NULL until scripts/backfill-trade-traders.mjs replays their finalized transactions.
-- trader is the swap's user (payer) when it signed, else the transaction fee payer (aggregator routes).
ALTER TABLE trade_events ADD COLUMN trader varchar(44);
--> statement-breakpoint
ALTER TABLE damm_trade_events ADD COLUMN trader varchar(44);
--> statement-breakpoint
-- Token base units moved by the DAMM swap (buy: received, sell: sent), same bigint convention as quote_amount.
ALTER TABLE damm_trade_events ADD COLUMN base_amount bigint;
--> statement-breakpoint
ALTER TABLE damm_trade_events ADD CONSTRAINT damm_trade_base_amount_check CHECK (base_amount IS NULL OR base_amount >= 0);
--> statement-breakpoint
CREATE INDEX trade_events_trader_pool ON trade_events(trader,pool) WHERE trader IS NOT NULL;
--> statement-breakpoint
CREATE INDEX damm_trade_trader_repo ON damm_trade_events(trader,github_repo_id) WHERE trader IS NOT NULL;
