ALTER TABLE "time_entry" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_entry" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_approved_by_fk" FOREIGN KEY ("workspace_id","approved_by") REFERENCES "public"."membership"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;