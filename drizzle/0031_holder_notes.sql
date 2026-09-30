-- "Why I bought" holder notes (see src/holder-notes.mjs). One plain-text note per wallet per market, written only with
-- a wallet signature by a wallet that held the token and had an indexed buy. hidden_at: an operator hid it publicly.
CREATE TABLE "holder_notes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "mint" varchar(44) NOT NULL REFERENCES "markets"("mint"),
  "wallet" varchar(44) NOT NULL,
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 280),
  "balance_at_post" numeric(20, 0) NOT NULL CHECK ("balance_at_post" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "hidden_at" timestamptz,
  "hidden_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX holder_notes_mint_wallet_unique ON holder_notes(mint, wallet);
--> statement-breakpoint
CREATE INDEX holder_notes_public ON holder_notes(mint, updated_at DESC, id DESC) WHERE hidden_at IS NULL;
--> statement-breakpoint
CREATE INDEX holder_notes_recent ON holder_notes(updated_at DESC);
--> statement-breakpoint
-- Single-use signature nonces; rows are pruned after they expire (a sealed challenge is useless after expiry anyway).
CREATE TABLE "holder_note_nonces" (
  "nonce" varchar(32) PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX holder_note_nonces_expiry ON holder_note_nonces(expires_at);
