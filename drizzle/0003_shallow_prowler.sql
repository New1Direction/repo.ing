CREATE TABLE "repo_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"permission" varchar(16) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_verifications_admin_check" CHECK ("repo_verifications"."permission" = 'admin')
);
--> statement-breakpoint
ALTER TABLE "repo_verifications" ADD CONSTRAINT "repo_verifications_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;