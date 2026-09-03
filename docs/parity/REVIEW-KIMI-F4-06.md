# Kimi-K3-Reviews: F4.6 Workspace-Simulationsdefaults

## Spec-Review (OpenRouter kimi-k3, effort high)

**NACHBESSERUNG** (0 P0, 2 P1, 3 P2, 2 P3) — alle geschlossen:
- P1-1 Read-Semantik des Leerzustands → DTO mit revision 0 + nullable
  Feldern null, kein not_found (Spec + F406-DB-01).
- P1-2 hasAnyDefaults-Definition → „mindestens eines der 4 nullable
  Felder, Horizont zählt nie" (Spec + Contract-Tests).
- P2-1 Audit-Namespace → `economics.settings.write`, kein invoicing.*.
- P2-2 no_truncate/GRANT-Matrix + DEFAULT-20 → F406-DB-04 + Checks.
- P2-3 Präfix-Check → `_f406_` folgt 0045-Slice-Muster (`_m300_`).
- P3-1 Bereiche dokumentiert (negative Werte nicht darstellbar).

## Code-Review (OpenRouter kimi-k3, effort high)

**NACHBESSERUNG** (0 P0, 1 P1, 3 P2, 2 P3) — alle geschlossen:
- P1 ACL fehlt in Migration → KLARSTELLUNG: der REVOKE/GRANT-/EXECUTE-
  Vertrag liegt idempotent in `scripts/db-role-contract.mts`
  (applyRoleContract), die Live-Rollenprobe verifiziert ihn (88/88) —
  Kommentar in 0047 ergänzt. (Muster identisch zu 0045.)
- P2-2 hasAnyDefaults-Konsistenz → im DTO-Schema per superRefine
  ERZWUNGEN + beidseitige Negativ-Tests.
- P2-3 CAS-Loch baseRevision 0 bei existierender Zeile → F406-DB-05
  (Conflict, Revision bleibt).
- P2-4 Event/Audit-Beleg → F406-DB-06 (genau ein
  `workspace_economics_settings.upserted` + Audit
  `economics.settings.write`).
- P3-5 RETURN NULL im Exception-Zweig → DECIDED beibehalten (identisch
  zum 0045-/M3-00-Muster, fail-closed identisch).
- P3-6 Prozent→bps nur Punkt-Dezimal → E2E um Feld-Leerung ergänzt
  (null-Rücksetzung); Komma-Eingabe = DECIDED nicht unterstützt
  (type=number nach HTML-Spec).

## Nachweise

`npm run check` exit 0 (196 Dateien, 1883 passed/1 skipped, Rollenprobe
88/88 + PG18 5/5), Production-Build exit 0, `db:generate` keine Drift,
Chromium-E2E 2/2 (Editor persistiert + leert Felder, Viewer/External,
Axe A/AA).
