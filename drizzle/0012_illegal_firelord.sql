CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD COLUMN "issuer" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_issuer_accountId_uidx" ON "auth_account" USING btree ("issuer","account_id");