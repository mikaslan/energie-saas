# F9.4 Slice A — CSV-Export der Zeiteinträge (gefiltert)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02` (keine Migration).
Vorgänger: F9.1 (Einträge), F9.2 (Stoppuhr), F9.3 (Fremdnutzer-Filter Liste/Summe).
Katalog: F9.3-Rest „Excel/CSV-Export" (Modulkatalog M9). Dieser Slice: CSV;
Excel (XLSX) bleibt Nicht-Ziel (kein Live-Beleg für Formatdetails).

## Angewendete Skill-Regeln
- reonic-parity: Vertrag zuerst, TDD RED→IMPLEMENTED, keine erfundenen
  Formate (CSV RFC 4180, Semikolon-Trennung nach deutschem Excel-Brauch DECIDED).
- contract-first: Export-Parameter = List-Filter wiederverwenden
  (`projectId`, `userIds`), kein neuer Filterdialekt.
- database-migrations: KEINE Migration (reiner Lese-Pfad auf `time_entry`).
- product-lens: Warum — Monats-/Projekt-Abrechnung braucht einen
  mitnehmbaren Beleg; der Export folgt exakt dem angezeigten Filter
  (WYSIWYG-Prinzip: was die Liste zeigt, steht in der Datei).
- software-quality-gates/playwright-verify: volle Gate-Kette je Slice.

## Scope
1. Service `exportTimeEntries(tx, ctx, { projectId, userIds })` in
   `modules/time-tracking/service.ts`: wiederverwendet die
   F9.3-Filter-Semantik (leere userIds = alle; `sql.join`-IN-Liste,
   Lern-Register §2.5). Spalten: `datum;beginn;ende;minuten;pause_minuten;
   ereignistyp;kommentar;nutzer_id`. Zeiten in Europe/Berlin (DECIDED,
   Produkt-Heimat; `timestamptz`-Speicherung): Datum ISO (`YYYY-MM-DD`),
   Beginn/Ende `HH:MM`. Ereignistyp als Name (lesbar), leer ohne Typ.
   Nutzer als UUID (DECIDED: kein Identity-Join, keine zusätzliche
   RLS-Fläche; E-Mail steht nicht im Listendatensatz). Quoting nach
   RFC-4180-Regeln (Anführungszeichen verdoppeln) bei Semikolon-Trennung
   (deutscher Excel-Brauch, DECIDED), UTF-8 mit BOM (Excel-kompatibel),
   `\r\n`-Zeilenenden.
2. Route `GET /w/[workspaceId]/anfragen/[projectId]/zeiterfassung/export`
   nach Muster `rechnungen/berichte/csv/route.ts`: `authorizedQuery`
   mit `time.read` (Viewer darf exportieren — lesend, konsistent zur
   Listenansicht), `userId`-Query-Parameter (wiederholt, UUID-validiert,
   ungültig → 400), `Content-Disposition: attachment` mit Dateiname
   `zeiterfassung-<projectId8>-<yyyymmdd>.csv` (Datum Europe/Berlin),
   PRIVATE_HEADERS + CSP `sandbox; default-src 'none'`. Fehler-Mapping: 401/403 wie Muster,
   Service-Fehler (not_found → 404).
3. UI: Export-Link auf der Zeiterfassungsseite („CSV exportieren"),
   übernimmt den aktuellen Nutzerfilter (gleiche `userId`-Parameter).
   Sichtbar für alle mit Lesezugriff (auch Viewer).
4. Tests: (a) Vitest-DB: Filtertreue (alle / ein Nutzer / unbekannter
   Nutzer → nur Kopf), Quoting (Kommentar mit `;` und `"`), leere Liste,
   Kopfzeile exakt, Berlin-Datumsableitung; (b) E2E (eigenes f94-Projekt
   im W3-Seed, eigene Einträge — keine Cross-Spec-Abhängigkeit,
   f7-03-Lehre): zwei Einträge per UI, Download enthält beide Kommentare;
   mit Nutzerfilter nur einer. Playwright-`download`-Event + Dateiinhalt
   prüfen.

## Nicht-Ziele
- Kein XLSX, kein PDF-Export, keine E-Mail-Versendung des Exports.
- Keine Versionshistorie bei Edits (eigener Slice F9.4-B).
- Kein GPS (eigener Slice F9.4-C, braucht Geräte-/Consent-Konzept).
- Keine Team-Dashboards/Auslastung (eigener Slice F9.4-D).
- Keine Summenzeile in der Datei (Summe bleibt UI-Sache, F9.3).
- Keine Änderung an bestehenden Eintrags-/Filter-Pfaden.

## Akzeptanz
- `npm run check` grün (inkl. neuer DB-Tests), E2E-Spec grün (CI),
  beide Reviews (Exit-3 ohne Key: Selbstreview + Gates).
- Export einer leeren Liste liefert nur die Kopfzeile (200, kein 404).
- Unbefugte (ohne `time.read`) erhalten 401/403, nie Teildaten.
