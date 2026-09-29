-- Public $REPOING buyback disclosures detected from finalized wallet history. Append-only;
-- a signature is recorded once. Disclosure only: never debits the revenue ledger or enables spending.
CREATE TABLE "buyback_receipts" (
  "signature" varchar(88) PRIMARY KEY NOT NULL,
  "source" varchar(16) NOT NULL CHECK ("source" IN ('custody', 'team')),
  "wallet" varchar(44) NOT NULL,
  "mint" varchar(44) NOT NULL,
  "spent_lamports" numeric(20, 0) NOT NULL CHECK ("spent_lamports" > 0),
  "token_base_units" numeric(30, 0) NOT NULL CHECK ("token_base_units" > 0),
  "block_time" timestamptz NOT NULL,
  "slot" bigint NOT NULL,
  "detected_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Newest fully processed signature per wallet; the scan resumes above it.
CREATE TABLE "buyback_receipt_cursors" (
  "wallet" varchar(44) PRIMARY KEY NOT NULL,
  "last_signature" varchar(88) NOT NULL,
  "last_slot" bigint NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
