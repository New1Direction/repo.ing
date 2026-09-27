CREATE TABLE "discovery_claims" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"amount" bigint NOT NULL,
	"status" varchar(16) NOT NULL,
	"transaction" text NOT NULL,
	"signature" varchar(88),
	"last_valid_block_height" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"resolution_reason" text,
	CONSTRAINT "discovery_claims_amount_check" CHECK ("discovery_claims"."amount" > 0 and "discovery_claims"."amount" <= 1000000000),
	CONSTRAINT "discovery_claims_status_check" CHECK ("discovery_claims"."status" in ('prepared', 'pending', 'settled', 'aborted')),
	CONSTRAINT "discovery_claims_evidence_check" CHECK (("discovery_claims"."status" not in ('pending', 'settled') or "discovery_claims"."signature" is not null) and ("discovery_claims"."status" <> 'settled' or "discovery_claims"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "discovery_fee_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pool" varchar(44) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"partner_amount" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "discovery_fee_events_positive_check" CHECK ("discovery_fee_events"."partner_amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "discovery_version" integer;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "launch_block_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD CONSTRAINT "discovery_claims_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_fee_events" ADD CONSTRAINT "discovery_fee_events_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_claims_signature_unique" ON "discovery_claims" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_claims_one_active" ON "discovery_claims" USING btree ("github_repo_id") WHERE "discovery_claims"."status" in ('prepared', 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_fee_events_chain_unique" ON "discovery_fee_events" USING btree ("signature","event_index");--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_discovery_version_check" CHECK ("markets"."discovery_version" is null or "markets"."discovery_version" = 1);