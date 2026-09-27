CREATE TABLE "finalized_chart_blocks" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"blockhash" varchar(44) NOT NULL,
	"previous_blockhash" varchar(44) NOT NULL,
	"parent_slot" bigint NOT NULL,
	"signatures" text[] NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
