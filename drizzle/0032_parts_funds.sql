-- Parts fund (see src/parts-fund.mjs): a verified maintainer's hardware parts list, backed all-or-nothing in USDC or SOL.
-- Pledged tokens sit in the same custodial tip wallet as tips; parts_pledges is a separate liability ledger that the
-- tip wallet must cover together with repo_tips. parts_transfers are tip-wallet-signed payouts (to the maintainer's
-- payout wallet once funded) and refunds (to each backer), each written with its exact signed bytes BEFORE broadcast.
-- USD amounts are integer cents; token amounts are base units.
CREATE TABLE "parts_funds" (
  "id" uuid PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "title" varchar(100) NOT NULL CHECK (char_length("title") BETWEEN 3 AND 100),
  "description" varchar(1000),
  "goal_cents" bigint NOT NULL CHECK ("goal_cents" > 0 AND "goal_cents" <= 500000),
  "deadline" timestamptz NOT NULL,
  "status" varchar(16) NOT NULL CHECK ("status" IN ('open', 'funded', 'failed', 'cancelled')),
  "close_reason" varchar(16) CHECK ("close_reason" IN ('deadline_met', 'deadline_missed', 'collected', 'cancelled')),
  "payout_wallet" varchar(44),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "settled_at" timestamptz,
  "next_attempt_at" timestamptz,
  CONSTRAINT "parts_funds_close_check" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL AND "close_reason" IS NULL AND "settled_at" IS NULL) OR
    ("status" <> 'open' AND "closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)),
  CONSTRAINT "parts_funds_payout_check" CHECK ("status" <> 'funded' OR "payout_wallet" IS NOT NULL),
  CONSTRAINT "parts_funds_deadline_check" CHECK ("deadline" > "created_at")
);
--> statement-breakpoint
-- One list per repository until the previous one has fully paid out or refunded.
CREATE UNIQUE INDEX parts_funds_one_active ON parts_funds(github_repo_id) WHERE settled_at IS NULL;
--> statement-breakpoint
CREATE INDEX parts_funds_repo ON parts_funds(github_repo_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX parts_funds_unsettled ON parts_funds(status, deadline) WHERE settled_at IS NULL;
--> statement-breakpoint
CREATE TABLE "parts_fund_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "fund_id" uuid NOT NULL REFERENCES "parts_funds"("id") ON DELETE CASCADE,
  "position" smallint NOT NULL CHECK ("position" BETWEEN 0 AND 24),
  "name" varchar(80) NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "url" varchar(500) CHECK ("url" IS NULL OR "url" LIKE 'https://%'),
  "unit_price_cents" integer NOT NULL CHECK ("unit_price_cents" BETWEEN 1 AND 500000),
  "quantity" smallint NOT NULL CHECK ("quantity" BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX parts_fund_items_position ON parts_fund_items(fund_id, position);
--> statement-breakpoint
CREATE TABLE "parts_transfers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "kind" varchar(8) NOT NULL CHECK ("kind" IN ('payout', 'refund')),
  "fund_id" uuid NOT NULL REFERENCES "parts_funds"("id"),
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "mint" varchar(44) NOT NULL,
  "token_program" varchar(44) NOT NULL,
  "decimals" smallint NOT NULL,
  "source_wallet" varchar(44) NOT NULL,
  "recipient" varchar(44) NOT NULL,
  "amount" numeric(20, 0) NOT NULL CHECK ("amount" > 0),
  "pledge_count" integer NOT NULL CHECK ("pledge_count" > 0),
  "requested_by" text NOT NULL,
  "status" varchar(16) NOT NULL CHECK ("status" IN ('pending', 'settled', 'aborted')),
  "signature" varchar(88) NOT NULL,
  "signed_transaction" text NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "receipt" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  "resolved_at" timestamptz,
  "resolution_reason" text,
  CONSTRAINT "parts_transfers_resolution_check" CHECK (
    ("status" = 'pending' AND "settled_at" IS NULL AND "resolved_at" IS NULL) OR
    ("status" = 'settled' AND "settled_at" IS NOT NULL AND "resolved_at" IS NULL AND "receipt" IS NOT NULL) OR
    ("status" = 'aborted' AND "settled_at" IS NULL AND "resolved_at" IS NOT NULL AND "resolution_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX parts_transfers_signature_unique ON parts_transfers(signature);
--> statement-breakpoint
CREATE INDEX parts_transfers_pending ON parts_transfers(status) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX parts_transfers_fund ON parts_transfers(fund_id);
--> statement-breakpoint
CREATE TABLE "parts_pledges" (
  "id" uuid PRIMARY KEY NOT NULL,
  "fund_id" uuid NOT NULL REFERENCES "parts_funds"("id"),
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  -- Earmarks are only ever dropped from dead (expired/failed) pledges when an unbacked list is edited.
  "item_id" uuid REFERENCES "parts_fund_items"("id") ON DELETE SET NULL,
  "donor_wallet" varchar(44) NOT NULL,
  "tip_wallet" varchar(44) NOT NULL,
  "mint" varchar(44) NOT NULL,
  "token_program" varchar(44) NOT NULL,
  "decimals" smallint NOT NULL,
  "symbol" varchar(16) NOT NULL,
  "requested_amount" numeric(20, 0) NOT NULL CHECK ("requested_amount" > 0),
  "received_amount" numeric(20, 0),
  -- USD value fixed at pledge time (progress never moves with the token price).
  "usd_cents" bigint NOT NULL CHECK ("usd_cents" > 0 AND "usd_cents" <= 500000),
  "usd_price" double precision NOT NULL CHECK ("usd_price" > 0),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('prepared', 'submitted', 'confirmed', 'expired', 'failed', 'paid', 'refunded')),
  "message" text NOT NULL,
  "transaction" text NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "signature" varchar(88),
  "signed_transaction" text,
  "transfer_id" uuid REFERENCES "parts_transfers"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz,
  "confirmed_at" timestamptz,
  "resolved_at" timestamptz,
  CONSTRAINT "parts_pledges_received_check" CHECK (
    ("status" IN ('confirmed', 'paid', 'refunded') AND "received_amount" IS NOT NULL AND "received_amount" > 0 AND "signature" IS NOT NULL AND "confirmed_at" IS NOT NULL) OR
    ("status" NOT IN ('confirmed', 'paid', 'refunded') AND "received_amount" IS NULL)),
  CONSTRAINT "parts_pledges_transfer_check" CHECK ("transfer_id" IS NULL OR "status" IN ('confirmed', 'paid', 'refunded')),
  CONSTRAINT "parts_pledges_settled_check" CHECK ("status" NOT IN ('paid', 'refunded') OR "transfer_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX parts_pledges_signature_unique ON parts_pledges(signature);
--> statement-breakpoint
CREATE INDEX parts_pledges_fund_status ON parts_pledges(fund_id, status);
--> statement-breakpoint
CREATE INDEX parts_pledges_donor ON parts_pledges(donor_wallet, status);
--> statement-breakpoint
CREATE INDEX parts_pledges_open ON parts_pledges(status, created_at) WHERE status IN ('prepared', 'submitted');
--> statement-breakpoint
CREATE INDEX parts_pledges_transfer ON parts_pledges(transfer_id);
--> statement-breakpoint
CREATE TABLE "parts_updates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "fund_id" uuid NOT NULL REFERENCES "parts_funds"("id"),
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "body" varchar(1000) NOT NULL CHECK (char_length("body") BETWEEN 1 AND 1000),
  "images" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("images") = 'array' AND jsonb_array_length("images") <= 4),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX parts_updates_fund ON parts_updates(fund_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX parts_updates_repo ON parts_updates(github_repo_id, created_at DESC);
