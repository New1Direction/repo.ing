-- Discovery (launcher) reward claims are authorized by a signed plain-text message instead of a wallet-signed
-- transaction (see src/discovery-claims.mjs). A 'prepared' claim now stores the exact message and its expiry and has
-- no transaction yet; the server-built, fully signed payout (transaction, signature, last_valid_block_height) is
-- written together with the wallet's message signature when the claim becomes 'pending', before any broadcast.
-- Rows prepared before this migration (auth_message IS NULL) keep their unsigned wallet transaction and settle as before.
ALTER TABLE "discovery_claims" ALTER COLUMN "transaction" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_claims" ALTER COLUMN "last_valid_block_height" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD COLUMN "auth_message" text;
--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD COLUMN "auth_expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD COLUMN "auth_signature" varchar(88);
--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD CONSTRAINT "discovery_claims_authorization_check" CHECK (
  ("auth_message" IS NULL AND "auth_expires_at" IS NULL AND "auth_signature" IS NULL
    AND "transaction" IS NOT NULL AND "last_valid_block_height" IS NOT NULL) OR
  ("auth_message" IS NOT NULL AND "auth_expires_at" IS NOT NULL AND (
    ("status" IN ('prepared', 'aborted') AND "transaction" IS NULL AND "last_valid_block_height" IS NULL AND "auth_signature" IS NULL) OR
    ("status" IN ('pending', 'settled', 'aborted') AND "transaction" IS NOT NULL AND "last_valid_block_height" IS NOT NULL AND "auth_signature" IS NOT NULL))));
