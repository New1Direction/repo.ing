-- Owner-booked custody transfers (owner 2026-10-28: "Book as paid to me"). Fees the vault collected and then moved to the
-- team wallet in one transaction for many repositories (the 2026-10-26 sweep) cannot be custody payouts: those are one row
-- per real signature and pay a repository's bound beneficiary. Each row here books one collection item as paid to the
-- owner: it leaves custody (custody balance and solvency count it as paid out) and, for the creator role, it settles the
-- builder's entitlement (owed and reconciled claimed include it). transfer_signature is the real transaction that moved
-- the funds out of the vault; it repeats across rows by design. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custody_owner_transfers" (
  "collection_signature" varchar(88) NOT NULL,
  "collection_item_index" integer NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "role" text NOT NULL CHECK ("role" IN ('creator', 'partner')),
  "amount" numeric(20, 0) NOT NULL CHECK ("amount" > 0),
  "transfer_signature" varchar(88) NOT NULL,
  "recipient" varchar(44) NOT NULL,
  "decision" text NOT NULL,
  "recorded_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "custody_owner_transfers_pkey" PRIMARY KEY ("collection_signature", "collection_item_index"),
  CONSTRAINT "custody_owner_transfers_collection_fk" FOREIGN KEY ("collection_signature", "collection_item_index")
    REFERENCES "custody_fee_collections"("signature", "item_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_owner_transfers_repo" ON "custody_owner_transfers" ("github_repo_id", "role");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repoing_builder_claims') THEN
    GRANT SELECT ON custody_owner_transfers TO repoing_builder_claims;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repoing_ledger_reader') THEN
    GRANT SELECT ON custody_owner_transfers TO repoing_ledger_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repoing_custody_recorder') THEN
    GRANT SELECT ON custody_owner_transfers TO repoing_custody_recorder;
  END IF;
END $$;
