ALTER TABLE "installation" ADD COLUMN "lead_installer_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_lead_installer_membership_fk" FOREIGN KEY ("workspace_id","lead_installer_membership_id") REFERENCES "public"."membership"("workspace_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installation_ws_lead_installer_idx" ON "installation" USING btree ("workspace_id","lead_installer_membership_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F7-05 Slice 3: Spalte auf RLS-geschützter Tabelle (tenant_isolation +
-- FORCE bleiben Tabellen-Policies; keine neue Policy nötig).
-- Schreiben: installation.write im Service-Layer (keine neue Permission).
-- ═══════════════════════════════════════════════════════════════════════
