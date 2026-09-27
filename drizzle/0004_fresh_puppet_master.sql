CREATE TABLE "repo_beneficiaries" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_binding_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"github_user_id" bigint NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ADD CONSTRAINT "repo_beneficiaries_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" ADD CONSTRAINT "wallet_binding_challenges_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_binding_challenges_nonce_unique" ON "wallet_binding_challenges" USING btree ("nonce");