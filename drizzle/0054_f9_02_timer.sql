ALTER TABLE "time_entry" DROP CONSTRAINT "time_entry_interval_ck";--> statement-breakpoint
ALTER TABLE "time_entry" DROP CONSTRAINT "time_entry_minutes_ck";--> statement-breakpoint
ALTER TABLE "time_entry" DROP CONSTRAINT "time_entry_break_ck";--> statement-breakpoint
ALTER TABLE "time_entry" ALTER COLUMN "end_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entry" ALTER COLUMN "working_time_minutes" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "time_entry_ws_user_running_uq" ON "time_entry" USING btree ("workspace_id","user_id") WHERE "time_entry"."end_at" is null;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_running_ck" CHECK (("time_entry"."end_at" is null and "time_entry"."working_time_minutes" is null) or ("time_entry"."end_at" is not null and "time_entry"."working_time_minutes" is not null));--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_interval_ck" CHECK (("time_entry"."end_at" is null or "time_entry"."end_at" >= "time_entry"."start_at") and pg_catalog.isfinite("time_entry"."start_at") and ("time_entry"."end_at" is null or pg_catalog.isfinite("time_entry"."end_at")));--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_minutes_ck" CHECK ("time_entry"."working_time_minutes" is null or "time_entry"."working_time_minutes" between 0 and 1440);--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_break_ck" CHECK ("time_entry"."break_duration_minutes" between 0 and 1440 and ("time_entry"."working_time_minutes" is null or "time_entry"."break_duration_minutes" <= "time_entry"."working_time_minutes"));