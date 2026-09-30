-- Repository tips (see src/tips.mjs). A donor's tip moves on chain into the custodial tip wallet; rows here are the
-- liability ledger the tip wallet must always cover. No key material is stored.
-- tip_transfers: tip-wallet-signed payouts (to the verified payout wallet) and refunds (back to the donor). Each row is
-- written, with its exact signed transaction, BEFORE broadcast; the worker settles or aborts pending rows.
CREATE TABLE "tip_transfers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "kind" varchar(8) NOT NULL CHECK ("kind" IN ('payout', 'refund')),
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "mint" varchar(44) NOT NULL,
  "token_program" varchar(44) NOT NULL,
  "decimals" smallint NOT NULL,
  "source_wallet" varchar(44) NOT NULL,
  "recipient" varchar(44) NOT NULL,
  "amount" numeric(20, 0) NOT NULL CHECK ("amount" > 0),
  "tip_count" integer NOT NULL CHECK ("tip_count" > 0),
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
  CONSTRAINT "tip_transfers_resolution_check" CHECK (
    ("status" = 'pending' AND "settled_at" IS NULL AND "resolved_at" IS NULL) OR
    ("status" = 'settled' AND "settled_at" IS NOT NULL AND "resolved_at" IS NULL AND "receipt" IS NOT NULL) OR
    ("status" = 'aborted' AND "settled_at" IS NULL AND "resolved_at" IS NOT NULL AND "resolution_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX tip_transfers_signature_unique ON tip_transfers(signature);
--> statement-breakpoint
CREATE INDEX tip_transfers_pending ON tip_transfers(status) WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE "repo_tips" (
  "id" uuid PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "donor_wallet" varchar(44) NOT NULL,
  "tip_wallet" varchar(44) NOT NULL,
  "mint" varchar(44) NOT NULL,
  "token_program" varchar(44) NOT NULL,
  "decimals" smallint NOT NULL,
  "symbol" varchar(16) NOT NULL,
  "requested_amount" numeric(20, 0) NOT NULL CHECK ("requested_amount" > 0),
  "received_amount" numeric(20, 0),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('prepared', 'submitted', 'confirmed', 'expired', 'failed', 'paid', 'refunded')),
  "message" text NOT NULL,
  "transaction" text NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "signature" varchar(88),
  "signed_transaction" text,
  "transfer_id" uuid REFERENCES "tip_transfers"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz,
  "confirmed_at" timestamptz,
  "resolved_at" timestamptz,
  "refund_after" timestamptz NOT NULL,
  CONSTRAINT "repo_tips_received_check" CHECK (
    ("status" IN ('confirmed', 'paid', 'refunded') AND "received_amount" IS NOT NULL AND "received_amount" > 0 AND "signature" IS NOT NULL AND "confirmed_at" IS NOT NULL) OR
    ("status" NOT IN ('confirmed', 'paid', 'refunded') AND "received_amount" IS NULL)),
  CONSTRAINT "repo_tips_transfer_check" CHECK ("transfer_id" IS NULL OR "status" IN ('confirmed', 'paid', 'refunded')),
  CONSTRAINT "repo_tips_settled_check" CHECK ("status" NOT IN ('paid', 'refunded') OR "transfer_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX repo_tips_signature_unique ON repo_tips(signature);
--> statement-breakpoint
CREATE INDEX repo_tips_repo_status ON repo_tips(github_repo_id, status);
--> statement-breakpoint
CREATE INDEX repo_tips_donor ON repo_tips(donor_wallet, status);
--> statement-breakpoint
CREATE INDEX repo_tips_open ON repo_tips(status, created_at) WHERE status IN ('prepared', 'submitted');
--> statement-breakpoint
CREATE INDEX repo_tips_transfer ON repo_tips(transfer_id);
