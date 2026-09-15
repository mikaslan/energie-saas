-- F16-04e Vorlagen mit Label-Inhalt (Katalog F16.3).
-- `task_template` trägt Label-Inhalt als JSON-Array (leer = ohne).
-- Cap 15 spiegelt PROJECT_TASK_MAX_LABELS. Anwenden erzeugt daraus
-- Task-Labels (IDs entstehen erst dort); kein RLS-/Grant-Umbau.
ALTER TABLE "task_template" ADD COLUMN "label_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_template" ADD CONSTRAINT "task_template_labels_ck" CHECK (jsonb_typeof("task_template"."label_items") = 'array' and jsonb_array_length("task_template"."label_items") <= 15);