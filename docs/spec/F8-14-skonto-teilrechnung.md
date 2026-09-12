# F8-14 Skonto je Teilrechnung (eigene Kind-Kondition, Katalog F8.5)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F814 2/2, E2E F814-E2E-01 1/1, F8-Nachbarn 9 Files/20 Tests, tsc/eslint/depcruise grün, lokal beobachtet; kein Push während CI läuft).

Ziel: Die in F8-05/F8-07/F8-08/F8-12/F8-13-Specs als „Bewusst offen:
Skonto je Teilrechnung“ geführte Lücke schließen. Jede Teilrechnung
trägt ihre EIGENE Skonto-Kondition (Kind), unabhängig von der AB und
von Geschwistern; die Kette zeigt sie je Kind an.

## ESTIMATE (reversibel, Referenzfrage offen)

- KEIN Skonto-Copy bei Anlage (wie F8-05/06/07/08/12/13): neues Kind
  startet mit `skonto_percent_bps/days = null` („Kein Skonto“).
- Setzen weiter über `setDocumentTerms` (F5-01, Contract unverändert):
  nur `type = invoice` + `status = draft`, Prozent+Tage gemeinsam oder
  beide null (Refine), 0..10000 bps / 0..365 Tage (CHECK 0082);
  ab Ausstellung friert der M301-Guard ein (`Conflict`).
- AB (`order_confirmation`) nimmt keine Kondition an: `setDocumentTerms`
  dort → `Validation` (Typ-Gate, fail-closed).
- Lesepfad: `PartialChainEntry` + `skontoPercentBps/skontoDays`
  (direkt aus der Kind-Zeile, kein Join über Eltern); Panel zeigt je
  Kind „· Skonto X %/Y T“, null → keine Anzeige.
- Berechtigung: `invoicing.read`/`invoicing.write` (KEINE neuen Keys).
  Events/Audit nur IDs + Kondition. Keine Migration, kein Provider.

## Scopes

1. Service-Lesepfad: `listPartialInvoices` liest
   `invoice.skonto_percent_bps/days` je Kind (Typ + Mapping).
2. AB-Detail: Kettenliste mit Skonto-Badge je Kind (read-only).
3. Belegdetail/Liste unverändert (F5-01/F5-02 zeigen Skonto bereits).

## Geschlossene Testmatrix

- `F814-DB-01`: Prozent-Kette (2×30 %) → Kind 1 Skonto 200 bps/14 T
  (Kette zeigt sie, Kind 2 null, AB null); Ausstellung Kind 1 →
  Kondition erhalten + eingefroren (Re-Set → `Conflict`).
- `F814-DB-02`: Skonto auf AB → `Validation`; halb gesetzte
  Kondition (nur Prozent) → `Validation`; Viewer-denied.
- `F814-E2E-01`: AB → Prozent-Teilrechnung (30 %) → Skonto-Dialog
  in der Rechnungsliste am Kind (2 %/14 Tage) → AB-Kette zeigt
  „Skonto 2 %/14 T“, Kind-Detail zeigt „2 % innerhalb von 14 Tagen“.

## Bewusst offen

- Portal-Sicht, Staffel-Beträge (Scheme mit Euro statt Prozent),
  Skonto-Tage ab Ausstellung neu zählen.
