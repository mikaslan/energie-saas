# Kimi-K3-Review: M3-01 A4 (M301-06 Liste/Filter + M301-07 Berichte/CSV)

Datum: 2026-09-04 · Quelle: OpenRouter `moonshotai/kimi-k3` (effort high)
via `scripts/kimi-review.mts` · Diff: 0046-Erweiterung + Contract + Service
+ Tests (A4-Slice auf Lane `codex/m3-01-invoicing-core`).

## Verdikt: FREIGABE (0 P0, 0 P1, 5 P2, 8 P3)

## P2 — geschlossen

1. **Rohe DB-Fehler statt ValidationError (Cursor/Datum)** → `decodeListCursor`
   validiert Zeitstempel- und UUID-Form vollständig; `isoDateOnlySchema`
   prüft jetzt echte Kalenderdaten (refine gegen UTC-Roundtrip). Tests:
   gefälschte Cursor (`garbage`/nicht-UUID), `2026-02-30`, `2025-02-29`.
2. **Grenzmonat 2000-01 bricht den Report** → `previousMonth.month` ist nicht
   mehr gegen die 20xx-Grenze geprüft (`1999-12` parsebar); Contract-Test
   für `month: "2000-01"`.
3. **LIKE-Escaping/CSV-Quoting ungetestet** → Tests: Suche `"PV%"`/`"PV_Anlage"`
   trifft nichts (Wildcards literal); M301-CSV-03 mit `"`-Verdopplung,
   Zeilenumbruch im Feld und Formula-Guard in eigenem Workspace.
4. **CSV-Dezimaltrenner** → DECIDED im Code: Punkt (`119.00`), parse-sicher;
   Komma wäre reines Anzeige-Layer.
5. **CSV-Formula-Injection** → `csvCell` neutralisiert führende `= + - @`
   mit `'`-Präfix.

## P3 — geschlossen/dokumentiert

1. Negative Bucket-Tage bei widersprüchlichen Daten → DECIDED-Kommentar.
2. Leerer Folgerequest bei exakt voller letzter Seite → Standard-Keyset, ok.
3. `setPaymentStatus` verschiebt `payment_updated_at` → DECIDED-Kommentar
   (Cashflow-Proxi zählt erneut; ESTIMATE-Vertrag).
4. Cashflow enthält später stornierte Dokumente → DECIDED-Kommentar
   (Zahlungseingang real, Stornierung = getrennte Gutschrift).
5. „Partition"-Wortlaut irreführend → Kommentar präzisiert (keine vollständige
   Partition, uncollectable heraus).
6. `toIso`-Regex deckte Offsets mit Doppelpunkt nicht → Regex erweitert
   (`[+-]\d{2}(?::?\d{2})?`).
7. KPI-Summen gegen Einzeldokument-Maximum geparst → theoretisch bei
   Milliarden-Dokumenten; akzeptiert (moneyCents-Obergrenze ist je Feld).
8. Archiv-Achse filtert in KPIs nicht → DECIDED-Kommentar (wirtschaftlich
   wirksam; Liste filtert, Bericht aggregiert; Reonic-Semantik UNKNOWN).
