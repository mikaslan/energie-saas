# F1-06b Wiedervorlagen-Widget (Dashboard-Eskalation)

Ziel: Die in F1-06 als „Bewusst offen: Dashboard-Widget" geführte
Lücke schließen. Das Dashboard zeigt handlungsbedürftige
Wiedervorlagen (fällig/überfällig/eskaliert) über alle offenen
Anfragen — ohne Mailversand, ohne Worker, ohne neue Permission.

## ESTIMATE (reversibel, Referenzfrage offen)

- Lesepfad ohne Migration: `listFollowUpDashboard` über `project`
  (`phase = 'request'`, `outcome = 'open'`, `follow_up_at NOT NULL`),
  Bänder in TS via `followUpBandForDate` (gleiche Regel wie Board).
  Nur Bänder `due`/`overdue`/`escalated` (Anstehend ist kein
  Handlungsbedarf), sortiert `follow_up_at` aufsteigend (fälligste
  zuerst), Default-Limit 5.
- Berechtigung: `project.read` (KEIN neuer Key). Externe Leser:
  leere Liste (internes Arbeitsdatum — kein Signal, kein Filter,
  gleiche Regel wie F1-06-Spec).
- Anzeige: Dashboard-Sektion „Wiedervorlagen" (Projektname, Band,
  Berlin-Datum, Projekt-Link; Leerzustand „Nichts überfällig oder
  fällig."; Fuß-Link „Alle überfälligen" auf
  `/anfragen?wiedervorlage=ueberfaellig`). ESTIMATE-Layout, nur
  gespeicherte Werte.

## Scopes

1. `listFollowUpDashboard(tx, ctx, { limit })` (fail-closed:
   Validation, Fremdtenant leer via Workspace-Scope, Viewer lesen
   ok, Extern leer).
2. Dashboard-Loader + Sektion (Muster DASH-01-Aufgabenkarten).
3. Tests: DB (Bänder/Sortierung/Limit/Isolation/RBAC/Extern),
   E2E (Lead + Überfällig-Datum → Widget zeigt Band + Link).

## Geschlossene Testmatrix

- `F106B-DB-01`: eskaliert/überfällig/fällig/anstehend/ohne →
  nur handelbare in Datumsordnung, Limit greift.
- `F106B-DB-02`: geschlossenes Projekt (won) + Fremdmandant
  unsichtbar; Viewer lesen ok; Extern leer; Limit-Validation.
- `F106B-E2E-01`: manueller Lead + Überfällig-Datum → Dashboard
  zeigt Projekt + „Überfällig" + Preset-Link.

## Bewusst offen

- Echte Erinnerungszustellung (Mail/Push), Eskalations-Workflows mit
  Zuweisung, wiederkehrende Wiedervorlagen.
