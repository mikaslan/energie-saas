# F8-10 — E-Rechnung CII-Export (Katalog F8, „E-Rechnung" offen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12
Nachweis: Unit F810 5/5, DB F810 2/2, E2E F8-10-E2E-01 1/1 lokal beobachtet
(Download mit Belegnummer + CrossIndustryInvoice, Axe sauber, keine
Konsolenfehler); tsc/eslint/depcruise grün; keine Migration, keine neue
Permission, kein neuer Provider.
Basis: STATUS F8 („DATEV-/E-Rechnung und Versand" offen) · Q-unblockiert
(kein Upload/Versand nötig: Download-Route wie Berichte-CSV).

## Ziel und Abgrenzung

Erster fehlender durchgängiger F8-Pfad: Aus einem ausgestellten
Geldbeleg (invoice/credit_note) eine maschinenlesbare E-Rechnung als
CII-XML (EN16931-Syntax, BASIC-naher Subset) erzeugen und als Download
anbieten. Durchgängig: Builder (rein, deterministisch) → Service
(Read-Pfad, keine neue Permission) → Route (Attachment wie CSV-Route)
→ Button auf der Belegdetailseite.

Nicht in diesem Slice: DATEV-Export, E-Mail-Versand der E-Rechnung,
XRechnung-Validierung gegen amtliche Prüftools, Factur-X-PDF-Einbettung,
andere Belegtypen (quote/letter/deposit), Fremdwährungen, 0-%-Zeilen,
Skonto-Konditionen im XML (Skonto bleibt PDF-/Beleg-Sache).

## Evidenz und ESTIMATE

- Katalogbedarf „E-Rechnung" aus STATUS F8; CII-Syntax nach EN16931
  (öffentlicher Standard, kein Reonic-Livebeleg für deren exaktes
  Profil).
- `[ESTIMATE]` Profilwahl BASIC-nah (BT/BG-Kern: 380/381, S-Steuern,
  Summenkranz) als reversible Näherung; Konformitätsaussagen gegen
  amtliche Validatoren stehen aus und werden NICHT behauptet.
  Dateiname `erechnung-<nummer>.xml`, `application/xml`.

## Datenmodell (keine Migration)

Reine Projektion aus `getDocumentDetail` + `workspace_invoicing_settings`
+ `contact` (Käuferadresse). Keine neuen Tabellen/Spalten/Permissions
(`invoicing.read` für Export, `invoicing.write` nirgends nötig).

## Validierung (fail-closed, ehrliche Fehler)

- Nur `invoice` (TypeCode 380) und `credit_note` (381); andere Typen →
  `InvoicingValidationError` (kein stiller Fallback).
- Nur `currency == "EUR"`.
- Verkäufer: Name/Zeile1/PLZ/Ort/Land + `company_tax_id` Pflicht
  (BT-27–34/BT-31); Käufer: Name/Straße(+Nr)/PLZ/Ort/Land Pflicht
  (BT-44–55). Fehlt etwas → Fehler mit Feldbenennung (kein
  Leer-Export, keine Platzhalter).
- Nur Steuersatz > 0, Kategorie S; Summenkranz cent-exakt:
  Σ Zeilen-Netto == Kopf-Netto, Σ Steuer == Kopf-Steuer,
  Brutto == Netto + Steuer (sonst Fehler statt krummen XMLs).
- XML-Escaping für alle Freitexte (Name/Adresse/Positionstexte).

## Ausgabe (deterministisch)

- Feste Elementreihenfolge, 2-space-Indent, `<?xml version="1.0"
  encoding="UTF-8"?>`, Zeilen nach Position, Steuergruppen nach Satz.
- Mengen aus `quantityMilli`/1000 (3 Dezimalen), Beträge aus Cent/100
  (2 Dezimalen). Datum = `issued_at` ?? `created_at` (Datumsteil).
- Rechnungsdatum/Lieferdatum aus Beleg (`delivery_date` ?? Ausstelldatum).

## Akzeptanz

- Unit: Struktur/Namespaces/Typcodes, Escaping (`&<>"'`), Summenkranz,
  Steuersatz-Gruppierung, alle Reject-Pfade (Typ/Währung/Adresse/0-%/
  krumme Summen), Determinismus (zweimal rendern = byte-identisch).
- DB: Export über echten ausgestellten Beleg (issued invoice aus
  F8-Fixture-Muster); unvollständige Käuferadresse → Fehler.
- E2E: Button auf Belegdetail → Download enthält Belegnummer +
  `CrossIndustryInvoice`; Axe sauber; keine Konsolenfehler.
- Gates: tsc/eslint/depcruise grün; keine Migration; keine neue
  Permission; kein neuer Provider.

## Bewusst offen

- DATEV-Export, Versand, Factur-X-Einbettung, amtliche Validierung,
  weitere Belegtypen/Währungen/Steuerfälle, Skonto im XML.
