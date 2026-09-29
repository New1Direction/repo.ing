-- Finalized DBC -> DAMM v2 migration proof per graduated market. Written once after the
-- migration transaction is found and verified; reads reload the signature and must match.
CREATE TABLE "graduated_migration_proofs" (
  "github_repo_id" bigint PRIMARY KEY NOT NULL REFERENCES "markets"("github_repo_id"),
  "curve" varchar(44) NOT NULL,
  "config" varchar(44) NOT NULL,
  "mint" varchar(44) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "signature" varchar(88) NOT NULL,
  "slot" bigint NOT NULL,
  "creator_position" varchar(44) NOT NULL,
  "creator_nft_account" varchar(44) NOT NULL,
  "creator_nft_mint" varchar(44) NOT NULL,
  "partner_position" varchar(44) NOT NULL,
  "partner_nft_account" varchar(44) NOT NULL,
  "partner_nft_mint" varchar(44) NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "graduated_migration_proof_pool_unique" ON "graduated_migration_proofs" ("pool");
--> statement-breakpoint
CREATE UNIQUE INDEX "graduated_migration_proof_signature_unique" ON "graduated_migration_proofs" ("signature");
