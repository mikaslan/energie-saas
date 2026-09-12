# F8-07 Zahlungsplan-Modus (Scheme 30/40/30) für Teilrechnungen

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12

Ziel: Dritter Katalog-Modus aus F8.5 (Modulkatalog M8: „Percentage /
Scheme 30-40-30 / Remaining") neben F8-05 (`percent`/`lines`).
Ein Aufruf je Tranche: 30 %, 40 %, Rest (nominell 30 %, cent-exakt).

## ESTIMATE (reversibel, Referenzfrage offen)

- Plan: `SCHEME_TRANCHES_BPS = [3000, 4000, 3000]`
  (`COMMERCIAL_DOCUMENT_SCHEME_VERSION = "commercial-document-scheme.v1"`).
  Reonic belegt nur den Namen „30-40-30"; Tranchen als feste Staffel.
- Tranche n folgt aus der Ketten-Ordinalzahl (aktive Teilrechnungen + 1);
  Ordinal > 3 → `Conflict` (Plan erschöpft).
- Tranchenindex = aktive Scheme-Tranchen + 1 (andere Modi zählen
  nicht); Index > 3 → `Conflict` (Plan erschöpft). Keine neue
  Restriktion für `percent`/`lines` (verifizierte Pfade unverändert).
- Letzte Tranche = Rest (AB-Netto − Netto der aktiven Scheme-Tranchen),
  damit die Staffel cent-exakt aufgeht; nominell 30 % in `percent_bps`
  für die Anzeige. Rest ≤ 0 → `Conflict`. Mischketten bleiben über
  das globale Brutto-Cap fail-closed.
- Gleiche v1-Grenze wie `percent`: nur EINHEITLICHER Steuersatz aller
  AB-Positionen (Mischsätze fail-closed), eine Sammellinie.
- Cap, Storno-Budget, AB-Zeilensperre, Event/Audit-Form wie F8-05.

## Scopes

1. Migration 0121 (mode-CHECK + percent-CHECK um `'scheme'`, kein neues
   Grant, RLS unverändert) + Schema-`$type`.
2. Contract: `mode`-Enum + Refine, Scheme-Versionskonstante.
3. Service: Scheme-Zweig, `listPartialInvoices`-Durchreichung (kein
   percent-Fallback mehr), Modus-Typen.
4. AB-Detail: dritter Radio-Modus ohne Prozent-Input, Anzeige
   „Zahlungsplan X %", Konflikttext unverändert.
5. Action-Allowlist + `scheme`.

## Geschlossene Testmatrix

- `F807-DB-01`: volle Staffel (30/40/Rest) — Netto-Summe == AB-Netto,
  Ordinale 1–3, 4. Aufruf → Conflict.
- `F807-DB-02`: Mischkette (percent 50 % zuerst → scheme Tranche 1 =
  30 %, Rest-Tranche cent-exakt), Mischsatz fail-closed, Viewer-denied.
- `F807-E2E-01`: AB → Scheme-Tranche 1 → Kette mit „Zahlungsplan 30 %".

## Bewusst offen

- Frei konfigurierbare Staffeln, Skonto je Teilrechnung, Portal-Sicht,
  automatische Schlussrechnung aus Rest (wie F8-05).
