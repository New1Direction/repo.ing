-- Optional "Connect X" (see src/x-links.mjs). A wallet shows the X @handle it linked with X OAuth plus a wallet
-- signature. One X account per wallet and one wallet per X account; no OAuth tokens are stored.
CREATE TABLE "x_links" (
  "wallet" varchar(44) PRIMARY KEY NOT NULL,
  "x_user_id" varchar(20) NOT NULL,
  "username" varchar(15) NOT NULL CHECK ("username" ~ '^[A-Za-z0-9_]{1,15}$'),
  "name" varchar(64),
  "profile_image_url" varchar(300) CHECK ("profile_image_url" IS NULL OR "profile_image_url" LIKE 'https://pbs.twimg.com/%'),
  "verified" boolean NOT NULL DEFAULT false,
  "linked_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX x_links_x_user_unique ON x_links(x_user_id);
--> statement-breakpoint
-- An X sign-in waiting (≤10 minutes) for the wallet's signature. The row id is the single-use nonce it signs.
CREATE TABLE "x_link_pending" (
  "id" varchar(32) PRIMARY KEY NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "x_user_id" varchar(20) NOT NULL,
  "username" varchar(15) NOT NULL CHECK ("username" ~ '^[A-Za-z0-9_]{1,15}$'),
  "name" varchar(64),
  "profile_image_url" varchar(300) CHECK ("profile_image_url" IS NULL OR "profile_image_url" LIKE 'https://pbs.twimg.com/%'),
  "verified" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX x_link_pending_expiry ON x_link_pending(expires_at);
--> statement-breakpoint
-- Single-use unlink signature nonces; pruned after expiry.
CREATE TABLE "x_link_nonces" (
  "nonce" varchar(32) PRIMARY KEY NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX x_link_nonces_expiry ON x_link_nonces(expires_at);
