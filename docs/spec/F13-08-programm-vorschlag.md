# F13-08 Programm-Vorschlag (ESTIMATE, eigene Heuristik, Layout ESTIMATE)

Stand: IMPLEMENTIERT (Muse-Slice F13-08, Commit ea299de; Modulkatalog F13.2
Restpunkt „AI-Vorschlag“ als deterministische Regel-Heuristik — kein
LLM/Provider, keine neuen Rechte, keine Persistenz). Wie F13-03–F13-07:
kein Reonic-Referenzbeleg für die Vorschlag-Regeln; Regelwerk ist
reversible eigene Näherung (ESTIMATE, versioniert).

## 1. Umfang

- Reine Regel-Funktion `suggestSubsidyProgram` (`lib/subsidy-case.ts`,
  Client-/Server-teilbar, keine Imports): Signale → Vorschlag.
  - R-WP: `answeredFieldIds` enthält `waermepumpe` → `bafa`
    („Wärmepumpe im Rechner-Fragebogen angegeben“).
  - R-Bestand: Branch `existing_installation` → `bafa`
    (Sanierungskontext prüfen).
  - R-Neu: Branch `new_installation` → `kfw` (KfW-Programm prüfen).
  - Sonst: `no_basis` („keine auswertbaren Rechner-Angaben“), nie geraten.
  - Zusatzgründe aus `requestedProducts` (Wallbox-/Speicherwunsch).
  - Regelversion `f13-08-suggest.v1`, im UI ausgewiesen.
- Leseregel `getSubsidyProgramSuggestion` (`modules/subsidy-cases`):
  jüngster `calculator_snapshot` (Branch/Antworten/Produkte) plus jüngste
  `project_requirement` (Branch-/Produkt-Fallback). `installation.read`,
  keine neue Permission. Fehlform/Mandatsfremdheit fail-closed →
  `no_basis`. Keine Persistenz, kein Event, kein Audit (reine Lesehilfe).
- Projektakte (`anfragen/[projectId]`): Vorschlags-Block in der
  Förderakte — Vorschlagstext mit Gründen + Regelversion für alle Leser;
  „Vorschlag übernehmen“ nur mit Schreibrecht (bestehende
  `setSubsidyCaseDetailsAction`, BzA-Nummer bleibt erhalten).
  Leerzustand: „Kein Programm-Vorschlag: …“.

## 2. Tests

- DB (`tests/db/f1308-program-suggestion.test.ts`): WP-Signal → BAFA,
  Editor/Viewer-Gleichsicht, Fremdform fail-closed; ohne Signale
  `no_basis`, Snapshot-Branch-Vorrang + Anforderungs-Produkte,
  mandatsfremdes Projekt → `no_basis`.
- E2E (`tests/e2e/f13-08-program-suggestion.spec.ts`): Akte ohne Signale
  zeigt ehrlich keinen Vorschlag (kein Übernehmen-Button); mit
  WP-Snapshot Vorschlag BAFA mit Begründung + Regelversion; Übernehmen
  speichert sichtbar („Angaben gespeichert.“, Akte zeigt BAFA).

## 3. Abgrenzung

- KEINE Förderzusage, KEIN Ersatz für KfW/BAFA-Regelwerke.
- F13-Angebotsbindung bleibt offen (Q-F13-ANGEBOTSBINDUNG-M2):
  `offer.status` kennt nur `draft`, kein verbindlicher Zustand.
