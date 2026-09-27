-- Retain the existing partner event identities. Discovery eligibility is immutable
-- and defaults true for the already-recorded, eligible-only historical events.
ALTER TABLE discovery_fee_events ADD COLUMN discovery_eligible boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE platform_fee_claims ADD COLUMN phase varchar(4) NOT NULL DEFAULT 'DAMM';
--> statement-breakpoint
ALTER TABLE platform_fee_claims ADD COLUMN evidence text;
--> statement-breakpoint
ALTER TABLE platform_fee_claims ADD COLUMN receipt text;
--> statement-breakpoint
ALTER TABLE platform_fee_claims ADD CONSTRAINT platform_fee_claims_phase_check CHECK (phase IN ('DBC','DAMM'));
--> statement-breakpoint
ALTER TABLE platform_fee_claims ADD CONSTRAINT platform_fee_claims_dbc_evidence_check
  CHECK (phase <> 'DBC' OR (evidence IS NOT NULL AND (status <> 'settled' OR receipt IS NOT NULL)));
