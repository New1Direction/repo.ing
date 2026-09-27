CREATE TABLE "repo_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"beneficiary_wallet" varchar(44) NOT NULL,
	"amount_base_units" bigint NOT NULL,
	"asset" varchar(44) NOT NULL,
	"claim_signature" varchar(88) NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "repo_claims_positive_amount_check" CHECK ("repo_claims"."amount_base_units" > 0),
	CONSTRAINT "repo_claims_status_check" CHECK ("repo_claims"."status" in ('pending', 'settled')),
	CONSTRAINT "repo_claims_settlement_check" CHECK (("repo_claims"."status" = 'pending' and "repo_claims"."settled_at" is null) or ("repo_claims"."status" = 'settled' and "repo_claims"."settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "repo_claims" ADD CONSTRAINT "repo_claims_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_claims_signature_unique" ON "repo_claims" USING btree ("claim_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_claims_one_pending_per_repo" ON "repo_claims" USING btree ("github_repo_id") WHERE "repo_claims"."status" = 'pending';