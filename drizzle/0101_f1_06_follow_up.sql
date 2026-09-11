ALTER TABLE "project" ADD COLUMN "follow_up_at" timestamp with time zone;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F1-06 Lead-Wiedervorlage: optionaler Fälligkeitszeitpunkt je Anfrage
-- (NULL = keine Wiedervorlage). In-App-Eskalation auf Board/Dashboard,
-- kein Mailversand, keine neue Permission (project.read/write), kein
-- neuer Grant (gleiche Tabelle, Tabellen-Privilegien unverändert).
-- Hinweis: drizzle-kit hatte zusätzlich bereits angewandte Statements
-- aus 0096/0099/0100 erneut vorgeschlagen — hier bewusst nur das neue
-- Statement (Journal/Snapshot bleiben Zielstand).
-- ═══════════════════════════════════════════════════════════════════════
