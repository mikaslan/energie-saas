-- ═══════════════════════════════════════════════════════════════════════
-- F13-07 BnD-Beleg-Upload (Katalog F13.2-Folge): Datei-Anfragen lassen
-- sich mit einer Förderakte verknüpfen (Beleg für den BnD-Nachweis).
-- Spalte file_request.subsidy_case_id (nullable) mit Composite-FK auf
-- subsidy_case(workspace_id, id) — Mandantbindung auf DB-Ebene;
-- Projektgleichheit prüft der Service (Muster requireProject).
-- RLS/Grants/Resolver unverändert (tenant_isolation über
-- workspace_id; Portal-Projektion braucht die Verknüpfung nicht).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "file_request" ADD COLUMN "subsidy_case_id" uuid;--> statement-breakpoint
ALTER TABLE "file_request" ADD CONSTRAINT "file_request_subsidy_case_fk" FOREIGN KEY ("workspace_id","subsidy_case_id") REFERENCES "public"."subsidy_case"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_request_ws_case_idx" ON "file_request" USING btree ("workspace_id","subsidy_case_id");--> statement-breakpoint
