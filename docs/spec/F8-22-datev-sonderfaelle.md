# F8-22 — DATEV-Sonderfaelle (0-%-Faelle, §13b Reverse-Charge, Datenservices)

Folgeslice zu F8-11 (DATEV-EXTF Buchungsstapel, Track E aus STATUS.md offen:
„DATEV-0-%-/§13b-Faelle und -Datenservices"). F8-11 bucht nur den
19-%-Standardfall ueber das Automatikkonto (BU-Schluessel leer) und
verweigert jede 0-%-Zeile fail-closed mit Belegnummer (`datev-export.ts`
`checkBooking`, `F811-U-04`/`F811-DB-02`). Dieser Slice erweitert die
fail-closed-Matrix um echte 0-%-Buchungen: §12 Abs. 3 (zero_operator_confirmed,
Angebots-Praezedenz `offer_bom_line.tax_treatment`) und §13b Reverse-Charge
(PLAN.md-Steuerlogik) — plus die leseseitige Datenservice-Vorstufe.

## Ziel

Jeder ausgestellte Geldbeleg mit `tax_rate_bps IN (0, 1900)` erhaelt eine
explizite, gepruefte Steuerbehandlung und wird im EXTF-Stapel korrekt
verbucht (BU-Schluessel + Erloeskonto je Behandlung, SKR03/04). Unbekannte
oder gemischte Faelle ohne Ableitung bleiben fail-closed wie F8-11 (kein
stiller Teil-Export, kein erfundener Schluessel ohne ESTIMATE-Kennzeichnung).

## Umfang

- `tax_treatment` an `commercial_document_line` (Migration, DECIDED —
  Spiegel `offer_bom_line.tax_treatment`): `standard_19 | zero_12_3 |
  reverse_13b`, CHECK-Kopplung an `tax_rate_bps` (`1900` ↔ `standard_19`,
  `0` ↔ `zero_12_3`/`reverse_13b`); Bestand per Migration auf
  `standard_19`/`zero_12_3` ableiten (0-%-Bestand → `zero_12_3`,
  DECIDED — §13b war nie ausstellbar, also keine Fehlklassifikation).
- Builder-Matrix in `lib/integrations/invoicing/datev-export.ts` (rein,
  deterministisch): Behandlung → `{ buKey, revenueAccount }` je SKR als
  Konstantentabelle (ESTIMATE-Werte, Steuerberater-Referenz vor Pilot
  gemaess PLAN.md; `standard_19` unveraendert Automatikkonto, BU leer).
  Mischbelege: EINE Buchungszeile je Behandlungsgruppe (Split, bruto
  summengleich, deterministische Gruppenreihenfolge `standard_19`,
  `zero_12_3`, `reverse_13b`), Kopf-Summenkranz wie F8-11 je Gruppe +
  gesamt (DECIDED — gegen Reject: Mischbelege sind produkt-real).
- Service-Projektion in `modules/invoicing/datev-service.ts` (Read-Pfad,
  keine neue Permission): `tax_treatment` aus DB lesen, Kopf-only-
  Ableitung auf 0-%-Kopf erweitern (`tax == 0` + alle Zeilen fehlend →
  EINE `zero_12_3`-Gruppe, DECIDED); fehlende/inkonsistente Behandlung →
  `InvoicingValidationError` fail-closed mit Belegnummer.
- Datenservice-Vorstufe (DECIDED — leseseitig, kein OAuth/Marktplatz):
  `exportDatevBatch` liefert zusaetzlich `documents[]` (Belegnummer,
  Typ, Ausstelldatum, Brutto, Behandlungsgruppen) im Batch-DTO
  (`invoicing-datev-batch.v1` Minor-Erweiterung, abwaertskompatibel);
  maschinenlesbare Grundlage fuer den spaeteren Buchungsdatenservice.
- Contract-IDs: `invoicing-datev-command.v1` (unveraendert),
  `invoicing-datev-batch.v1` (+ `documents[]`), Builder-Funktionen
  `buildDatevBatchCsv`/`datevBatchFileName` (Signatur stabil, neue
  Eingabefelder `taxTreatment` je Zeile).

## Nicht-Umfang

- Kein DATEV-Upload/OAuth/Marktplatz (Buchungsdatenservice-Anbindung
  bleibt Folgeslice), kein Monats-ZIP mit PDFs, kein Versand an den
  Steuerberater, keine Festschreibung, keine Fremdwaehrungen, kein
  Debitoren-OPOS, keine Kostenstellen/Anlagen (wie F8-11 offen).
- Keine UI-Aenderung (Berichte-Links SKR03/04 unveraendert); Fehler
  surfen ueber die bestehende Route/Fehlerabbildung.

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F822-CT-01 | `zero_12_3`-Beleg bucht mit ESTIMATE-BU/Konto je SKR; `standard_19` unveraendert | Unit-Tests |
| F822-CT-02 | `reverse_13b`-Beleg bucht mit ESTIMATE-BU/Konto je SKR; Hinweis „Steuerschuldnerschaft des Leistungsempfaengers" im Buchungstext-Suffix | Unit-Tests |
| F822-CT-03 | Mischbeleg splittet je Behandlungsgruppe, summengleich, deterministische Reihenfolge; krumme Gruppen fail-closed | Unit-/Contract-Tests |
| F822-CT-04 | Fehlende/inkonsistente Behandlung, Fremdwaehrung, krummer Kopf verweigern mit Belegnummer (kein Teil-Stapel) | Unit-/DB-Tests |
| F822-CT-05 | Batch-DTO traegt `documents[]`; F8-11-Nachbarn (F811-U-*/DB-*) weiter gruen | DB-/Contract-Tests |
| F822-E2E-01 | Berichte-Seite → DATEV-Link → Download enthaelt `EXTF` + 0-%-Belegnummer; Axe sauber | E2E-Test |

## Offene Schaetzung (ESTIMATE)

- BU-Schluessel + Erloeskonten je Behandlung/SKR sind reversible
  Naeherung aus oeffentlicher DATEV-Dokumentation; finale Werte nur per
  Steuerberater-Review (PLAN.md-Gate vor Pilot), Konstantentabelle
  single-source im Builder.
- Buchungstext-Suffix §13b: ` - §13b` (60-Zeichen-Kappung greift zuerst).
- Berater-/Mandantennummer bleiben leer wie F8-11 (Import-seitig setzen).
