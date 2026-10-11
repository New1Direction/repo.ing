-- Every pack pays a builder (src/builder-pack-shares.mjs): the repository a pack is opened for and the share rate, stored
-- with the request so a retry asks for the same quote. The credit ledger records the share itself. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_repo_id" bigint;
--> statement-breakpoint
ALTER TABLE "credit_pack_purchases" ADD COLUMN IF NOT EXISTS "builder_share_bps" integer;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_pack_purchases_builder_check') THEN
    ALTER TABLE "credit_pack_purchases" ADD CONSTRAINT "credit_pack_purchases_builder_check" CHECK (("builder_repo_id" IS NULL) = ("builder_share_bps" IS NULL)
      AND ("builder_repo_id" IS NULL OR ("builder_repo_id" BETWEEN 1 AND 4503599627370495 AND "builder_share_bps" BETWEEN 1 AND 2000)));
  END IF;
END $$;
