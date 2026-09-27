ALTER TABLE damm_trade_events ADD COLUMN next_sqrt_price text;
--> statement-breakpoint
ALTER TABLE damm_trade_events ADD CONSTRAINT damm_chart_price_valid
CHECK (next_sqrt_price IS NULL OR (next_sqrt_price ~ '^[1-9][0-9]{0,38}$'
  AND next_sqrt_price::numeric < 340282366920938463463374607431768211456));
--> statement-breakpoint
CREATE INDEX damm_trade_chart_pool_time ON damm_trade_events(pool,traded_at);
