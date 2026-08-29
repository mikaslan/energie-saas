# Restore-Drill-Log

Dieses Dokument ist das append-only Abnahmeprotokoll für wiederkehrende Disaster-
Recovery-Drills. Ein leerer Beispielblock ist **keine** Verifikation. Pilot/Produktion
bleibt BLOCKED, bis mindestens ein vollständiger Eintrag mit unabhängiger Review
vorliegt.

## Pflichtfelder je Drill

```text
Datum/Zeit (UTC):
Reviewer:
Quelltyp: PITR | verschlüsselter logischer Dump
Quellzeitpunkt:
Artefakt-SHA-256:
Zielprovider/Projekt/Branch:
Ziel-Host/Port/Datenbank:
Neon tenant_id:
Neon timeline_id:
PostgreSQL-Version:
Rollen-/Provider-Topologie-Version:
Migrationsjournal-Hash:

Start Restore:
Ende Restore:
Gemessenes RPO:
Gemessenes RTO:

Zielrollen/Membership/Settings: PASS | FAIL
DB-/Schema-/Relation-/Routine-/Typowner: PASS | FAIL
ACL/Default-ACL/RLS/Policies/Trigger: PASS | FAIL
Tenant-Stichprobe und Zeilenzahlen: PASS | FAIL
Kontakt-/Standortstichprobe: PASS | FAIL
pg-boss-Job/Stichprobe: PASS | FAIL
Beleg-/PDF-Hash: PASS | FAIL
Runtime/Auth/Worker-Live-Principal: PASS | FAIL

Negativproben:
- falscher Owner wird erkannt: PASS | FAIL
- fehlende Membership wird erkannt: PASS | FAIL
- fehlender pg-boss-Constraint wird erkannt: PASS | FAIL
- falscher Tenant/Timeline-Branch wird erkannt: PASS | FAIL
- unvollständiger Dump wird erkannt: PASS | FAIL
- verlorenes Freeze-/Unfreeze-COMMIT-ACK wird frisch reattestiert/refrozen: PASS | FAIL
- fehlgeschlagener Fresh-Reconnect meldet „Zustand unbestätigt“: PASS | FAIL
- fehlgeschlagenes ROLLBACK verwirft die alte Session vor Fresh-Refreeze: PASS | FAIL

Offene Befunde (Severity + Owner + Frist):
Freigabeentscheidung: GO | NO-GO
Sign-off Mikail:
```

## Ausgeführte Drills

Noch keiner. Status: **BLOCKED**.
