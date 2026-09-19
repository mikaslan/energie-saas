# FRAGEN AN MIKAIL — Lane codex/muse-fleet-2b-f9 (F9-EPIC)

Stand: 2026-09-19 06:46 UTC. Echte Blocker / Produktentscheidungen, die der
Lead nicht reversibel selbst entscheiden kann. Alles andere läuft weiter.
NIEMALS committen (lane-lokal, steht nicht im Repo-Verlauf).

## B1 — Subunternehmer-Abrechnung: Konzept fehlt (BLOCKIERT)

Blaupause F9.3 verlangt „Subunternehmer-Abrechnung". Belegter Stand: 0 Treffer
im gesamten Code für Subunternehmer/subcontractor/Stundensätze/Rates;
Abrechnung kennt nur Fest-Positionen (1..500, `lib/db/schema/invoicing.ts`).
Fragen: Wer ist Subunternehmer (Membership-Flag? eigene Tabelle)? Welche
Sätze (pro Person/Projekt/Typ)? Welche Rundung? Brücke Zeit→Rechnung?
Ohne diese Antworten ist kein paritätischer Slice spezifizierbar.
Option bei Nein: F9-EPIC ohne Subunternehmer schliessen (Abweichung im
FINAL-REPORT-2C dokumentieren).

## B2 — Excel-Export: Format oder Nicht-Ziel? (ENTSCHEIDUNG)

Blaupause F9.3 verlangt „Excel/CSV-Export". Belegter Stand: CSV gebaut
(`exportTimeEntries`, BOM, Injection-Guard, Route); XLSX 0 Treffer im Code.
Frühere Lane-Entscheidung: XLSX Nicht-Ziel ohne Live-Beleg. Fragen: Excel
bauen — in welchem Format (1 Blatt? Spalten?)? Oder Abweichung „nur CSV"
explizit absegnen? Ohne Antwort bleibt B2 auf Nicht-Ziel (FINAL-REPORT-2C
dokumentiert die Abweichung).
