CREATE TABLE builder_reminders (
  github_user_id bigint PRIMARY KEY,
  email text NOT NULL,
  revision varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  last_sent_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  baseline text NOT NULL DEFAULT '{}',
  delivery text
);
--> statement-breakpoint
CREATE TABLE builder_reminder_requests (
  key varchar(64) PRIMARY KEY,
  requested_at timestamptz NOT NULL
);
