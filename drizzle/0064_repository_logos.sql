-- One logo per token (app/api/repo-logo/[repo]/route.js, src/repo-logo.mjs). Once a repository has a market, the first README
-- or asset-directory image that passes the project-logo rule is stored here and served from then on, so a later README edit
-- or a GitHub outage cannot change the icon that wallets, Blinks and link previews keep. logo_url: that image (null: none
-- stored; the market then shows its owner's avatar, which is never stored). logo_pinned_at: when it was stored.
-- Expand-only and idempotent: two nullable columns, each added only if missing. No existing row changes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "logo_url" text;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "logo_pinned_at" timestamptz;
