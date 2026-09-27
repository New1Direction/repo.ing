ALTER TABLE "markets" ADD COLUMN "launch_slot" bigint;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "launch_finality" varchar(16);--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_indexed_evidence_check" CHECK ("markets"."indexed_at" is null or ("markets"."launch_slot" is not null and "markets"."launch_finality" = 'finalized' and "markets"."last_verified_at" is not null));