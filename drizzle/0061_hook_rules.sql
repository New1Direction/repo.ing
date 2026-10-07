-- Contributor early access options (docs/EARLY_ACCESS.md): the hook rules a launch was made with, as the program's bit set: 1
-- early access, 3 with the fair ramp, 7 with star unlocks too. The ramp and star unlocks are options of an early access launch
-- only (owner decision, 2026-10-07), so the rules are set only with the window; a window without them is early access alone, as
-- before this migration (src/early-access-rules.mjs, marketHookRules; launch evidence compares them with the hook's mint config).
-- Expand-only and idempotent: re-applying this file changes nothing. No backfill: a market stamped before it keeps NULL, which
-- reads as early access alone (and no early access market had launched when it was written).
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "hook_rules" smallint;
--> statement-breakpoint
-- Only with the window; one of the three sets the launch form offers. The IS NOT NULL term matters (a CHECK that evaluates to
-- NULL passes).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_hook_rules_check' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_hook_rules_check" CHECK (
      "hook_rules" IS NULL OR ("early_access_end" IS NOT NULL AND "hook_rules" IN (1, 3, 7)));
  END IF;
END $$;
--> statement-breakpoint
-- As the window (0059): the rules may change while the launch is unsent, and never once it was sent or indexed.
CREATE OR REPLACE FUNCTION protect_market_early_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status IN ('submitted', 'ambiguous', 'confirmed') OR NEW.status IN ('submitted', 'ambiguous', 'confirmed') OR
      OLD.indexed_at IS NOT NULL OR NEW.indexed_at IS NOT NULL) AND (
      NEW.early_access_end IS DISTINCT FROM OLD.early_access_end OR NEW.transfer_hook_program IS DISTINCT FROM OLD.transfer_hook_program OR
      NEW.hook_rules IS DISTINCT FROM OLD.hook_rules) THEN
    RAISE EXCEPTION 'Market early access is immutable once its launch was sent';
  END IF;
  RETURN NEW;
END $$;
