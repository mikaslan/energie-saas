# F4-02c Lastgang-CSV (Commercial)

Stand: SPECIFIED (Codex-Slice F4.2c, Katalog F4.2: „Lastgang-CSV (nur
Commercial)"). Ergaenzt F4-02 (Monats-/Tagesgang) um eine belegte
Lastgang-Reihe aus einer CSV-Eingabe. Keine behauptete Reonic-Paritaet;
Naeherungen als ESTIMATE, REVIEW-pflichtig.

## 1. Eingabe

- `consumption.loadProfile == customer_csv.v1` + belegtes
  `consumption.customCsvKwh` (exakt 8.760 oder 35.040 endliche Zahlen ≥ 0,
  Summe > 0). Jede andere Kombination ist fail-closed (Option ohne Reihe,
  Reihe ohne Option, falsche Laenge, negative/nicht-numerische Werte,
  Summe 0).
- Erfassung: Textarea „Lastgang-CSV (eine Zahl pro Zeile, 8.760 Stunden-
  oder 35.040 Viertelstundenwerte, leer = kein CSV)". Ungueltig ->
  Formfehler, kein Speichern. Leer -> unknown (kein CSV-Block).
- Semantik: Stundenwerte = kWh je Stunde; Viertelstundenwerte = kWh je
  Slot. Dezimalpunkt oder -komma; Tausendertrennzeichen sind verboten
  (fail-closed statt geraten).

## 2. Formung (`buildCsvProfileSourceV2`, Quelle `wmee-customer-csv.v1`)

- 35.040 Werte -> direkt als Slotgewichte ( Summe = Jahres-kWh).
- 8.760 Werte -> gleichmaessig auf Viertel geviertelt (Stunde/4)
  [ESTIMATE: keine Intra-Stunden-Form angenommen].
- Provenienz: `sourceKind: basis` (genau eine Basis wie alle Formen),
  Detail `{ loadProfile: customer_csv.v1, granularity }`.

## 3. Kette und Anzeige

- Compose waehlt CSV-Basis nur bei Option + Reihe (sonst fail-closed wie
  Monatswerte). Keine Scope-Beschraenkung auf Gewerbe im Rechenkern
  (Profil-Select ist Wohn/Gewerbe-neutral; „nur Commercial" ist
  Reonic-Produktregel, keine Rechenannahme — REVIEW-offen).
- UI: kein eigener Block; CSV-Basis traegt `annual`/`monthly` wie jede
  Form (beobachtbar ueber Ergebnis + Sankey).

## Offene Fragen (REVIEW)

1. Reonic-CSV-Dialekt (Delimiter, Kopfzeile, Einheiten) per Beleg.
2. „Nur Commercial"-Regel als Produktlogik vs. offene Auswahl.
3. Intra-Stunden-Rekonstruktion statt uniformer Viertelung.
