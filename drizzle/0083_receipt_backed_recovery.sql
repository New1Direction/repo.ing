-- Forward-only expansion. No historical data is imported by this migration.
-- Roll back application use first; never drop retained receipt evidence to roll back code.
ALTER TABLE builder_fee_collections ADD COLUMN evidence_source text NOT NULL DEFAULT 'signed-intent';
--> statement-breakpoint
ALTER TABLE builder_fee_collections ALTER COLUMN expires_at DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE builder_fee_collections DROP CONSTRAINT builder_fee_collections_check;
--> statement-breakpoint
ALTER TABLE builder_fee_collections ADD CONSTRAINT builder_fee_collections_evidence_check CHECK (
  (evidence_source='signed-intent' AND expires_at IS NOT NULL
    AND (status NOT IN ('pending','settled') OR
      (signature IS NOT NULL AND signed_transaction IS NOT NULL AND last_valid_block_height IS NOT NULL)))
  OR (evidence_source='historical-receipt' AND status='settled' AND signature IS NOT NULL
    AND receipt IS NOT NULL AND signed_transaction IS NULL AND last_valid_block_height IS NULL AND expires_at IS NULL)
);
