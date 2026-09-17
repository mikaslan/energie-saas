# SPEC F7-07b — Handover-Gegenzeichnung (on-screen, intern)

## Matrix
Katalog F7.7: „On-Screen-Kundenunterschrift". F7-05 (Abnahme Wer/Wann/
Notiz) + F7-14 (Historie) VERIFIED; Gegenzeichnung offen. Portal-Pfad
bleibt per F7-05-Spec blockiert (Q-ARCHIV-OBJECT-LOCK-REFERENZ) —
dieser Slice ist INTERN (Geraet des Monteurs, Kunde gegenwaertig),
ESTIMATE ohne Rechts-Behauptungen; Ablage WORM wie 02i.

## Ziel
Kunden-Gegenzeichnung zur Abnahme: Name (Freitext 1-160, keine
Identitaetsbehauptung) + Unterschrift (Canvas-PNG) + Zeitstempel,
am Installations-Kopf, korrigierbar wie die Abnahme (erneutes
Gegenzeichnen ueberschreibt), lesbar fuer alle (Vorschau), Reload-fest.

## Entwurf (recordHandover-Spiegel + 02i-Canvas)
- Neue Kopf-Spalten `installation.handover_customer_name`,
  `handover_customer_signature_key`, `handover_customer_signed_at`
  (alle NULL = keine Gegenzeichnung; Co-Set-CHECK: alle oder keine).
- Key-Schema (projekt-skoped, F10-10-Praezedenz, eigene Domain):
  `immutableKey(projectId, "installation-signatures", installationId_sha8.png)`.
  PNG-only (Canvas; JPEG braucht hier niemand).
- Service-Op `recordHandoverCountersignature` (installation.write, eine
  Transaktion: validieren → putImmutable + Beleg → UPDATE):
  Guards: Installation da (NotFound), completed, Abnahme vorhanden
  (handover_at NOT NULL — ohne Abnahme keine Gegenzeichnung), Name
  1-160 getrimmt, PNG ≤ 10 MiB nicht-leer. Event
  `installation.handover_countersigned` + Audit
  `installation.handover.countersign` (kein Key/Name im Detail? Name
  ist PII — Details nur projectId wie recordHandover).
- Lese-Op `readHandoverCountersignature` (installation.read): Name,
  Zeit, Bytes (Viewer sieht Vorschau). Key nie projiziert (DTO ohne
  Key; DB-Spalte nur Service-intern).
- Route POST/GET `.../installation/gegenzeichnung` (Session, 10 MiB,
  nosniff, uniforme Fehler — foto-Routen-Spiegel).
- UI installation-section: Abnahme-Block zeigt Gegenzeichnung (Name/
  Zeit/Vorschau); Formular (completed + handoverAt + canWrite): Name,
  Canvas (300x100, Tap-Punkt, Loeschen), „Gegenzeichnung speichern",
  Leer-Hinweis. Canvas-Logik dupliziert (klein, dokumentiert; kein
  app-cross-Import).

## Vertrag DB (0176)
- 3 Spalten + CHECKs (Name-Regel wie by_name_ck; Key-Regex;
  signed_at isfinite; Co-Set-Tripel). Keine RLS-Aenderung (gleiche
  Tabelle/Policies), aber Spalten-Pins neu harvesten (F10-14-Praezedenz).
- Drizzle-Schema + `db:generate`-Snapshot 0176 (Drift-frei).

## Vertrag App
- InstallationDto + handoverCustomerName/SignedAt (kein Key);
  ROW_COLUMNS + toDto; Portal-Projektion unberuehrt (eigener Resolver).
- Zod: Name getrimmt 1-160 (recordHandover-Spiegel); PNG-Allowlist,
  10 MiB, Beleg-Integritaet, WORM-Idempotenz mit Read-back (02g-Spiegel).
  Restrisiko akzeptiert (02g-Praezedenz): sha8-Praefixkollision bei
  ungleichem Inhalt (1/2^32) schlaegt dauerhaft mit Beleg-Fehler fehl.

## Sicherheit
- PNG-only, Limits, Keys nur Service-seitig, uniforme Fehler ohne Key;
  Name-PII nicht in Event/Audit; Viewer read-only; Fremdtenant NotFound.

## Tests (RED zuerst)
- DB: `tests/db/f707b-handover-countersign.test.ts` — Happy (Tripel
  gesetzt, lesbar); Guards (active, ohne Abnahme, Fremd-Installation,
  Leer-Name, Fehltyp, Uebergroesse); Re-Gegenzeichnung ueberschreibt;
  Tenant-Orakel-frei.
- E2E: `tests/e2e/f7-07b-handover-countersign.spec.ts` — Anlegen →
  Abschliessen → Abnehmen → Gegenzeichnen (Name+Canvas) → Vorschau →
  Reload → Viewer, Axe. (F705-Flow-Praezedenz f7-01-Spec.)
- Nachbarn: f7-01 (Installation-Kern) + Portal-Installation (F10-03/05/09/14).

## Akzeptanz
- `npm run check` gruen (inkl. db:generate ohne Drift); E2E gruen;
  Heartbeat + Push + CI gruen.
