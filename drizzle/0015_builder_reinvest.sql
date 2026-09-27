CREATE TABLE "builder_reinvest_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"claim_id" integer NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"github_user_id" text NOT NULL,
	"source_amount" bigint NOT NULL,
	"terms" text NOT NULL,
	"terms_hash" varchar(64) NOT NULL,
	"prepared_transaction" text NOT NULL,
	"signed_transaction" text,
	"signature" varchar(88),
	"position" varchar(44) NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(16) NOT NULL,
	"simulation" text NOT NULL,
	"settlement" text,
	"settled_debit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	CONSTRAINT "builder_reinvest_amount_check" CHECK ("builder_reinvest_intents"."source_amount" > 0 and ("builder_reinvest_intents"."settled_debit" is null or ("builder_reinvest_intents"."settled_debit" > 0 and "builder_reinvest_intents"."settled_debit" <= "builder_reinvest_intents"."source_amount"))),
	CONSTRAINT "builder_reinvest_status_check" CHECK ("builder_reinvest_intents"."status" in ('prepared','cancelling','submitted','settled','aborted')),
	CONSTRAINT "builder_reinvest_settlement_check" CHECK (("builder_reinvest_intents"."status" = 'settled' and "builder_reinvest_intents"."settled_at" is not null and "builder_reinvest_intents"."signature" is not null and "builder_reinvest_intents"."signed_transaction" is not null and "builder_reinvest_intents"."settled_debit" is not null and "builder_reinvest_intents"."settlement" is not null) or ("builder_reinvest_intents"."status" <> 'settled' and "builder_reinvest_intents"."settled_at" is null and "builder_reinvest_intents"."settled_debit" is null))
);
--> statement-breakpoint
ALTER TABLE "builder_reinvest_intents" ADD CONSTRAINT "builder_reinvest_intents_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_reinvest_intents" ADD CONSTRAINT "builder_reinvest_intents_claim_id_repo_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."repo_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_reinvest_idempotency_unique" ON "builder_reinvest_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_reinvest_signature_unique" ON "builder_reinvest_intents" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_reinvest_position_unique" ON "builder_reinvest_intents" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_reinvest_one_open_per_claim" ON "builder_reinvest_intents" USING btree ("claim_id") WHERE "builder_reinvest_intents"."status" in ('prepared','cancelling','submitted');