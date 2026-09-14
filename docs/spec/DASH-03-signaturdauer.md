# DASH-03 Unterschriftsdauer (eigene Daten, Layout ESTIMATE)

Stand: IMPLEMENTIERT/LOKAL VERIFIZIERT (E2E DASH-01-Test: Leadtime-Leerzustand „Noch keine Unterschriften."; Stand 2026-09-14 nachgezogen, kein Code-Eingriff). Wie DASH-01/02: kein
Reonic-Referenzbeleg (Q-DASHBOARD-REFERENZ offen); Kennzahl und Layout
sind reversible eigene Naeherung (ESTIMATE).

## 1. Umfang

- Neue Leseregel `getSignatureLeadTimeStats` (`modules/signatures`):
  Median (`signed_at - created_at`) in Tagen ueber signierte Vorgaenge
  des Workspaces (neueste zuerst, Limit 500, ehrliches „+"); keine neue
  Permission (`offer.signature.read`, viewer+, internal).
- Dashboard-Karte „Unterschriftsdauer": Median in Tagen (Strich ohne
  Signierte), Anzahl signierter Vorgaenge; permission-versteckt ohne
  Recht.

## 2. Nichtziele

- Time-to-Offer (Angebots-Zeitstempel-Semantik erst verifizieren).
- Gewichtete Pipeline, Charts, Export (Folgeslices).
