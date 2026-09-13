-- F16-04b Mehrfach-Bearbeiter aus Aufgaben-Vorlage (Katalog F16.3).
-- `task_template` trägt optionale Bearbeiter-Memberships (UUID-Array,
-- leer = nur Anwendender wie bisher). Cap 50 spiegelt
-- PROJECT_TASK_MAX_ASSIGNEES aus dem Task-Vertrag. Auflösen beim Anwenden
-- (Ausgeschiedene entfallen, Fallback Anwender); Schreiben validiert
-- fail-closed gegen interne Workspace-Memberships. Kein RLS-/Grant-Umbau.
ALTER TABLE "task_template" ADD COLUMN "assignee_membership_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_template" ADD CONSTRAINT "task_template_assignees_ck" CHECK (pg_catalog.cardinality("task_template"."assignee_membership_ids") <= 50);