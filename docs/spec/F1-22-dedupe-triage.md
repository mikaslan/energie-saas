# F1-22 Duplikat-Triage-Fläche (T7) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. KEINE Migration. Quelle: Schwarm-Spec S7 (reviewed).

## DISCOVERED

- Flags existieren (contact+project), 3 Setzer-Pfade (Intake/Manuell/Bulk),
  Blocker lesen sie (Angebot hart blockiert). **Kernlücke: KEIN Pfad setzt
  je ein Flag zurück — sticky, Angebot dauerhaft blockiert.** Keine Triage-UI.

## SPECIFIED

- Route `/w/[ws]/dubletten` (Queue) + `/dubletten/[entity]/[id]` (Detail).
  Queue: UNION Kontakt-/Projekt-Flags + candidate_count (Intake-Regel),
  Filter entity/sourceKey/q, RBAC zeilenweise.
- Detail: Gegenüberstellung (max 10 Kandidaten), Lesen ändert NICHTS.
- Aktion 1 `markDedupeReviewed`: Flag→false (Kontakt: FOR UPDATE+Revision;
  Projekt: FOR UPDATE+Flag-Check, idempotent `changed:false`).
- Aktion 2 `linkDedupeProject`: Projekt→Kanon-Kontakt atomar INKLUSIVE
  `site.contact_id`-Mitziehen (FK-Falle!), Flag→false.
- VERBOTEN: stiller Merge, Auto-Merge/Auto-Clear, Bulk-Clear ohne Guards.

## CONTRACTED

- NEU: `modules/dedupe/*`, dubletten-Routen, `f122` DB + E2E-Spec.
- EDIT: Blocker-Links → Triage (nur Linkziele).
- DB-Tests (5): Queue/Detail/Mark/Link/Negativ-kein-Merge. E2E: Editor-Flow
  (Blocker löst sich), Viewer read-only, Extern 403.
