# SPEC F10-16 — Gegenzeichnung in der Portal-Timeline (Katalog F7.7/F10.2)

## Matrix
F7.7 verlangt „On-Screen-Kundenunterschrift" + „oeffentliche
Status-Timeline ohne Login". F7-07b (Migration 0176) hat die
Gegenzeichnung INTERN (Event `installation.handover_countersigned`,
service.ts:534, Payload nur projectId — Name/PNG bleiben intern).
Die Portal-Timeline (F10-03b, Resolver-Stand 0172) projiziert nur
3 Typen: SQL-Allowlist created/completed/handover_recorded
(0172-Z.234-249), Zod-Enum identisch (portal-contract.ts:172),
Formatter faellt fuer Unbekanntes auf „Ereignis" zurueck
(portal-language.ts:393-401). Die Gegenzeichnung erreicht den
Kunden NICHT — belegte Luecke an allen drei Schichten. Fix:
4. Typ in Allowlist + Anzeige, weiter nur Typ+Zeit+Tag
(Portalregel „nie Namen/Notizen", F10-03b-Praezedenz).
Verworfen (belegt): B) Datei-Anfragen Loeschen/Storno —
Katalog F10.2 nennt nur „Templates: Titel, Dateityp, Allow many"
(alle VERIFIED: F10-04, 0170/F10-13, 0120), Storno unbelegt →
verboten. C) Handover-Korrektur im Portal — recordHandover
emittiert pro (erneuter) Abnahme `handover_recorded`
(service.ts:396-404), Korrekturen erscheinen bereits als weitere
„Abgenommen"-Zeile; Historie-Details unbelegt. D) Portal-Termine
Absage/Verschieben — Katalog F10.2 nennt nur „Termine", kein
Kunden-Schreibpfad belegt → verboten.

## Ziel
Nach Gegenzeichnung zeigt die Portal-Timeline (Installations-Tab)
eine vierte Zeile „Gegengezeichnet am …" (Berlin-Tag, je
Portalsprache) — ohne Kundenname, ohne Unterschrift, ohne Notiz.
Erneutes Gegenzeichnen erzeugt folgerichtig eine weitere Zeile
(handover-Spiegel: ein Event je Op). Ohne Gegenzeichnung aendert
sich nichts (3 Zeilen wie bisher, leere Timeline ehrlich leer).

## Entwurf (Allowlist + Wort, kein neuer Pfad)
- Resolver: `installation.handover_countersigned` →
  `handover_countersigned` in CASE + IN-Liste (beide
  Owner-Tanz-Ruempfe, 0172-Vollkopie). Event existiert,
  Payload ist bereits PII-frei (nur projectId).
- Zod: `portalInstallationTimelineEntrySchema`-Enum +
  `handover_countersigned` (strikt wie bisher; fremde Typen
  kommen weiter per SQL-IN gar nicht erst heraus).
- Sprache: `PORTAL_TIMELINE_WORD` + Schluessel `countersigned`
  in allen 11 Sprachen (DE „Gegengezeichnet", EN
  „Countersigned", Rest ESTIMATE); `formatPortalTimelineEntry`
  + Zweig. Page unveraendert (mappt bereits generisch ueber
  den Formatter, page.tsx:331-333).
- Kein neuer Status: Installation bleibt `completed`;
  F10-05-Labels + F10-14-Sichtbarkeit (active/completed/
  handover) unberuehrt — Gegenzeichnung ist Timeline-Zeile,
  kein Anzeigestand.
- Reihenfolge: ORDER BY at, type unveraendert. Real liegt die
  Gegenzeichnung nach der Abnahme (eigene Transaktion, Guard
  handover_at NOT NULL per F7-07b); Gleichstand nur bei
  identischer Mikrosekunde — deterministisch, kein Umbau.

## Vertrag DB (0179 — 0178 ist F7-02k; nur Resolver-Replace)
- `CREATE OR REPLACE resolve_portal_public_view` (beide
  Ruempfe, Muster 0172-Z.13/468): CASE + IN-Liste je +
  `installation.handover_countersigned` / `handover_countersigned`.
- Keine Tabellen-/Spalten-/RLS-Aenderung; GRANT SELECT ON
  domain_events besteht (0097-Praezedenz); keine neue
  Permission, kein Backfill (alte Events erscheinen ehrlich).
- Journal-Pins: TOTAL 158 → 159, End-Eintrag idx 158 /
  Tag `0179_...` in beiden m111a-Dateien (upgrade + database).
- `db:generate` ohne Drift (reine SQL-Funktionsmigration,
  kein Drizzle-Schemawandel).

## Vertrag App
- Zod-Enum + `handover_countersigned`; Parser weiter strikt
  (Typ+at+day, keine Zusatz-Keys — f1003b-Objekt-Key-Pin gilt
  auch fuer die neue Zeile).
- Formatter-Vertrag: je Sprache „{Wort} {Joiner} {Tag}"
  (bestehende Joiner-Logik); DE exakt „Gegengezeichnet am …".
- Kein Name/Key/Notiz in Projektion, DTO oder UI (F7-07b-PII-
  Regel gilt portalweit; Event-Payload schon heute sauber).

## Sicherheit
- Keine neue Flaeche: read-only-Projektion eines bestehenden
  Events ueber Token-DEFINER wie bisher; Typ+Zeit+Tag nur
  (keine PII ueber Bestand hinaus — Kundenname und
  Unterschrift-PNG bleiben service-intern wie in F7-07b).
- Fail-closed wie 03b: SQL-IN filtert, Zod prueft strikt,
  entzogen/abgelaufen weiter `not_found` (unveraendert).

## Tests (RED zuerst)
- DB: `tests/db/f1016-gegenzeichnung-timeline.test.ts`
  (f1003b-Muster: Service-Seed + Invite + resolvePortalByToken) —
  F1016-DB-01 Anlegen → Abschliessen → Abnehmen →
  Gegenzeichnen (Service-Op `recordHandoverCountersignature`,
  Name+PNG wie f707b-DB) → Timeline-Typen exakt [created,
  completed, handover_recorded, handover_countersigned],
  Keys je Zeile exakt {at, day, type}, Tage sortiert;
  F1016-DB-02 ohne Gegenzeichnung weiter 3 Zeilen
  (03b-Regression), lead_installer_assigned weiter intern.
- Contract/Unit: F1016-CONTRACT-01 Enum parst 4. Typ,
  5. Typ invalid; Formatter alle 11 Sprachen (DE/EN exakt,
  Rest vorhanden, kein „other"-Fallback fuer den neuen Typ).
- E2E: `tests/e2e/f10-16-gegenzeichnung-timeline.spec.ts`
  (03b-Muster: UI-Anlage + Abschluss + Abnahme +
  Gegenzeichnung per 07b-UI + Invite, Portal ohne Login) —
  F1016-E2E-01 Timeline zeigt 4 Zeilen mit „Gegengezeichnet",
  kein Kundenname sichtbar; Axe.
- Nachbarn: f1003b (Timeline-Basis), f707b (Gegenzeichnung),
  Portal-Installation (F10-03/05/09/14/15) gruen.

## Akzeptanz
- `npm run check` gruen (inkl. db:roles:verify, Journal-Pins);
  E2E Chromium gruen; Heartbeat + Push + CI gruen.
