-- Referral leaderboard: one row per site trade (/api/trade) whose verified swap paid a referral (src/referral.mjs).
-- Written only after the receipt is verified against the trade's own prepared record; never read for money. Earnings
-- shown from it are estimates: 4% of the trading fee quoted at prepare. Holds the referrer's public wallet (the owner of
-- the referral account the swap pays, visible on chain anyway), never the trader's wallet.
CREATE TABLE "trade_referrers" (
  "signature" varchar(88) PRIMARY KEY NOT NULL,
  "referrer" varchar(44) NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "phase" varchar(16) NOT NULL CHECK ("phase" IN ('curve', 'graduated')),
  "direction" varchar(4) NOT NULL CHECK ("direction" IN ('buy', 'sell')),
  "trading_fee_lamports" numeric(20, 0) NOT NULL CHECK ("trading_fee_lamports" >= 0),
  "settled_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX trade_referrers_settled_at ON trade_referrers(settled_at);
--> statement-breakpoint
CREATE INDEX trade_referrers_referrer ON trade_referrers(referrer);
