# F13-02 Netzanmeldung (NAB-Status je Projekt)

Ziel: Netzanschlussbegehren pro Projekt als nachvollziehbarer
Zustand — Vorbereitung → Einreichung → Genehmigung →
Fertigmeldung → Abschluss (+ Storno) — sichtbar in der Projektakte.
Ergänzt F13-01 Serviceauftrag (generische Vorgänge) um den
netzseitigen Pflichtpfad. Bauarbeit, kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `grid_registration` 1:1 je Projekt (UNIQUE, v1-Grenze —
  keine Wiederholungs-Historie), Statusmaschine im Service
  (fail-closed, nur legale Übergänge):
  `vorbereitung → eingereicht → genehmigt → fertiggemeldet →
  abgeschlossen`; `storniert` aus jedem nicht-abgeschlossenen
  Zustand; keine Rückübergänge (erneute Einreichung nach Storno =
  neuer Durchlauf per Statuswechsel storniert→vorbereitung? NEIN —
  v1: storniert ist terminal; dokumentierte Grenze).
  F13-12-UPDATE (2026-09-20, Migration 0261): Kette erweitert um
  `rueckfrage`-Loop (`eingereicht ↔ rueckfrage`) und `einspeisezusage`
  (zwischen `genehmigt` und `fertiggemeldet`); `storniert →
  vorbereitung` als Wiedereröffnung geöffnet (v1-Terminalität damit
  aufgehoben); `→ fertiggemeldet` mit Guards (Zählernummer + ≥16
  Fotos); Details-Sperre ab `eingereicht` (außer `rueckfrage`).
  Details: docs/spec/F13-12-netzanmeldung-vertiefung.md.
- Felder: Netzbetreiber (frei, optional), Zählernummer (frei,
  optional), submitted/decided/completed-Zeiten (gesetzt per
  Übergang, nie per Hand).
- Berechtigung: `installation.read`/`installation.write`
  (internalOnly, KEINE neuen Keys). Akte-Sektion nur interne Sicht
  (externe Detailansicht endet vorher).
- Kein Portal-Anteil, kein Upload (Zertifikate/Dokumente bewusst
  offen), keine Fristen-Automatik.

## Scopes
1. Migration 0103 (Tabelle, RLS tenant_isolation + FORCE, Rollen-
   vertrag wie 0094/F8-05) + `ensureGridRegistration` (idempotent
   je Projekt) / `transitionGridRegistration` / `getGridRegistration`.
2. Akte-Sektion: Status, Betreiber/Zähler pflegen, Aktions-Buttons
   je legalem Folgezustand, Verlauf als Ereignisliste (domain_events,
   IDs + Status only).
3. Leseregel ohne Worker (Status steht in DB, keine Ableitung).

## Geschlossene Testmatrix
- `F1302-DB-01`: Anlage idempotent, Happy-Path-Kette bis Abschluss.
- `F1302-DB-02`: illegale Übergänge fail-closed, Storno terminal,
  Zeitstempel je Übergang.
- `F1302-DB-03`: Validation (Betreiberlänge), NotFound ohne Orakel,
  Viewer-denied, Tenant-Isolation.
- `F1302-E2E-01`: Akte → anlegen → einreichen → genehmigen sichtbar.

## Bewusst offen
- MaStR-Meldung, tatsächliche Netzbetreiber-Integration, Dokumente,
  Fristen/Erinnerungen, Historie mehrerer Durchläufe, Portal-Sicht.
- F13-12-UPDATE (2026-09-20): Dokumente als Datei-Slot-Titelvorgaben
  (§3), Frist-Tracking ohne Automatismus (§4), Add-on-Vormerkung
  (§5) geschlossen — s. F13-12-Spec. Offen bleiben: echte
  MaStR-Meldung, Netzbetreiber-Integration, Fristen-Automatik,
  Mappen-Generator, IT/BR-Pfade.
