CREATE TABLE "pool_fee_cursors" (
	"pool" varchar(44) PRIMARY KEY NOT NULL,
	"last_signature" varchar(88) NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
