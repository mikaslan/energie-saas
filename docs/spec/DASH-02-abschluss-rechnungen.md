# DASH-02 Abschluss- und Rechnungs-Kacheln (eigene Daten, Layout ESTIMATE)

Stand: IMPLEMENTIERT/LOKAL VERIFIZIERT (E2E DASH-01-Test deckt §3 ab: Abschlüsse- + Rechnungs-Leerzustände; Stand 2026-09-14 nachgezogen, kein Code-Eingriff). Wie DASH-01
gilt: kein Reonic-Referenzbeleg (Q-DASHBOARD-REFERENZ offen); Auswahl und
Layout sind reversible eigene Naeherung (ESTIMATE). Alle Zahlen stammen
aus verifizierten eigenen Lesemodellen.

## 1. Umfang

Erweiterung von `/w/[workspaceId]/dashboard` um zwei Karten
(jeweils permission-versteckt ohne Recht, nie Fehler):

- Abschluesse (Quelle `listClosedRequests`, `project.read`):
  Closed-Won-Anzahl, Conversion = won/(won+lost) (Strich bei 0/0),
  neueste 5 Abschluesse (Projekt, Ergebnis, Datum). Zaehlung per
  Cursor-Pagination, gedeckelt auf 10 Seiten (500); darueber „500+".
- Rechnungen (Quelle `getInvoicingReport` aktueller Berlin-Monat,
  `invoicing.read`): Einnahmen Monat, Ausstehend, Ueberfaellig
  (Cent→Euro, de-DE). Link zu Berichten.

## 2. Nichtziele (Folgeslices)

- Time-to-Offer/Time-to-Signature (Zeitstempel-Semantik erst verifizieren).
- Gewichtete Pipeline (Gewichte sind Reonic-Referenz, ESTIMATE-pflichtig).
- Charts (9 Charts aus dem Katalog), Excel/CSV-Export.

## 3. Tests

- E2E: leerer Workspace zeigt Null-/Leerzustaende beider Karten.
