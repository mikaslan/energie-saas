-- F16-04d Vorlagen mit Checklisten-Inhalt (Katalog F16.3).
-- `task_template` trägt reine Checklisten-Texte als JSON-Array
-- (leer = ohne). Cap 100 spiegelt PROJECT_TASK_MAX_CHECKLIST_ITEMS.
-- Anwenden erzeugt daraus unerledigte Task-Items; kein RLS-/Grant-Umbau.
ALTER TABLE "task_template" ADD COLUMN "checklist_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_template" ADD CONSTRAINT "task_template_checklist_ck" CHECK (jsonb_typeof("task_template"."checklist_items") = 'array' and jsonb_array_length("task_template"."checklist_items") <= 100);