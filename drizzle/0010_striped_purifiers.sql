ALTER TABLE "user_identity" DROP CONSTRAINT "user_identity_email_unique";--> statement-breakpoint
ALTER TABLE "user_identity" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identity_email_lower_uq" ON "user_identity" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "site_ws_id_uq" ON "site" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_auth_user_id_unique" UNIQUE("auth_user_id");