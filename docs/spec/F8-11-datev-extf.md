# F8-11 — DATEV-EXTF Buchungsstapel (Katalog F8.6, „DATEV/Steuerberater" offen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12
Nachweis: Unit F811 5/5, DB F811 2/2, E2E F8-11-E2E-01 1/1 lokal beobachtet
(Download mit EXTF-Kennung + Belegnummer, Axe sauber, keine
Konsolenfehler); tsc/eslint/depcruise grün; keine Migration, keine neue
Permission, kein neuer Provider.
Basis: Blaupause 03-Integrationskarte („DATEV-EXTF-Export, CSV-Buchungsstapel,
SKR03/04 — ohne DATEV-Vertrag baubar, selbst bauen, früh") · Q-unblockiert
(kein Provider, kein Upload, keine neue Permission nötig).

## Ziel und Abgrenzung

Erster fehlender durchgängiger DATEV-Pfad: Aus allen im Monat ausgestellten
Geldbelegen (invoice/credit_note) einen DATEV-EXTF-Buchungsstapel als Download
anbieten (Berichte-Seite, Muster: Berichte-CSV-Route). Durchgängig: Builder
(rein, deterministisch) → Service (Read-Pfad, keine neue Permission) →
Route (Attachment wie CSV-Route) → Link auf der Berichte-Seite.

Nicht in diesem Slice: DATEV-Datenservices/Buchungsdatenservice (OAuth,
Marktplatz — Blaupause: später), 0-%-Zeilen/§13b (BU-Schlüssel-Entscheidung
braucht Steuerberater-Referenz), Fremdwährungen, Debitoren-OPOS, Kostenstellen,
Anlagenbuchhaltung, Festschreibung, E-Mail-Versand an den Steuerberater.

## Evidenz und ESTIMATE

- Katalogbedarf „DATEV/Steuerberater" aus Blaupause F8.6 + 03-Integrationskarte
  (öffentliche Programm-/Formatdokumentation, kein Reonic-Livebeleg für deren
  exaktes Profil).
- `[ESTIMATE]` EXTF-Subset als reversible Näherung: Vorspann
  (`EXTF;700;21;Buchungsstapel`, Sachkontenlänge 4, WKZ EUR, Zeitraum =
  Berichtsmonat), Spaltenköpfe, eine Buchungszeile je Beleg. Berater-/
  Mandantennummer bleiben leer (beim DATEV-Import zu setzen — ehrlicher
  UI-Hinweis an der Download-Stelle, keine erfundenen Nummern).
- `[ESTIMATE]` Kontenwahl SKR03/SKR04 per `skr`-Parameter (Default 03):
  Forderung an Erlös (19 % Automatikkonto, BU-Schlüssel leer):
  SKR03 `1400 → 8400`, SKR04 `1200 → 4400`. Gutschrift = Haben-Seite
  (SH-Kz `H`, positiver Betrag — DATEV-Konvention statt Minuszeichen).

## Validierung (fail-closed, ehrliche Fehler)

- Nur `status = 'issued'`, `type IN (invoice, credit_note)`, `currency = EUR`,
  Nummer nicht null, `issued_at` im Monat (Berlin).
- Nur 19-%-Zeilen (`tax_rate_bps = 1900` überall im Beleg); 0-%-Zeilen →
  Fehler mit Belegnummer (kein stiller Teil-Export, keine erfundenen BU-Schlüssel).
- Kopf-only-Belege (produkt-legal, issue verlangt keine Zeilen):
  `[ESTIMATE]` exakt-19-%-Kopf (`Steuer·100 == 19·Netto`, ganzzahlig)
  wird als EINE 19-%-Zeile aus Kopfbeträgen gebucht; jeder andere
  kopf-only-Beleg → Fehler mit Belegnummer.
- Summenkranz je Beleg wie CII: Σ Zeilen-Netto == Kopf-Netto,
  Σ Steuer == Kopf-Steuer, Brutto == Netto + Steuer (sonst Fehler).
- Leerer Monat → gültiger Stapel mit 0 Buchungen (kein Fehler, ehrlich leer).

## Ausgabe (deterministisch)

- CRLF, `;`-getrennt, deutsche Datumsform DDMM im Belegdatum (EXTF-Konvention),
  Beträge mit Punkt-Dezimal (2 Stellen, maschinenlesbar wie Berichte-CSV).
- Buchungstext: `<Rechnung|Gutschrift> <nummer>[ - <Kontaktname>]` (gekürzt,
  Formula-Injection-Guard wie Berichte-CSV; kontaktlose Belege tragen nur
  Typ + Nummer, Belegnummer bleibt eindeutig).
- Reihenfolge: Ausstellungsdatum aufsteigend, dann Beleg-ID.
- Dateiname `datev-buchungsstapel-<monat>-skr<03|04>.csv`,
  `text/csv; charset=utf-8`.

## Akzeptanz

- Unit: Vorspann/Spalten/SH-Kz/Konten je SKR, Gutschrift-Seite, Escaping,
  alle Reject-Pfade (0-%, krumme Summen, Fremdwährung), Determinismus,
  leerer Monat.
- DB: Stapel über echten ausgestellten Beleg (issued invoice aus
  F8-Fixture-Muster); Beleg mit 0-%-Zeile → Fehler.
- E2E: Berichte-Seite → DATEV-Link → Download enthält `EXTF` + Belegnummer;
  Axe sauber; keine Konsolenfehler.
- Gates: tsc/eslint/depcruise grün; keine Migration; keine neue
  Permission; kein neuer Provider.

## Bewusst offen

- 0-%-/§13b-Buchungen (BU-Schlüssel), Debitoren-OPOS/Kostenstellen,
  DATEV-Datenservices (OAuth), Monats-ZIP mit PDFs (kein Rechnungs-PDF),
  Versand an den Steuerberater.
